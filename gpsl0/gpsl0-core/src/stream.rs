//! Zero-allocation `#![no_std]` streaming encoder for GPSL0 v3 (`version = 2`, `model_id = 22`).
//!
//! Designed so constrained targets (e.g. Cortex-M4F / nRF52840 with no heap allocator)
//! can compress multi-block GPS tracks directly to a `ByteSink` using ~60.5 KiB of fixed RAM
//! (packed `u16` `(count << 12) | prob` probability cells), while desktop / WebAssembly callers
//! allocate only the active slot slice (`3,219` slots for `q <= 10`, `30,805` slots for `q > 10`)
//! on the heap and share the exact same bit-exact encoder path.

#[cfg(feature = "alloc")]
use alloc::{vec, vec::Vec};
use core::convert::Infallible;

use crate::container::{
    write_svarint_to_sink, ByteSink, Crc32Hasher, Gpsl0BlockEntry, Gpsl0HeaderV2,
};
#[cfg(feature = "alloc")]
use crate::container::{write_v2_header_and_index, HEADER_SIZE_V2};
#[cfg(feature = "alloc")]
use crate::error::Gpsl0Error;
use crate::error::StreamError;
use crate::pred::{
    accel_bucket3, accel_growing, agree_bit, dt_bucket, gcd_u64, mag3, mag4, mag6,
    predict_coord_v1, round_div, round_div_half_up_pos, run_bucket4, vel_step_bucket, vmag_bucket,
    AltMode, CoordMode,
};
use crate::rangecoder::{RangeEncoderV2Core, SlotKind, PACKED_INIT_V3, RC_V2_FROZEN};

pub const V3_MODEL_ID: u32 = 22;
pub const V3_Q10_SLOTS: usize = 3219;
pub const V3_TOTAL_SLOTS: usize = 30805;

const UNARY_SLOTS: usize = 24;
const MAG_SLOTS: usize = 59;
const M1_SLOT: usize = 24;
const TREE_BASE: usize = 25;
const TREE_BITS: usize = 4;
const FLAT_BASE: usize = 40;

#[derive(Clone, Copy)]
struct StreamLayout {
    grid: bool,
    all_zero_base: usize,
    zero_dt_base: usize,
    zero_lat_base: usize,
    zero_lon_base: usize,
    zero_alt_base: usize,
    mag_dt_base: usize,
    mag_lat_base: usize,
    mag_lon_base: usize,
    mag_alt_base: usize,
    sign_dt_base: usize,
    sign_lat_base: usize,
    sign_lon_base: usize,
    sign_alt_base: usize,
    total_slots: usize,
}

const LAYOUT_Q10: StreamLayout = StreamLayout {
    grid: false,
    all_zero_base: 0,
    zero_dt_base: 16,
    zero_lat_base: 26,
    zero_lon_base: 58,
    zero_alt_base: 90,
    mag_dt_base: 108,
    mag_lat_base: 698,
    mag_lon_base: 1406,
    mag_alt_base: 2822,
    sign_dt_base: 3176,
    sign_lat_base: 3180,
    sign_lon_base: 3193,
    sign_alt_base: 3206,
    total_slots: V3_Q10_SLOTS,
};

const LAYOUT_GRID: StreamLayout = StreamLayout {
    grid: true,
    all_zero_base: 0,
    zero_dt_base: 16,
    zero_lat_base: 26,
    zero_lon_base: 506,
    zero_alt_base: 986,
    mag_dt_base: 1004,
    mag_lat_base: 1594,
    mag_lon_base: 15754,
    mag_alt_base: 29914,
    sign_dt_base: 30268,
    sign_lat_base: 30272,
    sign_lon_base: 30532,
    sign_alt_base: 30792,
    total_slots: V3_TOTAL_SLOTS,
};

#[inline]
const fn layout_for(coord_quantum: u32) -> &'static StreamLayout {
    if coord_quantum > 10 {
        &LAYOUT_GRID
    } else {
        &LAYOUT_Q10
    }
}

/// First-pass zero-allocation scanner that infers exact natural coordinate/altitude quantums
/// and whether a track qualifies for the sparse/small `D1` predictor trial.
#[derive(Debug, Clone, Copy)]
pub struct QuantumScanner {
    g_lat: u64,
    g_lon: u64,
    g_alt: u64,
    n_points: u32,
    first_t: i32,
    last_t: i32,
    has_first: bool,
}

impl QuantumScanner {
    #[inline]
    pub const fn new() -> Self {
        Self {
            g_lat: 0,
            g_lon: 0,
            g_alt: 0,
            n_points: 0,
            first_t: 0,
            last_t: 0,
            has_first: false,
        }
    }

    #[inline]
    pub fn push_point(&mut self, t: i32, lat: i32, lon: i32, alt: i32) {
        if !self.has_first {
            self.first_t = t;
            self.has_first = true;
        }
        self.last_t = t;
        self.n_points = self.n_points.saturating_add(1);
        if self.g_lat != 1 {
            self.g_lat = gcd_u64(self.g_lat, (lat as i64).unsigned_abs());
        }
        if self.g_lon != 1 {
            self.g_lon = gcd_u64(self.g_lon, (lon as i64).unsigned_abs());
        }
        if self.g_alt != 1 {
            self.g_alt = gcd_u64(self.g_alt, (alt as i64).unsigned_abs());
        }
    }

    #[inline]
    pub const fn n_points(&self) -> u32 {
        self.n_points
    }

    #[inline]
    pub fn coord_quantum(&self) -> u32 {
        let glat = if self.g_lat == 0 {
            10_000_000
        } else {
            gcd_u64(self.g_lat, 10_000_000).max(1)
        };
        let glon = if self.g_lon == 0 {
            10_000_000
        } else {
            gcd_u64(self.g_lon, 10_000_000).max(1)
        };
        gcd_u64(glat, glon).max(1) as u32
    }

    #[inline]
    pub fn alt_quantum(&self) -> u32 {
        if self.g_alt == 0 {
            10
        } else {
            gcd_u64(self.g_alt, 10).max(1) as u32
        }
    }

    #[inline]
    pub fn should_try_d1(&self) -> bool {
        if !self.has_first || self.n_points < 3 {
            return false;
        }
        let dur = (self.last_t as i64).saturating_sub(self.first_t as i64).max(0);
        self.n_points <= 4096 || dur >= (self.n_points as i64).saturating_mul(3)
    }
}

impl Default for QuantumScanner {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamV3Options {
    pub coord_quantum: u32,
    pub coord_exact: bool,
    pub alt_quantum: u32,
    pub alt_exact: bool,
    pub block_points: u32,
    pub sync_blocks: u32,
    pub coord_mode: CoordMode,
    pub alt_mode: AltMode,
}

impl Default for StreamV3Options {
    fn default() -> Self {
        Self {
            coord_quantum: 100,
            coord_exact: false,
            alt_quantum: 10,
            alt_exact: false,
            block_points: 32768,
            sync_blocks: 0,
            coord_mode: CoordMode::TnClamped,
            alt_mode: AltMode::D1,
        }
    }
}

impl StreamV3Options {
    #[inline]
    pub fn from_scan(scan: &QuantumScanner) -> Self {
        Self {
            coord_quantum: scan.coord_quantum(),
            coord_exact: true,
            alt_quantum: 10,
            alt_exact: false,
            block_points: 32768,
            sync_blocks: 0,
            coord_mode: CoordMode::TnClamped,
            alt_mode: AltMode::D1,
        }
    }

    #[inline]
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.coord_quantum < 1
            || self.coord_quantum > 10_000_000
            || 10_000_000 % self.coord_quantum != 0
        {
            return Err("bad coord_quantum");
        }
        if self.alt_quantum < 1 || 10 % self.alt_quantum != 0 {
            return Err("bad alt_quantum");
        }
        if self.block_points < 2 || self.block_points > (1 << 20) {
            return Err("bad block_points");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct AxisState {
    x_prev2: i32,
    x_prev: i32,
    x_hat_q8: i64,
    v_hat_q8: i64,
    v_prev: i32,
    v_prev2: i32,
    e_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
}

impl AxisState {
    const fn empty() -> Self {
        Self {
            x_prev2: 0,
            x_prev: 0,
            x_hat_q8: 0,
            v_hat_q8: 0,
            v_prev: 0,
            v_prev2: 0,
            e_prev: 0,
            last_nz_sign: 0,
            last_nz_is1: false,
            zero_gap: 2,
        }
    }

    #[inline]
    fn from_pair(x0: i32, x1: i32, dt0: i32) -> Self {
        let v0 = x1.wrapping_sub(x0);
        let v_init_q8 = if dt0 > 0 {
            ((v0 as i64) << 8) / (dt0 as i64)
        } else {
            0
        };
        Self {
            x_prev2: x0,
            x_prev: x1,
            x_hat_q8: (x1 as i64) << 8,
            v_hat_q8: v_init_q8,
            v_prev: v0,
            v_prev2: v0,
            e_prev: 0,
            last_nz_sign: 0,
            last_nz_is1: false,
            zero_gap: 2,
        }
    }

    #[inline]
    fn update_residual_mem(&mut self, e: i32) {
        self.e_prev = e;
        if e != 0 {
            self.last_nz_sign = if e < 0 { -1 } else { 1 };
            self.last_nz_is1 = e.unsigned_abs() == 1;
            self.zero_gap = 0;
        } else {
            self.zero_gap = self.zero_gap.saturating_add(1).min(2);
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TrackState {
    t_prev: i32,
    dt_prev: i32,
    dt_prev2: i32,
    dt_prev3: i32,
    dt_base: i32,
    lat: AxisState,
    lon: AxisState,
    alt: AxisState,
    e_dt_prev: i32,
    zero_run: u32,
}

impl TrackState {
    const fn empty() -> Self {
        Self {
            t_prev: 0,
            dt_prev: 0,
            dt_prev2: 0,
            dt_prev3: 0,
            dt_base: 0,
            lat: AxisState::empty(),
            lon: AxisState::empty(),
            alt: AxisState::empty(),
            e_dt_prev: 0,
            zero_run: 0,
        }
    }
}

struct BlockByteSink<'a, S> {
    inner: &'a mut S,
    crc: &'a mut Crc32Hasher,
    len: &'a mut u32,
}

impl<S: ByteSink> ByteSink for BlockByteSink<'_, S> {
    type Error = S::Error;

    #[inline]
    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error> {
        self.inner.write_byte(byte)?;
        self.crc.update_byte(byte);
        *self.len = (*self.len).wrapping_add(1);
        Ok(())
    }

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.inner.write_all(bytes)?;
        self.crc.update(bytes);
        *self.len = (*self.len).wrapping_add(bytes.len() as u32);
        Ok(())
    }
}

#[inline]
fn quantize_coord_scalar(val: i32, q: u32, exact: bool) -> Result<i32, &'static str> {
    if q == 1 {
        return Ok(val);
    }
    if exact {
        let qq = q as i64;
        if (val as i64) % qq != 0 {
            return Err("coordinate value is not a multiple of coord_quantum");
        }
        Ok(((val as i64) / qq) as i32)
    } else {
        Ok(round_div_half_up_pos(val, q))
    }
}

#[inline]
fn quantize_alt_scalar(val: i32, q: u32, exact: bool) -> Result<i32, &'static str> {
    if q == 1 {
        return Ok(val);
    }
    if exact {
        let qq = q as i64;
        if (val as i64) % qq != 0 {
            return Err("altitude value is not a multiple of alt_quantum");
        }
        Ok(((val as i64) / qq) as i32)
    } else {
        Ok(round_div_half_up_pos(val, q))
    }
}

#[inline]
fn predict_coord_stream(
    st: &AxisState,
    dt_prev: i32,
    dt_cur: i32,
    cq: i64,
    mode: CoordMode,
) -> i64 {
    match mode {
        CoordMode::D1 => st.x_prev as i64,
        CoordMode::Tn => predict_coord_v1(st.x_prev2, st.x_prev, dt_prev, dt_cur, CoordMode::Tn as u8),
        CoordMode::Naive => {
            predict_coord_v1(st.x_prev2, st.x_prev, dt_prev, dt_cur, CoordMode::Naive as u8)
        }
        CoordMode::TnClamped => {
            if cq <= 10 {
                let v1 = st.x_prev.wrapping_sub(st.x_prev2) as i64;
                let v2 = st.v_prev2 as i64;
                let phys_v1 = v1.abs() * cq;
                if (v2 == 0 && phys_v1 <= 120) || (v1 * v2 < 0 && phys_v1 <= 150) {
                    return st.x_prev as i64;
                }
            }
            predict_coord_v1(
                st.x_prev2,
                st.x_prev,
                dt_prev,
                dt_cur,
                CoordMode::TnClamped as u8,
            )
        }
    }
}

#[inline]
fn update_coord_stream(st: &mut AxisState, x_cur: i32, e_cur: i32) {
    let v_true = x_cur.wrapping_sub(st.x_prev);
    st.v_prev2 = st.x_prev.wrapping_sub(st.x_prev2);
    st.x_prev2 = st.x_prev;
    st.x_prev = x_cur;
    st.v_prev = v_true;
    st.update_residual_mem(e_cur);
}

#[inline]
fn predict_alt_stream(st: &AxisState, dt_prev: i32, dt_cur: i32, mode: AltMode) -> i64 {
    match mode {
        AltMode::D1 => st.x_prev as i64,
        AltMode::Damped => {
            let dt_eff = if dt_cur > 0 {
                (dt_cur as i64).min((dt_prev.max(1) as i64) * 2)
            } else {
                0
            };
            let xp_q8 = st.x_hat_q8 + st.v_hat_q8 * dt_eff;
            round_div(xp_q8, 256)
        }
    }
}

#[inline]
fn update_alt_stream(
    st: &mut AxisState,
    alt_cur: i32,
    dt_prev: i32,
    dt_cur: i32,
    e_cur: i32,
    mode: AltMode,
) {
    let va_true = (alt_cur as i64) - (st.x_prev as i64);
    if mode == AltMode::Damped {
        if dt_cur <= 0 || dt_cur > dt_prev.max(1) * 4 {
            st.x_hat_q8 = (alt_cur as i64) << 8;
            st.v_hat_q8 = 0;
        } else {
            let dt_eff = (dt_cur as i64).min((dt_prev.max(1) as i64) * 2);
            let dt_real = dt_cur.max(1) as i64;
            let xp_q8 = st.x_hat_q8 + st.v_hat_q8 * dt_eff;
            let r_q8 = ((alt_cur as i64) << 8) - xp_q8;
            st.x_hat_q8 = xp_q8 + round_div(230 * r_q8, 256);
            st.v_hat_q8 += if dt_real == 1 {
                round_div(77 * r_q8, 256)
            } else {
                round_div(77 * r_q8, 256 * dt_real)
            };
        }
    }
    st.v_prev2 = st.x_prev.wrapping_sub(st.x_prev2);
    st.x_prev2 = st.x_prev;
    st.x_prev = alt_cur;
    st.v_prev = va_true as i32;
    st.update_residual_mem(e_cur);
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn sign_slot_and_bit_v3(
    sign_base: usize,
    is_dt: bool,
    grid_coord: bool,
    pred_dt: i32,
    e: i32,
    u: u32,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
) -> (usize, u8) {
    let is_neg = e < 0;
    if is_dt {
        let idx = sign_base + usize::from(pred_dt <= 1) * 2 + usize::from(e_prev > 0);
        return (idx, u8::from(is_neg));
    }
    let cur_is_1 = usize::from(u == 1);
    let base13 = if last_nz_sign != 0 {
        let gap = (zero_gap as usize).min(2);
        (gap * 2 + usize::from(last_nz_is1)) * 2 + cur_is_1
    } else {
        12
    };
    let off = if grid_coord {
        (base13 * 4 + mag4(e_prev)) * 5 + vmag_bucket(v_prev)
    } else {
        base13
    };
    let bit = if last_nz_sign != 0 {
        u8::from(is_neg != (last_nz_sign < 0))
    } else {
        u8::from(is_neg)
    };
    (sign_base + off, bit)
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn encode_residual_stream<S: ByteSink>(
    rc: &mut RangeEncoderV2Core,
    sink: &mut BlockByteSink<'_, S>,
    cells: &mut [u16],
    zero_idx: usize,
    zero_kind: SlotKind,
    mag_base: usize,
    sign_base: usize,
    is_dt: bool,
    grid_coord: bool,
    pred_dt: i32,
    e: i32,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
    force_nonzero: bool,
) -> Result<(), StreamError<S::Error>> {
    if e == 0 {
        if !force_nonzero {
            rc.encode_bit_packed(sink, cells, zero_idx, 0, zero_kind)?;
        }
        return Ok(());
    }
    if !force_nonzero {
        rc.encode_bit_packed(sink, cells, zero_idx, 1, zero_kind)?;
    }

    let u = e.unsigned_abs();
    let m = (31 - u.leading_zeros()) as usize;
    if m >= UNARY_SLOTS {
        for t in 0..UNARY_SLOTS {
            rc.encode_bit_packed(sink, cells, mag_base + t, 1, SlotKind::MagSign)?;
        }
        for k in (0..32).rev() {
            rc.encode_direct(sink, ((u >> k) & 1) as u8)
                .map_err(StreamError::Sink)?;
        }
    } else {
        for t in 0..m {
            rc.encode_bit_packed(sink, cells, mag_base + t, 1, SlotKind::MagSign)?;
        }
        rc.encode_bit_packed(sink, cells, mag_base + m, 0, SlotKind::MagSign)?;

        if m == 1 {
            let bit = (u & 1) as u8;
            rc.encode_bit_packed(sink, cells, mag_base + M1_SLOT, bit, SlotKind::MagSign)?;
        } else {
            let mut prefix = 0usize;
            for step in 0..m {
                let k = m - 1 - step;
                let bit = ((u >> k) & 1) as u8;
                if step < TREE_BITS {
                    let node = TREE_BASE + ((1usize << step) - 1) + prefix;
                    rc.encode_bit_packed(sink, cells, mag_base + node, bit, SlotKind::MagSign)?;
                    prefix = (prefix << 1) | (bit as usize);
                } else {
                    rc.encode_bit_packed(
                        sink,
                        cells,
                        mag_base + FLAT_BASE + (step - TREE_BITS),
                        bit,
                        SlotKind::MagSign,
                    )?;
                }
            }
        }
    }

    let (sign_slot, sign_bit) = sign_slot_and_bit_v3(
        sign_base,
        is_dt,
        grid_coord,
        pred_dt,
        e,
        u,
        e_prev,
        v_prev,
        last_nz_sign,
        last_nz_is1,
        zero_gap,
    );
    rc.encode_bit_packed(sink, cells, sign_slot, sign_bit, SlotKind::MagSign)?;
    Ok(())
}

struct StreamCoreV3 {
    rc: RangeEncoderV2Core,
    opts: StreamV3Options,
    state: TrackState,
    seed0_t: i32,
    seed0_lat: i32,
    seed0_lon: i32,
    seed0_alt: i32,
    block_idx: u32,
    block_pos: u32,
    total_points: u32,
    block_start_ts: u32,
    block_end_ts: u32,
    block_crc: Crc32Hasher,
    block_byte_len: u32,
    payload_offset: u32,
    in_sync_block: bool,
    configured: bool,
}

impl StreamCoreV3 {
    const fn new_unconfigured() -> Self {
        Self {
            rc: RangeEncoderV2Core::new(RC_V2_FROZEN),
            opts: StreamV3Options {
                coord_quantum: 100,
                coord_exact: false,
                alt_quantum: 10,
                alt_exact: false,
                block_points: 32768,
                sync_blocks: 0,
                coord_mode: CoordMode::TnClamped,
                alt_mode: AltMode::D1,
            },
            state: TrackState::empty(),
            seed0_t: 0,
            seed0_lat: 0,
            seed0_lon: 0,
            seed0_alt: 0,
            block_idx: 0,
            block_pos: 0,
            total_points: 0,
            block_start_ts: 0,
            block_end_ts: 0,
            block_crc: Crc32Hasher::new(),
            block_byte_len: 0,
            payload_offset: 0,
            in_sync_block: false,
            configured: false,
        }
    }

    fn reset(
        &mut self,
        opts: StreamV3Options,
        cells: Option<&mut [u16]>,
    ) -> Result<(), StreamError<Infallible>> {
        opts.validate().map_err(StreamError::InvalidInput)?;
        if let Some(c) = cells {
            let active = layout_for(opts.coord_quantum).total_slots;
            if c.len() < active {
                return Err(StreamError::InvalidInput("cell buffer too small"));
            }
            c[..active].fill(PACKED_INIT_V3);
        }
        self.rc.reset();
        self.opts = opts;
        self.state = TrackState::empty();
        self.seed0_t = 0;
        self.seed0_lat = 0;
        self.seed0_lon = 0;
        self.seed0_alt = 0;
        self.block_idx = 0;
        self.block_pos = 0;
        self.total_points = 0;
        self.block_start_ts = 0;
        self.block_end_ts = 0;
        self.block_crc.reset();
        self.block_byte_len = 0;
        self.payload_offset = 0;
        self.in_sync_block = false;
        self.configured = true;
        Ok(())
    }

    fn push_point<S: ByteSink>(
        &mut self,
        cells: &mut [u16],
        t: i32,
        lat: i32,
        lon: i32,
        alt: i32,
        sink: &mut S,
    ) -> Result<Option<Gpsl0BlockEntry>, StreamError<S::Error>> {
        if !self.configured {
            return Err(StreamError::InvalidInput("encoder must be reset before use"));
        }
        let layout = layout_for(self.opts.coord_quantum);
        let lat_q = quantize_coord_scalar(lat, self.opts.coord_quantum, self.opts.coord_exact)
            .map_err(StreamError::InvalidInput)?;
        let lon_q = quantize_coord_scalar(lon, self.opts.coord_quantum, self.opts.coord_exact)
            .map_err(StreamError::InvalidInput)?;
        let alt_q = quantize_alt_scalar(alt, self.opts.alt_quantum, self.opts.alt_exact)
            .map_err(StreamError::InvalidInput)?;

        if self.block_pos == 0 {
            let sync = self.block_idx == 0
                || (self.opts.sync_blocks > 0 && self.block_idx % self.opts.sync_blocks == 0);
            self.in_sync_block = sync;
            if sync && self.block_idx > 0 {
                cells[..layout.total_slots].fill(PACKED_INIT_V3);
            }
            self.rc.reset();
            self.block_crc.reset();
            self.block_byte_len = 0;
            self.block_start_ts = t as u32;
        }

        self.block_end_ts = t as u32;
        self.total_points = self.total_points.wrapping_add(1);

        {
            let mut bs = BlockByteSink {
                inner: sink,
                crc: &mut self.block_crc,
                len: &mut self.block_byte_len,
            };
            if self.in_sync_block && self.block_pos == 0 {
                bs.write_all(&t.to_le_bytes()).map_err(StreamError::Sink)?;
                bs.write_all(&lat_q.to_le_bytes())
                    .map_err(StreamError::Sink)?;
                bs.write_all(&lon_q.to_le_bytes())
                    .map_err(StreamError::Sink)?;
                write_svarint_to_sink(&mut bs, alt_q as i64).map_err(StreamError::Sink)?;
                self.seed0_t = t;
                self.seed0_lat = lat_q;
                self.seed0_lon = lon_q;
                self.seed0_alt = alt_q;
            } else if self.in_sync_block && self.block_pos == 1 {
                let dt0 = t.wrapping_sub(self.seed0_t);
                let vlat0 = lat_q.wrapping_sub(self.seed0_lat);
                let vlon0 = lon_q.wrapping_sub(self.seed0_lon);
                let valt0 = alt_q.wrapping_sub(self.seed0_alt);
                write_svarint_to_sink(&mut bs, dt0 as i64).map_err(StreamError::Sink)?;
                write_svarint_to_sink(&mut bs, vlat0 as i64).map_err(StreamError::Sink)?;
                write_svarint_to_sink(&mut bs, vlon0 as i64).map_err(StreamError::Sink)?;
                write_svarint_to_sink(&mut bs, valt0 as i64).map_err(StreamError::Sink)?;
                self.state = TrackState {
                    t_prev: self.seed0_t.wrapping_add(dt0),
                    dt_prev: dt0,
                    dt_prev2: dt0,
                    dt_prev3: dt0,
                    dt_base: dt0,
                    lat: AxisState::from_pair(self.seed0_lat, self.seed0_lat.wrapping_add(vlat0), dt0),
                    lon: AxisState::from_pair(self.seed0_lon, self.seed0_lon.wrapping_add(vlon0), dt0),
                    alt: AxisState::from_pair(self.seed0_alt, self.seed0_alt.wrapping_add(valt0), dt0),
                    e_dt_prev: 0,
                    zero_run: 0,
                };
            } else {
                encode_point_step(
                    &mut self.rc,
                    cells,
                    layout,
                    &self.opts,
                    &mut self.state,
                    &mut bs,
                    t,
                    lat_q,
                    lon_q,
                    alt_q,
                )?;
            }
        }

        self.block_pos += 1;
        if self.block_pos == self.opts.block_points {
            let entry = self.close_current_block(sink)?;
            Ok(Some(entry))
        } else {
            Ok(None)
        }
    }

    fn close_current_block<S: ByteSink>(
        &mut self,
        sink: &mut S,
    ) -> Result<Gpsl0BlockEntry, StreamError<S::Error>> {
        {
            let mut bs = BlockByteSink {
                inner: sink,
                crc: &mut self.block_crc,
                len: &mut self.block_byte_len,
            };
            self.rc.finish(&mut bs).map_err(StreamError::Sink)?;
        }
        let entry = Gpsl0BlockEntry {
            start_ts: self.block_start_ts,
            end_ts: self.block_end_ts,
            point_count: self.block_pos,
            byte_offset: self.payload_offset,
            byte_length: self.block_byte_len,
            crc32: self.block_crc.finalize(),
        };
        self.payload_offset = self.payload_offset.wrapping_add(self.block_byte_len);
        self.block_idx = self.block_idx.wrapping_add(1);
        self.block_pos = 0;
        Ok(entry)
    }

    fn finish<S: ByteSink>(
        &mut self,
        sink: &mut S,
    ) -> Result<Option<Gpsl0BlockEntry>, StreamError<S::Error>> {
        if !self.configured {
            return Err(StreamError::InvalidInput("encoder not reset"));
        }
        if self.block_pos == 0 {
            return Ok(None);
        }
        let entry = self.close_current_block(sink)?;
        Ok(Some(entry))
    }

    fn make_header(&self, entries: &[Gpsl0BlockEntry]) -> Gpsl0HeaderV2 {
        let n_blocks = entries.len() as u32;
        let sync_blocks = if self.opts.sync_blocks > 0 && n_blocks > 0 && self.opts.sync_blocks > n_blocks {
            n_blocks
        } else {
            self.opts.sync_blocks
        };
        Gpsl0HeaderV2 {
            version: 2,
            tier0: self.opts.coord_quantum == 1,
            has_alt: true,
            alt_damped: !matches!(self.opts.alt_mode, AltMode::D1),
            coord_mode: self.opts.coord_mode as u8,
            coord_quantum: self.opts.coord_quantum,
            alt_quantum: self.opts.alt_quantum,
            n_points: self.total_points,
            block_points: self.opts.block_points,
            sync_blocks,
            n_blocks,
            model_id: V3_MODEL_ID,
            header_crc32: 0,
            index_crc32: 0,
        }
    }
}

/// Zero-allocation streaming encoder for GPSL0 v3 (`version = 2`, `model_id = 22`).
///
/// Packs probability and adaptation counter into one `u16` per slot (`61,610 B` for `30,805` slots),
/// giving a total struct size of ~60.5 KiB, safe to place in `static` / `StaticCell` via
/// [`StreamingEncoderV3::new_unconfigured`] on Cortex-M4 MCUs without overflowing the stack.
pub struct StreamingEncoderV3 {
    cells: [u16; V3_TOTAL_SLOTS],
    core: StreamCoreV3,
}

impl StreamingEncoderV3 {
    /// Const zero-stack initializer for `StaticCell` / `static` placement on MCUs.
    /// Must be followed by [`StreamingEncoderV3::reset`] before calling `push_point`.
    pub const fn new_unconfigured() -> Self {
        Self {
            cells: [PACKED_INIT_V3; V3_TOTAL_SLOTS],
            core: StreamCoreV3::new_unconfigured(),
        }
    }

    pub fn new(opts: StreamV3Options) -> Result<Self, StreamError<Infallible>> {
        let mut enc = Self::new_unconfigured();
        enc.reset(opts)?;
        Ok(enc)
    }

    pub fn reset(&mut self, opts: StreamV3Options) -> Result<(), StreamError<Infallible>> {
        self.core.reset(opts, Some(&mut self.cells))
    }

    #[inline]
    pub const fn total_points(&self) -> u32 {
        self.core.total_points
    }

    #[inline]
    pub const fn options(&self) -> &StreamV3Options {
        &self.core.opts
    }

    /// Push one GPS sample `(t, lat, lon, alt)` in raw units (`s`, `1e-7 deg`, `0.1 m`).
    ///
    /// Writes block payload bytes incrementally into `sink`. Whenever a block fills up
    /// (`block_points`), finishes that block payload and returns its [`Gpsl0BlockEntry`].
    pub fn push_point<S: ByteSink>(
        &mut self,
        t: i32,
        lat: i32,
        lon: i32,
        alt: i32,
        sink: &mut S,
    ) -> Result<Option<Gpsl0BlockEntry>, StreamError<S::Error>> {
        self.core
            .push_point(&mut self.cells, t, lat, lon, alt, sink)
    }

    /// Flush the final partial block (if any points were pushed since the last block boundary).
    pub fn finish<S: ByteSink>(
        &mut self,
        sink: &mut S,
    ) -> Result<Option<Gpsl0BlockEntry>, StreamError<S::Error>> {
        self.core.finish(sink)
    }

    /// Build the frozen [`Gpsl0HeaderV2`] matching the streamed blocks (before computing `index_crc32`).
    pub fn make_header(&self, entries: &[Gpsl0BlockEntry]) -> Gpsl0HeaderV2 {
        self.core.make_header(entries)
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn encode_point_step<S: ByteSink>(
    rc: &mut RangeEncoderV2Core,
    cells: &mut [u16],
    layout: &StreamLayout,
    opts: &StreamV3Options,
    state: &mut TrackState,
    sink: &mut BlockByteSink<'_, S>,
    t_cur: i32,
    lat_cur: i32,
    lon_cur: i32,
    alt_cur: i32,
) -> Result<(), StreamError<S::Error>> {
    let cq = opts.coord_quantum as i64;
    let dt_prev = state.dt_prev;
    let dt_cur = t_cur.wrapping_sub(state.t_prev);
    let pred_dt = state.dt_base;
    let e_dt = dt_cur.wrapping_sub(pred_dt);
    let dchg = usize::from(e_dt != 0);

    let vlat_prev = state.lat.x_prev.wrapping_sub(state.lat.x_prev2);
    let vlon_prev = state.lon.x_prev.wrapping_sub(state.lon.x_prev2);
    let stationary = usize::from(vlat_prev == 0 && vlon_prev == 0);

    let pred_lat = predict_coord_stream(&state.lat, dt_prev, dt_cur, cq, opts.coord_mode);
    let pred_lon = predict_coord_stream(&state.lon, dt_prev, dt_cur, cq, opts.coord_mode);
    let pred_alt = predict_alt_stream(&state.alt, dt_prev, dt_cur, opts.alt_mode);

    let e_lat = ((lat_cur as i64) - pred_lat) as i32;
    let e_lon = ((lon_cur as i64) - pred_lon) as i32;
    let e_alt = ((alt_cur as i64) - pred_alt) as i32;

    let dt_b = dt_bucket(pred_dt, 5);
    let dt_ctx = dt_b * 2 + usize::from(state.e_dt_prev != 0);
    encode_residual_stream(
        rc,
        sink,
        cells,
        layout.zero_dt_base + dt_ctx,
        SlotKind::SlowZero,
        layout.mag_dt_base + dt_ctx * MAG_SLOTS,
        layout.sign_dt_base,
        true,
        false,
        pred_dt,
        e_dt,
        state.e_dt_prev,
        dt_prev,
        0,
        false,
        2,
        false,
    )?;

    let az3 = u8::from(e_lat == 0 && e_lon == 0 && e_alt == 0);
    let az_slot = layout.all_zero_base + (run_bucket4(state.zero_run) * 2 + stationary) * 2 + dchg;
    rc.encode_bit_packed(sink, cells, az_slot, az3, SlotKind::SlowZero)?;

    if az3 == 1 {
        state.zero_run = state.zero_run.saturating_add(1);
    } else {
        state.zero_run = 0;

        let (zero_lat, mag_lat) = if layout.grid {
            let vel_b = vel_step_bucket(vlat_prev, dt_prev, pred_dt);
            let z = ((((mag4(state.lat.e_prev) * 2 + usize::from(state.lon.e_prev != 0)) * 2
                + dchg)
                * 2
                + stationary)
                * 5
                + vel_b)
                * 3
                + accel_bucket3(state.lat.v_prev, state.lat.v_prev2);
            let m = (((mag6(state.lat.e_prev) * 2 + dchg) * 5 + vel_b) * 2
                + agree_bit(state.lat.e_prev, state.lat.v_prev))
                * 2
                + accel_growing(state.lat.v_prev, state.lat.v_prev2);
            (layout.zero_lat_base + z, layout.mag_lat_base + m * MAG_SLOTS)
        } else {
            let z = ((mag4(state.lat.e_prev) * 2 + usize::from(state.lon.e_prev != 0)) * 2 + dchg)
                * 2
                + stationary;
            let m = mag6(state.lat.e_prev) * 2 + dchg;
            (layout.zero_lat_base + z, layout.mag_lat_base + m * MAG_SLOTS)
        };
        encode_residual_stream(
            rc,
            sink,
            cells,
            zero_lat,
            SlotKind::FastZero,
            mag_lat,
            layout.sign_lat_base,
            false,
            layout.grid,
            pred_dt,
            e_lat,
            state.lat.e_prev,
            vlat_prev,
            state.lat.last_nz_sign,
            state.lat.last_nz_is1,
            state.lat.zero_gap,
            false,
        )?;

        let (zero_lon, mag_lon) = if layout.grid {
            let vel_b = vel_step_bucket(vlon_prev, dt_prev, pred_dt);
            let e_lat_m4 = mag4(e_lat);
            let z = (((mag4(state.lon.e_prev) * 4 + e_lat_m4) * 2 + dchg) * 5 + vel_b) * 3
                + accel_bucket3(state.lon.v_prev, state.lon.v_prev2);
            let m = ((mag6(state.lon.e_prev) * 4 + e_lat_m4) * 2 + dchg) * 5 + vel_b;
            (layout.zero_lon_base + z, layout.mag_lon_base + m * MAG_SLOTS)
        } else {
            let z = (mag4(state.lon.e_prev) * 4 + mag4(e_lat)) * 2 + dchg;
            let m = (mag6(state.lon.e_prev) * 2 + dchg) * 2 + usize::from(e_lat != 0);
            (layout.zero_lon_base + z, layout.mag_lon_base + m * MAG_SLOTS)
        };
        encode_residual_stream(
            rc,
            sink,
            cells,
            zero_lon,
            SlotKind::FastZero,
            mag_lon,
            layout.sign_lon_base,
            false,
            layout.grid,
            pred_dt,
            e_lon,
            state.lon.e_prev,
            vlon_prev,
            state.lon.last_nz_sign,
            state.lon.last_nz_is1,
            state.lon.zero_gap,
            false,
        )?;

        let horiz_mag = e_lat.unsigned_abs().max(e_lon.unsigned_abs());
        let h_m3 = if horiz_mag == 0 {
            0
        } else if horiz_mag == 1 {
            1
        } else {
            2
        };
        let zero_alt = layout.zero_alt_base + (mag3(state.alt.e_prev) * 3 + h_m3) * 2 + dchg;
        let mag_alt = layout.mag_alt_base
            + (mag3(state.alt.e_prev) * 2 + usize::from(horiz_mag != 0)) * MAG_SLOTS;
        let alt_force_nz = e_lat == 0 && e_lon == 0;
        encode_residual_stream(
            rc,
            sink,
            cells,
            zero_alt,
            SlotKind::FastZero,
            mag_alt,
            layout.sign_alt_base,
            false,
            false,
            pred_dt,
            e_alt,
            state.alt.e_prev,
            state.alt.v_prev,
            state.alt.last_nz_sign,
            state.alt.last_nz_is1,
            state.alt.zero_gap,
            alt_force_nz,
        )?;
    }

    if dt_cur == dt_prev && dt_cur > 0 {
        state.dt_base = dt_cur;
    }
    state.dt_prev3 = state.dt_prev2;
    state.dt_prev2 = dt_prev;
    state.dt_prev = dt_cur;
    state.t_prev = t_cur;
    state.e_dt_prev = e_dt;
    update_coord_stream(&mut state.lat, lat_cur, e_lat);
    update_coord_stream(&mut state.lon, lon_cur, e_lon);
    update_alt_stream(
        &mut state.alt,
        alt_cur,
        dt_prev,
        dt_cur,
        e_alt,
        opts.alt_mode,
    );
    Ok(())
}

#[cfg(feature = "alloc")]
pub fn encode_v3_streaming_to_vec(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &StreamV3Options,
) -> Result<Vec<u8>, Gpsl0Error> {
    let n = t.len();
    if lat.len() != n || lon.len() != n || alt.len() != n {
        return Err(Gpsl0Error::InvalidInput(
            "t/lat/lon/alt arrays must have equal length".into(),
        ));
    }
    let mut core = StreamCoreV3::new_unconfigured();

    if n == 0 {
        core.reset(*opts, None).map_err(|err| match err {
            StreamError::InvalidInput(msg) => Gpsl0Error::InvalidInput(msg.into()),
            StreamError::Sink(inf) => match inf {},
        })?;
        let mut hdr = core.make_header(&[]);
        let mut out = Vec::with_capacity(HEADER_SIZE_V2);
        let Ok(()) = write_v2_header_and_index(&mut hdr, &[], &mut out);
        return Ok(out);
    }

    let active_slots = layout_for(opts.coord_quantum).total_slots;
    let mut cells = vec![PACKED_INIT_V3; active_slots];
    core.reset(*opts, Some(&mut cells)).map_err(|err| match err {
        StreamError::InvalidInput(msg) => Gpsl0Error::InvalidInput(msg.into()),
        StreamError::Sink(inf) => match inf {},
    })?;

    let n_blocks_est = n.div_ceil(opts.block_points as usize);
    let mut entries: Vec<Gpsl0BlockEntry> = Vec::with_capacity(n_blocks_est);
    let mut payloads = Vec::with_capacity(n.saturating_add(64));

    for i in 0..n {
        if let Some(entry) = core
            .push_point(&mut cells, t[i], lat[i], lon[i], alt[i], &mut payloads)
            .map_err(|err| match err {
                StreamError::InvalidInput(msg) => Gpsl0Error::InvalidInput(msg.into()),
                StreamError::Sink(inf) => match inf {},
            })?
        {
            entries.push(entry);
        }
    }
    if let Some(entry) = core.finish(&mut payloads).map_err(|err| match err {
        StreamError::InvalidInput(msg) => Gpsl0Error::InvalidInput(msg.into()),
        StreamError::Sink(inf) => match inf {},
    })? {
        entries.push(entry);
    }

    let mut hdr = core.make_header(&entries);
    let mut out = Vec::with_capacity(HEADER_SIZE_V2 + entries.len() * 14 + payloads.len());
    let Ok(()) = write_v2_header_and_index(&mut hdr, &entries, &mut out);
    out.extend_from_slice(&payloads);
    Ok(out)
}
