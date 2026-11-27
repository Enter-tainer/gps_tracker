use alloc::{format, vec, vec::Vec};

use crate::container::{
    crc32, encode_v2_block_index, write_i32_le, write_svarint_i64, write_v2_header,
    Gpsl0BlockEntry, Gpsl0HeaderV2, HEADER_SIZE_V2,
};
#[cfg(feature = "decode")]
use crate::container::{read_i32_le, read_svarint_i64, read_v2_block_index, read_v2_header};
use crate::error::Gpsl0Error;
use crate::pred::{
    accel_bucket3, accel_growing, agree_bit, dt_bucket, mag3, mag4, mag6, predict_coord_v1, q1,
    round_div, run_bucket4, vel_step_bucket, vmag_bucket, zigzag, AltMode, CoordMode,
};
#[cfg(feature = "decode")]
use crate::pred::unzigzag;
#[cfg(feature = "decode")]
use crate::rangecoder::RangeDecoderV2;
use crate::rangecoder::{RangeEncoderV2, RcV2Params, SlotKind};
use crate::stream::{encode_v3_streaming_to_vec, QuantumScanner, StreamV3Options, V3_MODEL_ID};
use crate::{quantize_points, EncodeOptions, QuantumSpec};
#[cfg(feature = "decode")]
use crate::{DecodedTrack, Gpsl0Meta};

pub const MODEL_ID_V3: u32 = V3_MODEL_ID;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinMode {
    ZigzagTree4,
    SignMagTree4,
    SignMagMsbTree4,
    SignMagMsbTree3,
    SignMagFlat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignMode {
    Raw,
    PrevRel,
    LastNzGap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JointZeroMode {
    None,
    AllZero4,
    DtThenAllZero3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DtPredMode {
    Prev,
    Median3,
    SteadyBase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DchgMode {
    EDtNz,
    DtStepOrBase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActMode {
    None,
    MagEwma4,
    MagEwma8,
    BothEwma4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CtxArch {
    V1Compact,
    Decoupled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordPredV2 {
    Tn,
    Naive,
    TnClamped,
    D1,
    Q1SpikeDamped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AltPredV2 {
    D1,
    Damped025,
    AlphaBeta(i64, i64),
    OnlineLms2,
}

#[derive(Debug, Clone)]
pub struct V2Config {
    pub rc: RcV2Params,
    pub bin_mode: BinMode,
    pub dedicated_m1: bool,
    pub bypass_from: Option<usize>,
    pub sign_mode: SignMode,
    pub joint_zero: JointZeroMode,
    pub dt_pred: DtPredMode,
    pub dchg_mode: DchgMode,
    pub act_mode: ActMode,
    pub ctx_arch: CtxArch,
    pub lon_cross_zero: bool,
    pub lon_cross_mag: bool,
    pub alt_cross_zero: bool,
    pub coord_pred: CoordPredV2,
    pub alt_pred: AltPredV2,
    pub block_points: u32,
    pub compact_container: bool,
    pub priors: Option<Vec<u16>>,
    /// v3 (`model_id = 22`): richer coordinate contexts on grid tracks (`coord_quantum > 10`).
    pub v3_grid_ctx: bool,
}

impl Default for V2Config {
    fn default() -> Self {
        Self {
            rc: RcV2Params {
                prob_bits: 12,
                exact_bound: true,
                min_prob: 4,
                dual_speed: true,
                slow_zero_shift: 7,
                fast_zero_shift: 5,
                mag_shift: 5,
            },
            bin_mode: BinMode::SignMagMsbTree4,
            dedicated_m1: true,
            bypass_from: None,
            sign_mode: SignMode::LastNzGap,
            joint_zero: JointZeroMode::DtThenAllZero3,
            dt_pred: DtPredMode::SteadyBase,
            dchg_mode: DchgMode::EDtNz,
            act_mode: ActMode::None,
            ctx_arch: CtxArch::Decoupled,
            lon_cross_zero: true,
            lon_cross_mag: true,
            alt_cross_zero: true,
            coord_pred: CoordPredV2::Q1SpikeDamped,
            alt_pred: AltPredV2::D1,
            block_points: 32768,
            compact_container: true,
            priors: None,
            v3_grid_ctx: false,
        }
    }
}

impl V2Config {
    /// Model 22 (v3) configuration for a track of the given coordinate quantum.
    pub fn v3(
        coord_quantum: u32,
        coord_pred: CoordPredV2,
        alt_pred: AltPredV2,
        block_points: u32,
    ) -> Self {
        Self {
            coord_pred,
            alt_pred,
            block_points,
            v3_grid_ctx: coord_quantum > 10,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChannelBitStats {
    pub total_bits: f64,
    pub all_zero_bits: f64,
    pub dt_bits: f64,
    pub lat_bits: f64,
    pub lon_bits: f64,
    pub alt_bits: f64,
    pub container_bytes: usize,
    pub payload_bytes: usize,
}

// ---------------------------------------------------------------------------
// Compact decoupled table layout
// ---------------------------------------------------------------------------
const UNARY_SLOTS_V2: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorRole {
    AllZero3(usize),
    DtZero,
    CoordZero,
    AltZero,
    Unary(usize),
    MantBit,
    SignDt,
    SignGap0,
    SignGap1,
    SignGap2,
    SignNeutral,
}

struct LayoutV2 {
    all_zero_base: usize,
    zero_dt_base: usize,
    zero_lat_base: usize,
    zero_lon_base: usize,
    zero_alt_base: usize,

    mag_dt_base: usize,
    mag_lat_base: usize,
    mag_lon_base: usize,
    mag_alt_base: usize,
    mag_slots: usize,
    m1_slot: usize,
    tree_bits: usize,
    tree_base: usize,
    flat_base: usize,

    sign_dt_base: usize,
    sign_lat_base: usize,
    sign_lon_base: usize,
    sign_alt_base: usize,

    total_slots: usize,
    slot_kinds: Vec<SlotKind>,
    slot_roles: Vec<PriorRole>,
}

impl LayoutV2 {
    fn from_config(cfg: &V2Config) -> Self {
        let mut off = 0usize;
        let all_zero_base = off;
        let all_zero_count = match cfg.joint_zero {
            JointZeroMode::None => 0,
            JointZeroMode::AllZero4 => 20,
            JointZeroMode::DtThenAllZero3 => 16,
        };
        off += all_zero_count;

        let tree_bits = match cfg.bin_mode {
            BinMode::ZigzagTree4 | BinMode::SignMagTree4 | BinMode::SignMagMsbTree4 => 4,
            BinMode::SignMagMsbTree3 => 3,
            BinMode::SignMagFlat => 0,
        };
        let tree_nodes = if tree_bits == 0 {
            0
        } else {
            (1usize << tree_bits) - 1
        };
        let m1_extra = usize::from(cfg.dedicated_m1);
        let m1_slot = UNARY_SLOTS_V2;
        let tree_base = UNARY_SLOTS_V2 + m1_extra;
        let flat_base = tree_base + tree_nodes;
        let flat_slots = UNARY_SLOTS_V2.saturating_sub(1 + tree_bits);
        let mag_slots = match cfg.bin_mode {
            BinMode::ZigzagTree4 => 1 + flat_base + flat_slots,
            _ => flat_base + flat_slots,
        };

        let zero_dt_base = off;
        let zero_dt_count = 10usize;
        off += zero_dt_count;

        let zero_lat_base = off;
        let zero_lat_count = if cfg.ctx_arch == CtxArch::V1Compact {
            34
        } else if cfg.v3_grid_ctx {
            480
        } else {
            32
        };
        off += zero_lat_count;

        let zero_lon_base = off;
        let zero_lon_count = if cfg.ctx_arch == CtxArch::V1Compact {
            34
        } else if cfg.v3_grid_ctx {
            480
        } else if cfg.lon_cross_zero {
            32
        } else {
            16
        };
        off += zero_lon_count;

        let zero_alt_base = off;
        let zero_alt_count = if cfg.ctx_arch == CtxArch::V1Compact {
            9
        } else if cfg.alt_cross_zero {
            18
        } else {
            6
        };
        off += zero_alt_count;

        let (mag_dt_ctx, mag_lat_ctx, mag_lon_ctx, mag_alt_ctx) =
            if cfg.ctx_arch == CtxArch::V1Compact {
                (10usize, 34usize, 34usize, 9usize)
            } else if cfg.v3_grid_ctx {
                (10usize, 240usize, 240usize, 6usize)
            } else {
                let m_lat = 12usize;
                let m_lon = if cfg.lon_cross_mag { 24usize } else { 12usize };
                (10usize, m_lat, m_lon, 6usize)
            };

        let mag_dt_base = off;
        off += mag_dt_ctx * mag_slots;
        let mag_lat_base = off;
        off += mag_lat_ctx * mag_slots;
        let mag_lon_base = off;
        off += mag_lon_ctx * mag_slots;
        let mag_alt_base = off;
        off += mag_alt_ctx * mag_slots;

        let sign_dt_slots = if cfg.dt_pred == DtPredMode::Prev { 7 } else { 4 };
        let sign_alt_slots = match cfg.sign_mode {
            SignMode::Raw => 1,
            SignMode::PrevRel => 7,
            SignMode::LastNzGap => 13,
        };
        let sign_coord_slots = if cfg.v3_grid_ctx && cfg.sign_mode == SignMode::LastNzGap {
            260
        } else {
            sign_alt_slots
        };
        let sign_dt_base = off;
        off += sign_dt_slots;
        let sign_lat_base = off;
        off += sign_coord_slots;
        let sign_lon_base = off;
        off += sign_coord_slots;
        let sign_alt_base = off;
        off += sign_alt_slots;

        let total_slots = off;
        let mut slot_kinds = vec![SlotKind::MagSign; total_slots];
        let mut slot_roles = vec![PriorRole::MantBit; total_slots];

        for i in all_zero_base..zero_dt_base {
            slot_kinds[i] = SlotKind::SlowZero;
            let rel = i - all_zero_base;
            let stat_dt = rel & 3;
            slot_roles[i] = PriorRole::AllZero3(stat_dt);
        }
        for i in zero_dt_base..zero_lat_base {
            slot_kinds[i] = SlotKind::SlowZero;
            slot_roles[i] = PriorRole::DtZero;
        }
        for i in zero_lat_base..zero_alt_base {
            slot_kinds[i] = SlotKind::FastZero;
            slot_roles[i] = PriorRole::CoordZero;
        }
        for i in zero_alt_base..mag_dt_base {
            slot_kinds[i] = SlotKind::FastZero;
            slot_roles[i] = PriorRole::AltZero;
        }

        let u_off = usize::from(cfg.bin_mode == BinMode::ZigzagTree4);
        for ctx_base in (mag_dt_base..sign_dt_base).step_by(mag_slots) {
            for t in 0..UNARY_SLOTS_V2 {
                if ctx_base + u_off + t < sign_dt_base {
                    slot_roles[ctx_base + u_off + t] = PriorRole::Unary(t.min(4));
                }
            }
        }

        for i in sign_dt_base..sign_lat_base {
            slot_roles[i] = PriorRole::SignDt;
        }
        for (sb, n_sign) in [
            (sign_lat_base, sign_coord_slots),
            (sign_lon_base, sign_coord_slots),
            (sign_alt_base, sign_alt_slots),
        ] {
            if cfg.sign_mode == SignMode::LastNzGap {
                let mult = (n_sign / 13).max(1);
                for base13 in 0..13usize {
                    let role = match base13 / 4 {
                        0 => PriorRole::SignGap0,
                        1 => PriorRole::SignGap1,
                        2 => PriorRole::SignGap2,
                        _ => PriorRole::SignNeutral,
                    };
                    for m in 0..mult {
                        slot_roles[sb + base13 * mult + m] = role;
                    }
                }
            } else if cfg.sign_mode == SignMode::PrevRel {
                for k in 0..6 {
                    slot_roles[sb + k] = PriorRole::SignGap0;
                }
                slot_roles[sb + 6] = PriorRole::SignNeutral;
            } else {
                slot_roles[sb] = PriorRole::SignNeutral;
            }
        }

        Self {
            all_zero_base,
            zero_dt_base,
            zero_lat_base,
            zero_lon_base,
            zero_alt_base,
            mag_dt_base,
            mag_lat_base,
            mag_lon_base,
            mag_alt_base,
            mag_slots,
            m1_slot,
            tree_bits,
            tree_base,
            flat_base,
            sign_dt_base,
            sign_lat_base,
            sign_lon_base,
            sign_alt_base,
            total_slots,
            slot_kinds,
            slot_roles,
        }
    }
}

#[inline]
fn act_bucket6(act_q3: u32) -> usize {
    if act_q3 == 0 {
        0
    } else if act_q3 <= 4 {
        1
    } else if act_q3 <= 12 {
        2
    } else if act_q3 <= 28 {
        3
    } else if act_q3 <= 80 {
        4
    } else {
        5
    }
}

#[inline]
fn act_bucket4(act_q3: u32) -> usize {
    if act_q3 == 0 {
        0
    } else if act_q3 <= 6 {
        1
    } else if act_q3 <= 20 {
        2
    } else {
        3
    }
}

#[inline]
fn run_bucket5(run: u32) -> usize {
    if run == 0 {
        0
    } else if run == 1 {
        1
    } else if run <= 3 {
        2
    } else if run <= 7 {
        3
    } else {
        4
    }
}

#[inline]
fn median3(a: i32, b: i32, c: i32) -> i32 {
    let min_ab = a.min(b);
    let max_ab = a.max(b);
    c.clamp(min_ab, max_ab)
}

#[derive(Debug, Clone)]
struct AxisPredState {
    x_prev2: i32,
    x_prev: i32,
    x_hat_q8: i64,
    v_hat_q8: i64,
    w_q10: [i64; 2],
    v_prev: i32,
    v_prev2: i32,
    e_prev: i32,
    act_q3: u32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
}

impl AxisPredState {
    fn new(x0: i32, x1: i32, dt0: i32) -> Self {
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
            w_q10: [768, 256],
            v_prev: v0,
            v_prev2: v0,
            e_prev: 0,
            act_q3: 0,
            last_nz_sign: 0,
            last_nz_is1: false,
            zero_gap: 2,
        }
    }

    #[inline]
    fn update_residual_mem(&mut self, e: i32, act_mode: ActMode) {
        self.e_prev = e;
        if e != 0 {
            self.last_nz_sign = if e < 0 { -1 } else { 1 };
            self.last_nz_is1 = e.unsigned_abs() == 1;
            self.zero_gap = 0;
        } else {
            self.zero_gap = self.zero_gap.saturating_add(1).min(2);
        }
        let clamped = e.unsigned_abs().min(128) << 3;
        self.act_q3 = match act_mode {
            ActMode::None => 0,
            ActMode::MagEwma4 | ActMode::BothEwma4 => (self.act_q3 * 3 + clamped) >> 2,
            ActMode::MagEwma8 => (self.act_q3 * 7 + clamped) >> 3,
        };
    }
}

#[inline]
fn predict_coord_axis(
    st: &AxisPredState,
    dt_prev: i32,
    dt_cur: i32,
    coord_quantum: i64,
    mode: CoordPredV2,
) -> i64 {
    match mode {
        CoordPredV2::D1 => st.x_prev as i64,
        CoordPredV2::Tn => predict_coord_v1(
            st.x_prev2,
            st.x_prev,
            dt_prev,
            dt_cur,
            CoordMode::Tn as u8,
        ),
        CoordPredV2::Naive => predict_coord_v1(
            st.x_prev2,
            st.x_prev,
            dt_prev,
            dt_cur,
            CoordMode::Naive as u8,
        ),
        CoordPredV2::TnClamped => predict_coord_v1(
            st.x_prev2,
            st.x_prev,
            dt_prev,
            dt_cur,
            CoordMode::TnClamped as u8,
        ),
        CoordPredV2::Q1SpikeDamped => {
            if coord_quantum <= 10 {
                let v1 = st.x_prev.wrapping_sub(st.x_prev2) as i64;
                let v2 = st.v_prev2 as i64;
                let phys_v1 = v1.abs() * coord_quantum;
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
fn update_coord_axis(st: &mut AxisPredState, x_cur: i32, e_cur: i32, act_mode: ActMode) {
    let v_true = x_cur.wrapping_sub(st.x_prev);
    st.v_prev2 = st.x_prev.wrapping_sub(st.x_prev2);
    st.x_prev2 = st.x_prev;
    st.x_prev = x_cur;
    st.v_prev = v_true;
    st.update_residual_mem(e_cur, act_mode);
}

#[inline]
fn predict_alt_v2(st: &AxisPredState, dt_prev: i32, dt_cur: i32, mode: AltPredV2) -> i64 {
    match mode {
        AltPredV2::D1 => st.x_prev as i64,
        AltPredV2::Damped025 => {
            let va1 = (st.x_prev as i64) - (st.x_prev2 as i64);
            (st.x_prev as i64) + round_div(va1, 4)
        }
        AltPredV2::AlphaBeta(_, _) => {
            let dt_eff = if dt_cur > 0 {
                (dt_cur as i64).min((dt_prev.max(1) as i64) * 2)
            } else {
                0
            };
            let xp_q8 = st.x_hat_q8 + st.v_hat_q8 * dt_eff;
            round_div(xp_q8, 256)
        }
        AltPredV2::OnlineLms2 => {
            let va1 = (st.x_prev as i64) - (st.x_prev2 as i64);
            let va2 = st.v_prev2 as i64;
            (st.x_prev as i64) + round_div(st.w_q10[0] * va1 + st.w_q10[1] * va2, 1024)
        }
    }
}

#[inline]
fn update_alt_v2(
    st: &mut AxisPredState,
    alt_cur: i32,
    dt_prev: i32,
    dt_cur: i32,
    e_cur: i32,
    mode: AltPredV2,
    act_mode: ActMode,
) {
    let va_true = (alt_cur as i64) - (st.x_prev as i64);
    let va1 = (st.x_prev as i64) - (st.x_prev2 as i64);
    let va2 = st.v_prev2 as i64;

    match mode {
        AltPredV2::AlphaBeta(a_q8, b_q8) => {
            if dt_cur <= 0 || dt_cur > dt_prev.max(1) * 4 {
                st.x_hat_q8 = (alt_cur as i64) << 8;
                st.v_hat_q8 = 0;
            } else {
                let dt_eff = (dt_cur as i64).min((dt_prev.max(1) as i64) * 2);
                let dt_real = dt_cur.max(1) as i64;
                let xp_q8 = st.x_hat_q8 + st.v_hat_q8 * dt_eff;
                let r_q8 = ((alt_cur as i64) << 8) - xp_q8;
                st.x_hat_q8 = xp_q8 + round_div(a_q8 * r_q8, 256);
                st.v_hat_q8 += if dt_real == 1 {
                    round_div(b_q8 * r_q8, 256)
                } else {
                    round_div(b_q8 * r_q8, 256 * dt_real)
                };
            }
        }
        AltPredV2::OnlineLms2 => {
            let pred_v = round_div(st.w_q10[0] * va1 + st.w_q10[1] * va2, 1024);
            let err = va_true - pred_v;
            let denom = va1 * va1 + va2 * va2 + 4;
            let dw0 = round_div(82 * err * va1, denom);
            let dw1 = round_div(82 * err * va2, denom);
            st.w_q10[0] = (st.w_q10[0] + dw0).clamp(-512, 1024);
            st.w_q10[1] = (st.w_q10[1] + dw1).clamp(-512, 1024);
        }
        _ => {}
    }

    st.v_prev2 = st.x_prev.wrapping_sub(st.x_prev2);
    st.x_prev2 = st.x_prev;
    st.x_prev = alt_cur;
    st.v_prev = va_true as i32;
    st.update_residual_mem(e_cur, act_mode);
}

#[cfg(feature = "std")]
#[inline]
fn slot_cost(p: u16, scale: u16, bit: u8) -> f64 {
    let p0 = (p as f64) / (scale as f64);
    if bit == 0 {
        -p0.log2()
    } else {
        -(1.0 - p0).log2()
    }
}

#[cfg(not(feature = "std"))]
#[inline]
fn slot_cost(_p: u16, _scale: u16, _bit: u8) -> f64 {
    0.0
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn encode_bit_tracked(
    enc: &mut RangeEncoderV2,
    probs: &mut [u16],
    counts: &mut [u8],
    layout: &LayoutV2,
    index: usize,
    bit: u8,
    scale: u16,
    ch_bits: Option<&mut f64>,
) -> Result<(), Gpsl0Error> {
    if let Some(cb) = ch_bits {
        *cb += slot_cost(probs[index], scale, bit);
    }
    enc.encode_bit(probs, counts, index, bit, layout.slot_kinds[index])
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn sign_slot_index(
    cfg: &V2Config,
    sign_base: usize,
    is_dt: bool,
    is_coord: bool,
    pred_dt: i32,
    e_prev: i32,
    v_prev: i32,
    u: u32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
) -> usize {
    if is_dt && cfg.dt_pred != DtPredMode::Prev {
        return sign_base + usize::from(pred_dt <= 1) * 2 + usize::from(e_prev > 0);
    }
    match cfg.sign_mode {
        SignMode::Raw => sign_base,
        SignMode::PrevRel => {
            let cur_is_1 = usize::from(u == 1);
            if e_prev != 0 {
                let prev_is_1 = usize::from(e_prev.unsigned_abs() == 1);
                sign_base + prev_is_1 * 2 + cur_is_1
            } else if v_prev != 0 {
                sign_base + 4 + cur_is_1
            } else {
                sign_base + 6
            }
        }
        SignMode::LastNzGap => {
            let cur_is_1 = usize::from(u == 1);
            let base13 = if last_nz_sign != 0 {
                let gap = (zero_gap as usize).min(2);
                (gap * 2 + usize::from(last_nz_is1)) * 2 + cur_is_1
            } else {
                12
            };
            let off = if cfg.v3_grid_ctx && is_coord {
                (base13 * 4 + mag4(e_prev)) * 5 + vmag_bucket(v_prev)
            } else {
                base13
            };
            sign_base + off
        }
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn sign_slot_and_bit_encode(
    cfg: &V2Config,
    sign_base: usize,
    is_dt: bool,
    is_coord: bool,
    e: i32,
    u: u32,
    pred_dt: i32,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
) -> (usize, u8) {
    let slot = sign_slot_index(
        cfg,
        sign_base,
        is_dt,
        is_coord,
        pred_dt,
        e_prev,
        v_prev,
        u,
        last_nz_sign,
        last_nz_is1,
        zero_gap,
    );
    let is_neg = e < 0;
    let bit = if is_dt && cfg.dt_pred != DtPredMode::Prev {
        u8::from(is_neg)
    } else {
        match cfg.sign_mode {
            SignMode::Raw => u8::from(is_neg),
            SignMode::PrevRel => {
                if e_prev != 0 {
                    u8::from(is_neg != (e_prev < 0))
                } else if v_prev != 0 {
                    u8::from(is_neg != (v_prev < 0))
                } else {
                    u8::from(is_neg)
                }
            }
            SignMode::LastNzGap => {
                if last_nz_sign != 0 {
                    u8::from(is_neg != (last_nz_sign < 0))
                } else {
                    u8::from(is_neg)
                }
            }
        }
    };
    (slot, bit)
}

#[cfg(feature = "decode")]
#[inline]
fn sign_decode_value(
    cfg: &V2Config,
    is_dt: bool,
    u: u32,
    sign_bit: u8,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
) -> i32 {
    let is_neg = if is_dt && cfg.dt_pred != DtPredMode::Prev {
        sign_bit != 0
    } else {
        match cfg.sign_mode {
            SignMode::Raw => sign_bit != 0,
            SignMode::PrevRel => {
                if e_prev != 0 {
                    (sign_bit != 0) != (e_prev < 0)
                } else if v_prev != 0 {
                    (sign_bit != 0) != (v_prev < 0)
                } else {
                    sign_bit != 0
                }
            }
            SignMode::LastNzGap => {
                if last_nz_sign != 0 {
                    (sign_bit != 0) != (last_nz_sign < 0)
                } else {
                    sign_bit != 0
                }
            }
        }
    };
    if is_neg {
        (u as i32).wrapping_neg()
    } else {
        u as i32
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn encode_residual_v2(
    enc: &mut RangeEncoderV2,
    probs: &mut [u16],
    counts: &mut [u8],
    layout: &LayoutV2,
    cfg: &V2Config,
    zero_idx: usize,
    mag_base: usize,
    sign_base: usize,
    is_dt: bool,
    is_coord: bool,
    pred_dt: i32,
    e: i32,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
    force_nonzero: bool,
    mut ch_bits: Option<&mut f64>,
) -> Result<(), Gpsl0Error> {
    let scale = cfg.rc.prob_scale();
    if cfg.bin_mode == BinMode::ZigzagTree4 {
        let base = mag_base;
        let u = zigzag(e);
        if u == 0 {
            if !force_nonzero {
                encode_bit_tracked(enc, probs, counts, layout, zero_idx, 0, scale, ch_bits.as_deref_mut())?;
            }
            return Ok(());
        }
        if !force_nonzero {
            encode_bit_tracked(enc, probs, counts, layout, zero_idx, 1, scale, ch_bits.as_deref_mut())?;
        }
        let m = (31 - u.leading_zeros()) as usize;
        if m >= UNARY_SLOTS_V2 {
            for t in 0..UNARY_SLOTS_V2 {
                encode_bit_tracked(enc, probs, counts, layout, base + 1 + t, 1, scale, ch_bits.as_deref_mut())?;
            }
            for k in (0..32).rev() {
                if let Some(cb) = ch_bits.as_deref_mut() {
                    *cb += 1.0;
                }
                enc.encode_direct(((u >> k) & 1) as u8);
            }
            return Ok(());
        }
        for t in 0..m {
            encode_bit_tracked(enc, probs, counts, layout, base + 1 + t, 1, scale, ch_bits.as_deref_mut())?;
        }
        encode_bit_tracked(enc, probs, counts, layout, base + 1 + m, 0, scale, ch_bits.as_deref_mut())?;
        for k in 0..m {
            let bit = ((u >> k) & 1) as u8;
            if k < layout.tree_bits {
                let node =
                    1 + layout.tree_base + ((1usize << k) - 1) + ((u as usize) & ((1usize << k) - 1));
                encode_bit_tracked(enc, probs, counts, layout, base + node, bit, scale, ch_bits.as_deref_mut())?;
            } else {
                encode_bit_tracked(
                    enc,
                    probs,
                    counts,
                    layout,
                    base + 1 + layout.flat_base + (k - layout.tree_bits),
                    bit,
                    scale,
                    ch_bits.as_deref_mut(),
                )?;
            }
        }
        return Ok(());
    }

    if e == 0 {
        if !force_nonzero {
            encode_bit_tracked(enc, probs, counts, layout, zero_idx, 0, scale, ch_bits.as_deref_mut())?;
        }
        return Ok(());
    }
    if !force_nonzero {
        encode_bit_tracked(enc, probs, counts, layout, zero_idx, 1, scale, ch_bits.as_deref_mut())?;
    }

    let u = e.unsigned_abs();
    let m = (31 - u.leading_zeros()) as usize;
    let base = mag_base;

    if m >= UNARY_SLOTS_V2 {
        for t in 0..UNARY_SLOTS_V2 {
            encode_bit_tracked(enc, probs, counts, layout, base + t, 1, scale, ch_bits.as_deref_mut())?;
        }
        for k in (0..32).rev() {
            if let Some(cb) = ch_bits.as_deref_mut() {
                *cb += 1.0;
            }
            enc.encode_direct(((u >> k) & 1) as u8);
        }
    } else {
        for t in 0..m {
            encode_bit_tracked(enc, probs, counts, layout, base + t, 1, scale, ch_bits.as_deref_mut())?;
        }
        encode_bit_tracked(enc, probs, counts, layout, base + m, 0, scale, ch_bits.as_deref_mut())?;

        if m == 1 && cfg.dedicated_m1 {
            let bit = (u & 1) as u8;
            encode_bit_tracked(
                enc,
                probs,
                counts,
                layout,
                base + layout.m1_slot,
                bit,
                scale,
                ch_bits.as_deref_mut(),
            )?;
        } else if matches!(
            cfg.bin_mode,
            BinMode::SignMagMsbTree4 | BinMode::SignMagMsbTree3
        ) {
            let mut prefix = 0usize;
            for step in 0..m {
                let k = m - 1 - step;
                let bit = ((u >> k) & 1) as u8;
                if let Some(bf) = cfg.bypass_from {
                    if step >= bf {
                        if let Some(cb) = ch_bits.as_deref_mut() {
                            *cb += 1.0;
                        }
                        enc.encode_direct(bit);
                        continue;
                    }
                }
                if step < layout.tree_bits {
                    let node = layout.tree_base + ((1usize << step) - 1) + prefix;
                    encode_bit_tracked(
                        enc,
                        probs,
                        counts,
                        layout,
                        base + node,
                        bit,
                        scale,
                        ch_bits.as_deref_mut(),
                    )?;
                    prefix = (prefix << 1) | (bit as usize);
                } else {
                    encode_bit_tracked(
                        enc,
                        probs,
                        counts,
                        layout,
                        base + layout.flat_base + (step - layout.tree_bits),
                        bit,
                        scale,
                        ch_bits.as_deref_mut(),
                    )?;
                }
            }
        } else {
            for k in 0..m {
                let bit = ((u >> k) & 1) as u8;
                if let Some(bf) = cfg.bypass_from {
                    if k >= bf {
                        if let Some(cb) = ch_bits.as_deref_mut() {
                            *cb += 1.0;
                        }
                        enc.encode_direct(bit);
                        continue;
                    }
                }
                if k < layout.tree_bits {
                    let node =
                        layout.tree_base + ((1usize << k) - 1) + ((u as usize) & ((1usize << k) - 1));
                    encode_bit_tracked(
                        enc,
                        probs,
                        counts,
                        layout,
                        base + node,
                        bit,
                        scale,
                        ch_bits.as_deref_mut(),
                    )?;
                } else {
                    encode_bit_tracked(
                        enc,
                        probs,
                        counts,
                        layout,
                        base + layout.flat_base + (k - layout.tree_bits),
                        bit,
                        scale,
                        ch_bits.as_deref_mut(),
                    )?;
                }
            }
        }
    }

    let (sign_slot, sign_bit) = sign_slot_and_bit_encode(
        cfg,
        sign_base,
        is_dt,
        is_coord,
        e,
        u,
        pred_dt,
        e_prev,
        v_prev,
        last_nz_sign,
        last_nz_is1,
        zero_gap,
    );
    encode_bit_tracked(
        enc,
        probs,
        counts,
        layout,
        sign_slot,
        sign_bit,
        scale,
        ch_bits.as_deref_mut(),
    )?;
    Ok(())
}

#[cfg(feature = "decode")]
#[inline]
#[allow(clippy::too_many_arguments)]
fn decode_residual_v2(
    dec: &mut RangeDecoderV2<'_>,
    probs: &mut [u16],
    counts: &mut [u8],
    layout: &LayoutV2,
    cfg: &V2Config,
    zero_idx: usize,
    mag_base: usize,
    sign_base: usize,
    is_dt: bool,
    is_coord: bool,
    pred_dt: i32,
    e_prev: i32,
    v_prev: i32,
    last_nz_sign: i8,
    last_nz_is1: bool,
    zero_gap: u8,
    force_nonzero: bool,
) -> Result<i32, Gpsl0Error> {
    if cfg.bin_mode == BinMode::ZigzagTree4 {
        let base = mag_base;
        if !force_nonzero && dec.decode_bit(probs, counts, zero_idx, layout.slot_kinds[zero_idx])? == 0 {
            return Ok(0);
        }
        let mut m = 0usize;
        while m < UNARY_SLOTS_V2 {
            if dec.decode_bit(probs, counts, base + 1 + m, SlotKind::MagSign)? == 0 {
                break;
            }
            m += 1;
        }
        if m == UNARY_SLOTS_V2 {
            let mut u = 0u32;
            for _ in 0..32 {
                u = (u << 1) | (dec.decode_direct()? as u32);
            }
            return Ok(unzigzag(u));
        }
        let mut u = 0u32;
        for k in 0..m {
            let bit = if k < layout.tree_bits {
                let node = 1 + layout.tree_base + ((1usize << k) - 1) + (u as usize);
                dec.decode_bit(probs, counts, base + node, SlotKind::MagSign)?
            } else {
                dec.decode_bit(
                    probs,
                    counts,
                    base + 1 + layout.flat_base + (k - layout.tree_bits),
                    SlotKind::MagSign,
                )?
            };
            u |= (bit as u32) << k;
        }
        u |= 1u32 << m;
        return Ok(unzigzag(u));
    }

    if !force_nonzero
        && dec.decode_bit(probs, counts, zero_idx, layout.slot_kinds[zero_idx])? == 0
    {
        return Ok(0);
    }

    let base = mag_base;
    let mut m = 0usize;
    while m < UNARY_SLOTS_V2 {
        if dec.decode_bit(probs, counts, base + m, SlotKind::MagSign)? == 0 {
            break;
        }
        m += 1;
    }

    let u: u32 = if m == UNARY_SLOTS_V2 {
        let mut v = 0u32;
        for _ in 0..32 {
            v = (v << 1) | (dec.decode_direct()? as u32);
        }
        v
    } else if m == 1 && cfg.dedicated_m1 {
        let bit = dec.decode_bit(probs, counts, base + layout.m1_slot, SlotKind::MagSign)?;
        2u32 | (bit as u32)
    } else if matches!(
        cfg.bin_mode,
        BinMode::SignMagMsbTree4 | BinMode::SignMagMsbTree3
    ) {
        let mut v = 1u32 << m;
        let mut prefix = 0usize;
        for step in 0..m {
            let k = m - 1 - step;
            let bit = if cfg.bypass_from.is_some_and(|bf| step >= bf) {
                dec.decode_direct()?
            } else if step < layout.tree_bits {
                let node = layout.tree_base + ((1usize << step) - 1) + prefix;
                let b = dec.decode_bit(probs, counts, base + node, SlotKind::MagSign)?;
                prefix = (prefix << 1) | (b as usize);
                b
            } else {
                dec.decode_bit(
                    probs,
                    counts,
                    base + layout.flat_base + (step - layout.tree_bits),
                    SlotKind::MagSign,
                )?
            };
            v |= (bit as u32) << k;
        }
        v
    } else {
        let mut v = 0u32;
        for k in 0..m {
            let bit = if cfg.bypass_from.is_some_and(|bf| k >= bf) {
                dec.decode_direct()?
            } else if k < layout.tree_bits {
                let node = layout.tree_base + ((1usize << k) - 1) + (v as usize);
                dec.decode_bit(probs, counts, base + node, SlotKind::MagSign)?
            } else {
                dec.decode_bit(
                    probs,
                    counts,
                    base + layout.flat_base + (k - layout.tree_bits),
                    SlotKind::MagSign,
                )?
            };
            v |= (bit as u32) << k;
        }
        v | (1u32 << m)
    };

    let sign_slot = sign_slot_index(
        cfg,
        sign_base,
        is_dt,
        is_coord,
        pred_dt,
        e_prev,
        v_prev,
        u,
        last_nz_sign,
        last_nz_is1,
        zero_gap,
    );
    let sign_bit = dec.decode_bit(probs, counts, sign_slot, SlotKind::MagSign)?;
    Ok(sign_decode_value(
        cfg,
        is_dt,
        u,
        sign_bit,
        e_prev,
        v_prev,
        last_nz_sign,
    ))
}

#[inline]
fn select_dt_ctx(layout: &LayoutV2, _cfg: &V2Config, pred_dt: i32, e_dt_prev: i32) -> (usize, usize) {
    let dt_q = dt_bucket(pred_dt, 5) * 2 + usize::from(e_dt_prev != 0);
    (layout.zero_dt_base + dt_q, layout.mag_dt_base + dt_q * layout.mag_slots)
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn select_lat_ctx(
    layout: &LayoutV2,
    cfg: &V2Config,
    pred_dt: i32,
    dt_prev: i32,
    lat: &AxisPredState,
    lon: &AxisPredState,
    vlat_prev: i32,
    stationary: usize,
    dchg: usize,
) -> (usize, usize) {
    if cfg.ctx_arch == CtxArch::V1Compact {
        let lat_q = q1(lat.e_prev, 8) * 2 + dchg;
        return (
            layout.zero_lat_base + lat_q,
            layout.mag_lat_base + lat_q * layout.mag_slots,
        );
    }
    if cfg.v3_grid_ctx {
        let vel_b = vel_step_bucket(vlat_prev, dt_prev, pred_dt);
        let z_lat = ((((mag4(lat.e_prev) * 2 + usize::from(lon.e_prev != 0)) * 2 + dchg) * 2
            + stationary)
            * 5
            + vel_b)
            * 3
            + accel_bucket3(lat.v_prev, lat.v_prev2);
        let m_lat = ((((mag6(lat.e_prev) * 2 + dchg) * 5 + vel_b) * 2
            + agree_bit(lat.e_prev, lat.v_prev))
            * 2)
            + accel_growing(lat.v_prev, lat.v_prev2);
        return (
            layout.zero_lat_base + z_lat,
            layout.mag_lat_base + m_lat * layout.mag_slots,
        );
    }
    let use_both_ewma = cfg.act_mode == ActMode::BothEwma4;
    let use_mag_ewma = cfg.act_mode != ActMode::None;
    let lat_z_bkt = if use_both_ewma {
        act_bucket4(lat.act_q3)
    } else {
        mag4(lat.e_prev)
    };
    let zero_lat = layout.zero_lat_base
        + ((lat_z_bkt * 2 + usize::from(lon.e_prev != 0)) * 2 + dchg) * 2
        + stationary;
    let lat_m_bkt = if use_mag_ewma {
        act_bucket6(lat.act_q3)
    } else {
        mag6(lat.e_prev)
    };
    let mag_lat = layout.mag_lat_base + (lat_m_bkt * 2 + dchg) * layout.mag_slots;
    (zero_lat, mag_lat)
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn select_lon_ctx(
    layout: &LayoutV2,
    cfg: &V2Config,
    pred_dt: i32,
    dt_prev: i32,
    lon: &AxisPredState,
    vlon_prev: i32,
    dchg: usize,
    e_lat: i32,
) -> (usize, usize) {
    if cfg.ctx_arch == CtxArch::V1Compact {
        let lon_q = q1(lon.e_prev, 8) * 2 + dchg;
        return (
            layout.zero_lon_base + lon_q,
            layout.mag_lon_base + lon_q * layout.mag_slots,
        );
    }
    if cfg.v3_grid_ctx {
        let vel_b = vel_step_bucket(vlon_prev, dt_prev, pred_dt);
        let e_lat_m4 = mag4(e_lat);
        let z_lon = (((mag4(lon.e_prev) * 4 + e_lat_m4) * 2 + dchg) * 5 + vel_b) * 3
            + accel_bucket3(lon.v_prev, lon.v_prev2);
        let m_lon = ((mag6(lon.e_prev) * 4 + e_lat_m4) * 2 + dchg) * 5 + vel_b;
        return (
            layout.zero_lon_base + z_lon,
            layout.mag_lon_base + m_lon * layout.mag_slots,
        );
    }
    let use_both_ewma = cfg.act_mode == ActMode::BothEwma4;
    let use_mag_ewma = cfg.act_mode != ActMode::None;
    let lon_z_bkt = if use_both_ewma {
        act_bucket4(lon.act_q3)
    } else {
        mag4(lon.e_prev)
    };
    let zero_lon = if cfg.lon_cross_zero {
        layout.zero_lon_base + (lon_z_bkt * 4 + mag4(e_lat)) * 2 + dchg
    } else {
        layout.zero_lon_base + lon_z_bkt * 2 + dchg
    };
    let lon_m_bkt = if use_mag_ewma {
        act_bucket6(lon.act_q3)
    } else {
        mag6(lon.e_prev)
    };
    let mag_lon = if cfg.lon_cross_mag {
        layout.mag_lon_base
            + ((lon_m_bkt * 2 + dchg) * 2 + usize::from(e_lat != 0)) * layout.mag_slots
    } else {
        layout.mag_lon_base + (lon_m_bkt * 2 + dchg) * layout.mag_slots
    };
    (zero_lon, mag_lon)
}

#[inline]
fn select_alt_ctx(
    layout: &LayoutV2,
    cfg: &V2Config,
    alt: &AxisPredState,
    dchg: usize,
    e_lat: i32,
    e_lon: i32,
) -> (usize, usize) {
    if cfg.ctx_arch == CtxArch::V1Compact {
        let alt_q = q1(alt.e_prev, 4);
        return (
            layout.zero_alt_base + alt_q,
            layout.mag_alt_base + alt_q * layout.mag_slots,
        );
    }
    let use_both_ewma = cfg.act_mode == ActMode::BothEwma4;
    let use_mag_ewma = cfg.act_mode != ActMode::None;
    let horiz_mag = (e_lat.unsigned_abs()).max(e_lon.unsigned_abs());
    let h_m3 = if horiz_mag == 0 {
        0
    } else if horiz_mag == 1 {
        1
    } else {
        2
    };
    let alt_z_bkt = if use_both_ewma {
        (act_bucket4(alt.act_q3)).min(2)
    } else {
        mag3(alt.e_prev)
    };
    let zero_alt = if cfg.alt_cross_zero {
        layout.zero_alt_base + (alt_z_bkt * 3 + h_m3) * 2 + dchg
    } else {
        layout.zero_alt_base + alt_z_bkt * 2 + dchg
    };
    let alt_m_bkt = if use_mag_ewma {
        (act_bucket6(alt.act_q3)).min(2)
    } else {
        mag3(alt.e_prev)
    };
    let mag_alt = layout.mag_alt_base
        + (alt_m_bkt * 2 + usize::from(horiz_mag != 0)) * layout.mag_slots;
    (zero_alt, mag_alt)
}

#[derive(Debug, Clone)]
struct V2State {
    t_prev: i32,
    dt_prev: i32,
    dt_prev2: i32,
    dt_prev3: i32,
    dt_base: i32,
    lat: AxisPredState,
    lon: AxisPredState,
    alt: AxisPredState,
    e_dt_prev: i32,
    zero_run: u32,
}

impl V2State {
    #[inline]
    fn predict_dt(&self, mode: DtPredMode) -> i32 {
        match mode {
            DtPredMode::Prev => self.dt_prev,
            DtPredMode::Median3 => median3(self.dt_prev, self.dt_prev2, self.dt_prev3),
            DtPredMode::SteadyBase => self.dt_base,
        }
    }

    #[inline]
    fn dchg_flag(&self, dt_cur: i32, e_dt: i32, mode: DchgMode) -> usize {
        match mode {
            DchgMode::EDtNz => usize::from(e_dt != 0),
            DchgMode::DtStepOrBase => usize::from(dt_cur != self.dt_prev || e_dt != 0),
        }
    }
}

fn write_seed_v2(
    out: &mut Vec<u8>,
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    start: usize,
    count: usize,
    compact: bool,
) -> V2State {
    let t0 = t[start];
    let lat0 = lat[start];
    let lon0 = lon[start];
    let alt0 = alt[start];
    let has2 = count >= 2;
    let dt0 = if has2 { t[start + 1].wrapping_sub(t0) } else { 0 };
    let vlat0 = if has2 { lat[start + 1].wrapping_sub(lat0) } else { 0 };
    let vlon0 = if has2 { lon[start + 1].wrapping_sub(lon0) } else { 0 };
    let valt0 = if has2 { alt[start + 1].wrapping_sub(alt0) } else { 0 };

    if compact {
        out.extend_from_slice(&t0.to_le_bytes());
        out.extend_from_slice(&lat0.to_le_bytes());
        out.extend_from_slice(&lon0.to_le_bytes());
        write_svarint_i64(out, alt0 as i64);
        if has2 {
            write_svarint_i64(out, dt0 as i64);
            write_svarint_i64(out, vlat0 as i64);
            write_svarint_i64(out, vlon0 as i64);
            write_svarint_i64(out, valt0 as i64);
        }
    } else {
        let off = out.len();
        out.resize(off + 32, 0);
        write_i32_le(out, off, t0);
        write_i32_le(out, off + 4, lat0);
        write_i32_le(out, off + 8, lon0);
        write_i32_le(out, off + 12, alt0);
        write_i32_le(out, off + 16, dt0);
        write_i32_le(out, off + 20, vlat0);
        write_i32_le(out, off + 24, vlon0);
        write_i32_le(out, off + 28, valt0);
    }

    let t1 = t0.wrapping_add(dt0);
    let lat1 = lat0.wrapping_add(vlat0);
    let lon1 = lon0.wrapping_add(vlon0);
    let alt1 = alt0.wrapping_add(valt0);
    V2State {
        t_prev: t1,
        dt_prev: dt0,
        dt_prev2: dt0,
        dt_prev3: dt0,
        dt_base: dt0,
        lat: AxisPredState::new(lat0, lat1, dt0),
        lon: AxisPredState::new(lon0, lon1, dt0),
        alt: AxisPredState::new(alt0, alt1, dt0),
        e_dt_prev: 0,
        zero_run: 0,
    }
}

#[cfg(feature = "decode")]
fn read_seed_v2(payload: &[u8], count: usize, compact: bool) -> Result<(V2State, usize), Gpsl0Error> {
    let (t0, lat0, lon0, alt0, dt0, vlat0, vlon0, valt0, pos) = if compact {
        if payload.len() < 12 {
            return Err(Gpsl0Error::Truncated("truncated v2 seed".into()));
        }
        let t0 = read_i32_le(payload, 0);
        let lat0 = read_i32_le(payload, 4);
        let lon0 = read_i32_le(payload, 8);
        let mut p = 12usize;
        let alt0 = read_svarint_i64(payload, &mut p)? as i32;
        if count >= 2 {
            let d = read_svarint_i64(payload, &mut p)? as i32;
            let vl = read_svarint_i64(payload, &mut p)? as i32;
            let vn = read_svarint_i64(payload, &mut p)? as i32;
            let va = read_svarint_i64(payload, &mut p)? as i32;
            (t0, lat0, lon0, alt0, d, vl, vn, va, p)
        } else {
            (t0, lat0, lon0, alt0, 0, 0, 0, 0, p)
        }
    } else {
        if payload.len() < 32 {
            return Err(Gpsl0Error::Truncated("truncated v2 seed".into()));
        }
        (
            read_i32_le(payload, 0),
            read_i32_le(payload, 4),
            read_i32_le(payload, 8),
            read_i32_le(payload, 12),
            read_i32_le(payload, 16),
            read_i32_le(payload, 20),
            read_i32_le(payload, 24),
            read_i32_le(payload, 28),
            32,
        )
    };
    let t1 = t0.wrapping_add(dt0);
    let lat1 = lat0.wrapping_add(vlat0);
    let lon1 = lon0.wrapping_add(vlon0);
    let alt1 = alt0.wrapping_add(valt0);
    Ok((
        V2State {
            t_prev: t1,
            dt_prev: dt0,
            dt_prev2: dt0,
            dt_prev3: dt0,
            dt_base: dt0,
            lat: AxisPredState::new(lat0, lat1, dt0),
            lon: AxisPredState::new(lon0, lon1, dt0),
            alt: AxisPredState::new(alt0, alt1, dt0),
            e_dt_prev: 0,
            zero_run: 0,
        },
        pos,
    ))
}

fn init_probs_v2(layout: &LayoutV2, cfg: &V2Config) -> Vec<u16> {
    if let Some(p) = &cfg.priors {
        if p.len() == layout.total_slots {
            return p.clone();
        }
    }
    vec![cfg.rc.prob_init(); layout.total_slots]
}

#[inline]
fn is_sync_block(b: usize, sync_blocks: u32) -> bool {
    b == 0 || (sync_blocks > 0 && b % (sync_blocks as usize) == 0)
}

pub fn encode_v2_with_config(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &EncodeOptions,
    cfg: &V2Config,
    mut stats: Option<&mut ChannelBitStats>,
) -> Result<Vec<u8>, Gpsl0Error> {
    let n = t.len();
    let block_points = opts.block_points.unwrap_or(cfg.block_points);
    if block_points < 2 || block_points > (1 << 20) {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad block_points {block_points}"
        )));
    }
    let q = quantize_points(t, lat, lon, alt, opts)?;
    let cq = q.coord_quantum as i64;
    let layout = LayoutV2::from_config(cfg);

    let n_blocks = if n == 0 {
        0
    } else {
        n.div_ceil(block_points as usize)
    };
    let mut sync_blocks = opts.sync_blocks;
    if sync_blocks > 0 && n_blocks > 0 && (sync_blocks as usize) > n_blocks {
        sync_blocks = n_blocks as u32;
    }

    let mut payloads: Vec<Vec<u8>> = Vec::with_capacity(n_blocks);
    let mut entries: Vec<Gpsl0BlockEntry> = Vec::with_capacity(n_blocks);
    let mut probs = init_probs_v2(&layout, cfg);
    let mut counts = vec![0u8; layout.total_slots];
    let mut carried: Option<V2State> = None;
    let scale = cfg.rc.prob_scale();

    for b in 0..n_blocks {
        let start = b * (block_points as usize);
        let count = (block_points as usize).min(n - start);
        let sync = is_sync_block(b, sync_blocks);
        if sync {
            if b > 0 {
                probs = init_probs_v2(&layout, cfg);
                counts.fill(0);
            }
            carried = None;
        }

        let mut payload = Vec::new();
        let (mut st, i_start) = if sync {
            let s = write_seed_v2(
                &mut payload,
                &q.t,
                &q.lat,
                &q.lon,
                &q.alt,
                start,
                count,
                cfg.compact_container,
            );
            (s, start + 2)
        } else {
            let prev = carried.ok_or_else(|| {
                Gpsl0Error::InvalidInput("continuation block without carried state".into())
            })?;
            (prev, start)
        };

        let mut enc = RangeEncoderV2::new(cfg.rc);
        for i in i_start..(start + count) {
            let dt_prev = st.dt_prev;
            let t_cur = q.t[i];
            let dt_cur = t_cur.wrapping_sub(st.t_prev);
            let pred_dt = st.predict_dt(cfg.dt_pred);
            let e_dt = dt_cur.wrapping_sub(pred_dt);
            let dchg = st.dchg_flag(dt_cur, e_dt, cfg.dchg_mode);

            let vlat_prev = st.lat.x_prev.wrapping_sub(st.lat.x_prev2);
            let vlon_prev = st.lon.x_prev.wrapping_sub(st.lon.x_prev2);
            let stationary = usize::from(vlat_prev == 0 && vlon_prev == 0);

            let pred_lat = predict_coord_axis(&st.lat, dt_prev, dt_cur, cq, cfg.coord_pred);
            let pred_lon = predict_coord_axis(&st.lon, dt_prev, dt_cur, cq, cfg.coord_pred);
            let pred_alt = predict_alt_v2(&st.alt, dt_prev, dt_cur, cfg.alt_pred);

            let e_lat = ((q.lat[i] as i64) - pred_lat) as i32;
            let e_lon = ((q.lon[i] as i64) - pred_lon) as i32;
            let e_alt = ((q.alt[i] as i64) - pred_alt) as i32;

            let mut skip_remaining = false;

            if cfg.joint_zero == JointZeroMode::AllZero4 {
                let az = u8::from(e_dt == 0 && e_lat == 0 && e_lon == 0 && e_alt == 0);
                let dt_steady = usize::from(dt_prev == 1);
                let az_slot = layout.all_zero_base
                    + (run_bucket5(st.zero_run) * 2 + stationary) * 2
                    + dt_steady;
                if let Some(sb) = stats.as_deref_mut() {
                    sb.all_zero_bits += slot_cost(probs[az_slot], scale, az);
                }
                enc.encode_bit(
                    &mut probs,
                    &mut counts,
                    az_slot,
                    az,
                    layout.slot_kinds[az_slot],
                )?;
                if az == 1 {
                    st.zero_run = st.zero_run.saturating_add(1);
                    skip_remaining = true;
                } else {
                    st.zero_run = 0;
                }
            }

            if !skip_remaining {
                let (zero_dt, mag_dt) = select_dt_ctx(&layout, cfg, pred_dt, st.e_dt_prev);

                let dt_bits = stats.as_deref_mut().map(|s| &mut s.dt_bits);
                encode_residual_v2(
                    &mut enc,
                    &mut probs,
                    &mut counts,
                    &layout,
                    cfg,
                    zero_dt,
                    mag_dt,
                    layout.sign_dt_base,
                    true,
                    false,
                    pred_dt,
                    e_dt,
                    st.e_dt_prev,
                    dt_prev,
                    0,
                    false,
                    2,
                    false,
                    dt_bits,
                )?;

                let mut skip_coords = false;
                if cfg.joint_zero == JointZeroMode::DtThenAllZero3 {
                    let az3 = u8::from(e_lat == 0 && e_lon == 0 && e_alt == 0);
                    let az_slot = layout.all_zero_base
                        + (run_bucket4(st.zero_run) * 2 + stationary) * 2
                        + dchg;
                    if let Some(sb) = stats.as_deref_mut() {
                        sb.all_zero_bits += slot_cost(probs[az_slot], scale, az3);
                    }
                    enc.encode_bit(
                        &mut probs,
                        &mut counts,
                        az_slot,
                        az3,
                        layout.slot_kinds[az_slot],
                    )?;
                    if az3 == 1 {
                        st.zero_run = st.zero_run.saturating_add(1);
                        skip_coords = true;
                    } else {
                        st.zero_run = 0;
                    }
                }

                if !skip_coords {
                    let (zero_lat, mag_lat) = select_lat_ctx(
                        &layout,
                        cfg,
                        pred_dt,
                        dt_prev,
                        &st.lat,
                        &st.lon,
                        vlat_prev,
                        stationary,
                        dchg,
                    );
                    let lat_bits = stats.as_deref_mut().map(|s| &mut s.lat_bits);
                    encode_residual_v2(
                        &mut enc,
                        &mut probs,
                        &mut counts,
                        &layout,
                        cfg,
                        zero_lat,
                        mag_lat,
                        layout.sign_lat_base,
                        false,
                        true,
                        pred_dt,
                        e_lat,
                        st.lat.e_prev,
                        vlat_prev,
                        st.lat.last_nz_sign,
                        st.lat.last_nz_is1,
                        st.lat.zero_gap,
                        false,
                        lat_bits,
                    )?;

                    let (zero_lon, mag_lon) = select_lon_ctx(
                        &layout,
                        cfg,
                        pred_dt,
                        dt_prev,
                        &st.lon,
                        vlon_prev,
                        dchg,
                        e_lat,
                    );
                    let lon_bits = stats.as_deref_mut().map(|s| &mut s.lon_bits);
                    encode_residual_v2(
                        &mut enc,
                        &mut probs,
                        &mut counts,
                        &layout,
                        cfg,
                        zero_lon,
                        mag_lon,
                        layout.sign_lon_base,
                        false,
                        true,
                        pred_dt,
                        e_lon,
                        st.lon.e_prev,
                        vlon_prev,
                        st.lon.last_nz_sign,
                        st.lon.last_nz_is1,
                        st.lon.zero_gap,
                        false,
                        lon_bits,
                    )?;

                    let (zero_alt, mag_alt) =
                        select_alt_ctx(&layout, cfg, &st.alt, dchg, e_lat, e_lon);
                    let alt_force_nz = match cfg.joint_zero {
                        JointZeroMode::AllZero4 => e_dt == 0 && e_lat == 0 && e_lon == 0,
                        JointZeroMode::DtThenAllZero3 => e_lat == 0 && e_lon == 0,
                        JointZeroMode::None => false,
                    };
                    let alt_bits = stats.as_deref_mut().map(|s| &mut s.alt_bits);
                    encode_residual_v2(
                        &mut enc,
                        &mut probs,
                        &mut counts,
                        &layout,
                        cfg,
                        zero_alt,
                        mag_alt,
                        layout.sign_alt_base,
                        false,
                        false,
                        pred_dt,
                        e_alt,
                        st.alt.e_prev,
                        st.alt.v_prev,
                        st.alt.last_nz_sign,
                        st.alt.last_nz_is1,
                        st.alt.zero_gap,
                        alt_force_nz,
                        alt_bits,
                    )?;
                }
            }

            if dt_cur == dt_prev && dt_cur > 0 {
                st.dt_base = dt_cur;
            }
            st.dt_prev3 = st.dt_prev2;
            st.dt_prev2 = dt_prev;
            st.dt_prev = dt_cur;
            st.t_prev = t_cur;
            st.e_dt_prev = e_dt;
            update_coord_axis(&mut st.lat, q.lat[i], e_lat, cfg.act_mode);
            update_coord_axis(&mut st.lon, q.lon[i], e_lon, cfg.act_mode);
            update_alt_v2(&mut st.alt, q.alt[i], dt_prev, dt_cur, e_alt, cfg.alt_pred, cfg.act_mode);
        }
        carried = Some(st);

        let coded = enc.finish();
        payload.extend_from_slice(&coded);
        let c = crc32(&payload);
        entries.push(Gpsl0BlockEntry {
            start_ts: q.t[start] as u32,
            end_ts: q.t[start + count - 1] as u32,
            point_count: count as u32,
            byte_offset: 0,
            byte_length: payload.len() as u32,
            crc32: c,
        });
        payloads.push(payload);
    }

    let payload_bytes: usize = payloads.iter().map(|p| p.len()).sum();
    let index_bytes = if cfg.compact_container {
        encode_v2_block_index(&entries)
    } else {
        vec![0u8; entries.len() * 24]
    };

    let hdr_size = if cfg.compact_container {
        HEADER_SIZE_V2
    } else {
        48
    };
    let total_size = hdr_size + index_bytes.len() + payload_bytes;
    if let Some(sb) = stats {
        sb.container_bytes += hdr_size + index_bytes.len();
        sb.payload_bytes += payload_bytes;
        sb.total_bits += (total_size as f64) * 8.0;
    }

    let mut out = vec![0u8; total_size];
    let mut off = hdr_size + index_bytes.len();
    for (i, p) in payloads.iter().enumerate() {
        entries[i].byte_offset = off as u32;
        out[off..off + p.len()].copy_from_slice(p);
        off += p.len();
    }

    out[hdr_size..hdr_size + index_bytes.len()].copy_from_slice(&index_bytes);
    let index_crc32 = crc32(&out[hdr_size..hdr_size + index_bytes.len()]);

    if cfg.compact_container {
        let header_coord_mode: u8 = match cfg.coord_pred {
            CoordPredV2::Tn => 0,
            CoordPredV2::Naive => 1,
            CoordPredV2::TnClamped | CoordPredV2::Q1SpikeDamped => 2,
            CoordPredV2::D1 => 3,
        };
        write_v2_header(
            &mut out,
            &Gpsl0HeaderV2 {
                version: 2,
                tier0: q.coord_quantum == 1,
                has_alt: true,
                alt_damped: !matches!(cfg.alt_pred, AltPredV2::D1),
                coord_mode: header_coord_mode,
                coord_quantum: q.coord_quantum,
                alt_quantum: q.alt_quantum,
                n_points: n as u32,
                block_points,
                sync_blocks,
                n_blocks: n_blocks as u32,
                model_id: opts.model_id.unwrap_or(MODEL_ID_V3),
                header_crc32: 0,
                index_crc32,
            },
        );
    }

    Ok(out)
}

#[cfg(feature = "decode")]
#[allow(clippy::too_many_arguments)]
fn decode_one_block_v2(
    payload: &[u8],
    point_count: usize,
    cq: i64,
    layout: &LayoutV2,
    cfg: &V2Config,
    probs: &mut [u16],
    counts: &mut [u8],
    out_t: &mut [i32],
    out_lat: &mut [i32],
    out_lon: &mut [i32],
    out_alt: &mut [i32],
    out_offset: usize,
    sync: bool,
    carried: Option<V2State>,
) -> Result<V2State, Gpsl0Error> {
    let (mut st, j_start, rc_off) = if sync {
        let (s, pos) = read_seed_v2(payload, point_count, cfg.compact_container)?;
        out_t[out_offset] = s.t_prev.wrapping_sub(s.dt_prev);
        out_lat[out_offset] = s.lat.x_prev2;
        out_lon[out_offset] = s.lon.x_prev2;
        out_alt[out_offset] = s.alt.x_prev2;
        if point_count >= 2 {
            out_t[out_offset + 1] = s.t_prev;
            out_lat[out_offset + 1] = s.lat.x_prev;
            out_lon[out_offset + 1] = s.lon.x_prev;
            out_alt[out_offset + 1] = s.alt.x_prev;
        }
        (s, 2, pos)
    } else {
        let s = carried.ok_or_else(|| {
            Gpsl0Error::InvalidInput("continuation block without carried state".into())
        })?;
        (s, 0, 0)
    };

    let mut dec = RangeDecoderV2::new(&payload[rc_off..], cfg.rc)?;
    for j in j_start..point_count {
        let dt_prev = st.dt_prev;
        let pred_dt = st.predict_dt(cfg.dt_pred);
        let vlat_prev = st.lat.x_prev.wrapping_sub(st.lat.x_prev2);
        let vlon_prev = st.lon.x_prev.wrapping_sub(st.lon.x_prev2);
        let stationary = usize::from(vlat_prev == 0 && vlon_prev == 0);

        let mut all_zero4 = false;
        if cfg.joint_zero == JointZeroMode::AllZero4 {
            let dt_steady = usize::from(dt_prev == 1);
            let az_slot = layout.all_zero_base
                + (run_bucket5(st.zero_run) * 2 + stationary) * 2
                + dt_steady;
            if dec.decode_bit(probs, counts, az_slot, layout.slot_kinds[az_slot])? == 1 {
                all_zero4 = true;
                st.zero_run = st.zero_run.saturating_add(1);
            } else {
                st.zero_run = 0;
            }
        }

        let (e_dt, dt_cur, t_cur, e_lat, lat_cur, e_lon, lon_cur, e_alt, alt_cur) = if all_zero4 {
            let dt_cur = pred_dt;
            let t_cur = st.t_prev.wrapping_add(dt_cur);
            let lat_cur = predict_coord_axis(&st.lat, dt_prev, dt_cur, cq, cfg.coord_pred) as i32;
            let lon_cur = predict_coord_axis(&st.lon, dt_prev, dt_cur, cq, cfg.coord_pred) as i32;
            let alt_cur = predict_alt_v2(&st.alt, dt_prev, dt_cur, cfg.alt_pred) as i32;
            (0, dt_cur, t_cur, 0, lat_cur, 0, lon_cur, 0, alt_cur)
        } else {
            let (zero_dt, mag_dt) = select_dt_ctx(layout, cfg, pred_dt, st.e_dt_prev);
            let e_dt = decode_residual_v2(
                &mut dec,
                probs,
                counts,
                layout,
                cfg,
                zero_dt,
                mag_dt,
                layout.sign_dt_base,
                true,
                false,
                pred_dt,
                st.e_dt_prev,
                dt_prev,
                0,
                false,
                2,
                false,
            )?;
            let dt_cur = pred_dt.wrapping_add(e_dt);
            let t_cur = st.t_prev.wrapping_add(dt_cur);
            let dchg = st.dchg_flag(dt_cur, e_dt, cfg.dchg_mode);

            let mut all_zero3 = false;
            if cfg.joint_zero == JointZeroMode::DtThenAllZero3 {
                let az_slot = layout.all_zero_base
                    + (run_bucket4(st.zero_run) * 2 + stationary) * 2
                    + dchg;
                if dec.decode_bit(probs, counts, az_slot, layout.slot_kinds[az_slot])? == 1 {
                    all_zero3 = true;
                    st.zero_run = st.zero_run.saturating_add(1);
                } else {
                    st.zero_run = 0;
                }
            }

            if all_zero3 {
                let lat_cur =
                    predict_coord_axis(&st.lat, dt_prev, dt_cur, cq, cfg.coord_pred) as i32;
                let lon_cur =
                    predict_coord_axis(&st.lon, dt_prev, dt_cur, cq, cfg.coord_pred) as i32;
                let alt_cur = predict_alt_v2(&st.alt, dt_prev, dt_cur, cfg.alt_pred) as i32;
                (e_dt, dt_cur, t_cur, 0, lat_cur, 0, lon_cur, 0, alt_cur)
            } else {
                let (zero_lat, mag_lat) = select_lat_ctx(
                    layout,
                    cfg,
                    pred_dt,
                    dt_prev,
                    &st.lat,
                    &st.lon,
                    vlat_prev,
                    stationary,
                    dchg,
                );
                let e_lat = decode_residual_v2(
                    &mut dec,
                    probs,
                    counts,
                    layout,
                    cfg,
                    zero_lat,
                    mag_lat,
                    layout.sign_lat_base,
                    false,
                    true,
                    pred_dt,
                    st.lat.e_prev,
                    vlat_prev,
                    st.lat.last_nz_sign,
                    st.lat.last_nz_is1,
                    st.lat.zero_gap,
                    false,
                )?;
                let lat_cur = (predict_coord_axis(&st.lat, dt_prev, dt_cur, cq, cfg.coord_pred)
                    + (e_lat as i64)) as i32;

                let (zero_lon, mag_lon) = select_lon_ctx(
                    layout,
                    cfg,
                    pred_dt,
                    dt_prev,
                    &st.lon,
                    vlon_prev,
                    dchg,
                    e_lat,
                );
                let e_lon = decode_residual_v2(
                    &mut dec,
                    probs,
                    counts,
                    layout,
                    cfg,
                    zero_lon,
                    mag_lon,
                    layout.sign_lon_base,
                    false,
                    true,
                    pred_dt,
                    st.lon.e_prev,
                    vlon_prev,
                    st.lon.last_nz_sign,
                    st.lon.last_nz_is1,
                    st.lon.zero_gap,
                    false,
                )?;
                let lon_cur = (predict_coord_axis(&st.lon, dt_prev, dt_cur, cq, cfg.coord_pred)
                    + (e_lon as i64)) as i32;

                let (zero_alt, mag_alt) =
                    select_alt_ctx(layout, cfg, &st.alt, dchg, e_lat, e_lon);
                let alt_force_nz = match cfg.joint_zero {
                    JointZeroMode::AllZero4 => e_dt == 0 && e_lat == 0 && e_lon == 0,
                    JointZeroMode::DtThenAllZero3 => e_lat == 0 && e_lon == 0,
                    JointZeroMode::None => false,
                };
                let e_alt = decode_residual_v2(
                    &mut dec,
                    probs,
                    counts,
                    layout,
                    cfg,
                    zero_alt,
                    mag_alt,
                    layout.sign_alt_base,
                    false,
                    false,
                    pred_dt,
                    st.alt.e_prev,
                    st.alt.v_prev,
                    st.alt.last_nz_sign,
                    st.alt.last_nz_is1,
                    st.alt.zero_gap,
                    alt_force_nz,
                )?;
                let alt_cur =
                    (predict_alt_v2(&st.alt, dt_prev, dt_cur, cfg.alt_pred) + (e_alt as i64)) as i32;
                (e_dt, dt_cur, t_cur, e_lat, lat_cur, e_lon, lon_cur, e_alt, alt_cur)
            }
        };

        out_t[out_offset + j] = t_cur;
        out_lat[out_offset + j] = lat_cur;
        out_lon[out_offset + j] = lon_cur;
        out_alt[out_offset + j] = alt_cur;

        if dt_cur == dt_prev && dt_cur > 0 {
            st.dt_base = dt_cur;
        }
        st.dt_prev3 = st.dt_prev2;
        st.dt_prev2 = dt_prev;
        st.dt_prev = dt_cur;
        st.t_prev = t_cur;
        st.e_dt_prev = e_dt;
        update_coord_axis(&mut st.lat, lat_cur, e_lat, cfg.act_mode);
        update_coord_axis(&mut st.lon, lon_cur, e_lon, cfg.act_mode);
        update_alt_v2(&mut st.alt, alt_cur, dt_prev, dt_cur, e_alt, cfg.alt_pred, cfg.act_mode);
    }

    Ok(st)
}

#[cfg(feature = "decode")]
pub fn decode_v2_with_config(bytes: &[u8], cfg: &V2Config) -> Result<DecodedTrack, Gpsl0Error> {
    let header = read_v2_header(bytes)?;
    let (block_index, _) = read_v2_block_index(bytes, &header)?;
    let n = header.n_points as usize;
    let mut t = vec![0i32; n];
    let mut lat = vec![0i32; n];
    let mut lon = vec![0i32; n];
    let mut alt = vec![0i32; n];

    let meta = Gpsl0Meta {
        version: header.version,
        tier0: header.tier0,
        has_alt: header.has_alt,
        alt_damped: header.alt_damped,
        coord_mode: header.coord_mode,
        coord_quantum: header.coord_quantum,
        alt_quantum: header.alt_quantum,
        n_points: header.n_points,
        block_points: header.block_points,
        sync_blocks: header.sync_blocks,
        n_blocks: header.n_blocks,
        model_id: header.model_id,
        header_crc32: header.header_crc32,
        index_crc32: header.index_crc32,
        block_index: block_index.clone(),
        byte_length: bytes.len(),
    };
    if n == 0 {
        return Ok(DecodedTrack {
            t,
            lat,
            lon,
            alt,
            meta,
        });
    }

    let layout = LayoutV2::from_config(cfg);
    let cq = header.coord_quantum as i64;
    let mut probs = init_probs_v2(&layout, cfg);
    let mut counts = vec![0u8; layout.total_slots];
    let mut state: Option<V2State> = None;
    let mut point_off = 0usize;

    for (b, entry) in block_index.iter().enumerate() {
        let sync = is_sync_block(b, header.sync_blocks);
        let sb = entry.byte_offset as usize;
        let eb = sb + (entry.byte_length as usize);
        let payload = &bytes[sb..eb];
        if crc32(payload) != entry.crc32 {
            return Err(Gpsl0Error::CrcMismatch(format!(
                "block {b} payload crc mismatch"
            )));
        }
        if sync {
            if b > 0 {
                probs = init_probs_v2(&layout, cfg);
                counts.fill(0);
            }
            state = None;
        }
        state = Some(decode_one_block_v2(
            payload,
            entry.point_count as usize,
            cq,
            &layout,
            cfg,
            &mut probs,
            &mut counts,
            &mut t,
            &mut lat,
            &mut lon,
            &mut alt,
            point_off,
            sync,
            state,
        )?);
        point_off += entry.point_count as usize;
    }

    let cq32 = header.coord_quantum as i32;
    let aq32 = header.alt_quantum as i32;
    if cq32 != 1 {
        for v in &mut lat {
            *v = v.wrapping_mul(cq32);
        }
        for v in &mut lon {
            *v = v.wrapping_mul(cq32);
        }
    }
    if aq32 != 1 {
        for v in &mut alt {
            *v = v.wrapping_mul(aq32);
        }
    }

    Ok(DecodedTrack {
        t,
        lat,
        lon,
        alt,
        meta,
    })
}

#[cfg(feature = "decode")]
fn config_for_decode(header: &Gpsl0HeaderV2) -> Result<V2Config, Gpsl0Error> {
    if header.model_id != MODEL_ID_V3 {
        return Err(Gpsl0Error::UnsupportedModel(header.model_id));
    }
    let coord_pred = match header.coord_mode {
        0 => CoordPredV2::Tn,
        1 => CoordPredV2::Naive,
        2 => CoordPredV2::Q1SpikeDamped,
        3 => CoordPredV2::D1,
        m => {
            return Err(Gpsl0Error::CorruptHeader(format!(
                "unknown v2 coord_mode {m}"
            )))
        }
    };
    let alt_pred = if header.alt_damped {
        AltPredV2::AlphaBeta(230, 77)
    } else {
        AltPredV2::D1
    };
    Ok(V2Config::v3(
        header.coord_quantum,
        coord_pred,
        alt_pred,
        header.block_points,
    ))
}

/// GPSL0 v3 encoder (`version = 2`, `model_id = 22`).
/// Routes all inputs through the `#![no_std]` bit-exact streaming encoder path.
pub fn encode_v2(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &EncodeOptions,
) -> Result<Vec<u8>, Gpsl0Error> {
    let model_id = opts.model_id.unwrap_or(MODEL_ID_V3);
    if model_id != MODEL_ID_V3 {
        return Err(Gpsl0Error::UnsupportedModel(model_id));
    }
    let n = t.len();
    if lat.len() != n || lon.len() != n || alt.len() != n {
        return Err(Gpsl0Error::InvalidInput(
            "t/lat/lon/alt arrays must have equal length".into(),
        ));
    }
    let mut scan = QuantumScanner::new();
    for i in 0..n {
        scan.push_point(t[i], lat[i], lon[i], alt[i]);
    }
    let (coord_quantum, coord_exact) = match opts.coord_quantum {
        QuantumSpec::Auto => (scan.coord_quantum(), true),
        QuantumSpec::Fixed(q) => (q, false),
    };
    if coord_quantum < 1 || coord_quantum > 10_000_000 || 10_000_000 % coord_quantum != 0 {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad coord quantum {coord_quantum}"
        )));
    }
    let (alt_quantum, alt_exact) = match opts.alt_quantum {
        QuantumSpec::Auto => (scan.alt_quantum(), true),
        QuantumSpec::Fixed(q) => (q, false),
    };
    if alt_quantum < 1 || 10 % alt_quantum != 0 {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad alt quantum {alt_quantum}"
        )));
    }
    let block_points = opts.block_points.unwrap_or(32768);
    if block_points < 2 || block_points > (1 << 20) {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad block_points {block_points}"
        )));
    }
    let alt_mode = opts.alt_mode.unwrap_or(if alt_quantum >= 5 {
        AltMode::D1
    } else {
        AltMode::Damped
    });
    let base_opts = StreamV3Options {
        coord_quantum,
        coord_exact,
        alt_quantum,
        alt_exact,
        block_points,
        sync_blocks: opts.sync_blocks,
        coord_mode: opts.coord_mode.unwrap_or(CoordMode::TnClamped),
        alt_mode,
    };

    if opts.coord_mode.is_some() || n == 0 {
        return encode_v3_streaming_to_vec(t, lat, lon, alt, &base_opts);
    }
    let b_tn = encode_v3_streaming_to_vec(t, lat, lon, alt, &base_opts)?;
    if scan.should_try_d1() {
        let d1_opts = StreamV3Options {
            coord_mode: CoordMode::D1,
            ..base_opts
        };
        let b_d1 = encode_v3_streaming_to_vec(t, lat, lon, alt, &d1_opts)?;
        if b_d1.len() < b_tn.len() {
            return Ok(b_d1);
        }
    }
    Ok(b_tn)
}

#[cfg(feature = "decode")]
pub fn inspect_v2_header(bytes: &[u8]) -> Result<Gpsl0Meta, Gpsl0Error> {
    let header = read_v2_header(bytes)?;
    let _ = config_for_decode(&header)?;
    let (block_index, _) = read_v2_block_index(bytes, &header)?;
    Ok(Gpsl0Meta {
        version: header.version,
        tier0: header.tier0,
        has_alt: header.has_alt,
        alt_damped: header.alt_damped,
        coord_mode: header.coord_mode,
        coord_quantum: header.coord_quantum,
        alt_quantum: header.alt_quantum,
        n_points: header.n_points,
        block_points: header.block_points,
        sync_blocks: header.sync_blocks,
        n_blocks: header.n_blocks,
        model_id: header.model_id,
        header_crc32: header.header_crc32,
        index_crc32: header.index_crc32,
        block_index,
        byte_length: bytes.len(),
    })
}

#[cfg(feature = "decode")]
pub fn decode_v2(bytes: &[u8]) -> Result<DecodedTrack, Gpsl0Error> {
    let header = read_v2_header(bytes)?;
    let cfg = config_for_decode(&header)?;
    decode_v2_with_config(bytes, &cfg)
}

#[cfg(feature = "decode")]
pub fn decode_v2_window(
    bytes: &[u8],
    start_point: usize,
    len: usize,
) -> Result<DecodedTrack, Gpsl0Error> {
    let header = read_v2_header(bytes)?;
    let cfg = config_for_decode(&header)?;
    let (block_index, _) = read_v2_block_index(bytes, &header)?;

    if len < 1 {
        return Err(Gpsl0Error::BadWindow("len must be >= 1".into()));
    }
    let end_point = start_point
        .checked_add(len)
        .ok_or_else(|| Gpsl0Error::BadWindow("window overflow".into()))?;
    if end_point > header.n_points as usize {
        return Err(Gpsl0Error::BadWindow(format!(
            "window [{start_point}, {end_point}) outside 0..{}",
            header.n_points
        )));
    }

    let mut first_block = 0usize;
    let mut acc = 0usize;
    while first_block < block_index.len()
        && acc + (block_index[first_block].point_count as usize) <= start_point
    {
        acc += block_index[first_block].point_count as usize;
        first_block += 1;
    }

    let sync_start_block = if header.sync_blocks > 0 {
        let sb = header.sync_blocks as usize;
        (first_block / sb) * sb
    } else {
        0
    };
    let sync_point_start: usize = block_index[..sync_start_block]
        .iter()
        .map(|e| e.point_count as usize)
        .sum();

    let mut last_block = first_block;
    let mut acc_end = acc;
    while last_block < block_index.len() {
        acc_end += block_index[last_block].point_count as usize;
        if acc_end >= end_point {
            break;
        }
        last_block += 1;
    }
    let replay_points = acc_end - sync_point_start;

    let mut t_buf = vec![0i32; replay_points];
    let mut lat_buf = vec![0i32; replay_points];
    let mut lon_buf = vec![0i32; replay_points];
    let mut alt_buf = vec![0i32; replay_points];

    let layout = LayoutV2::from_config(&cfg);
    let cq = header.coord_quantum as i64;
    let mut probs = init_probs_v2(&layout, &cfg);
    let mut counts = vec![0u8; layout.total_slots];
    let mut state: Option<V2State> = None;
    let mut buf_off = 0usize;

    for (b, entry) in block_index
        .iter()
        .enumerate()
        .skip(sync_start_block)
        .take(last_block - sync_start_block + 1)
    {
        let sync = is_sync_block(b, header.sync_blocks);
        if sync {
            probs = init_probs_v2(&layout, &cfg);
            counts.fill(0);
            state = None;
        }
        let sb = entry.byte_offset as usize;
        let eb = sb + (entry.byte_length as usize);
        let payload = &bytes[sb..eb];
        if crc32(payload) != entry.crc32 {
            return Err(Gpsl0Error::CrcMismatch(format!(
                "block {b} payload crc mismatch"
            )));
        }
        state = Some(decode_one_block_v2(
            payload,
            entry.point_count as usize,
            cq,
            &layout,
            &cfg,
            &mut probs,
            &mut counts,
            &mut t_buf,
            &mut lat_buf,
            &mut lon_buf,
            &mut alt_buf,
            buf_off,
            sync,
            state,
        )?);
        buf_off += entry.point_count as usize;
    }

    let rel_start = start_point - sync_point_start;
    let rel_end = rel_start + len;
    let t = t_buf[rel_start..rel_end].to_vec();
    let mut lat = lat_buf[rel_start..rel_end].to_vec();
    let mut lon = lon_buf[rel_start..rel_end].to_vec();
    let mut alt = alt_buf[rel_start..rel_end].to_vec();

    let cq32 = header.coord_quantum as i32;
    let aq32 = header.alt_quantum as i32;
    if cq32 != 1 {
        for v in &mut lat {
            *v = v.wrapping_mul(cq32);
        }
        for v in &mut lon {
            *v = v.wrapping_mul(cq32);
        }
    }
    if aq32 != 1 {
        for v in &mut alt {
            *v = v.wrapping_mul(aq32);
        }
    }

    Ok(DecodedTrack {
        t,
        lat,
        lon,
        alt,
        meta: Gpsl0Meta {
            version: header.version,
            tier0: header.tier0,
            has_alt: header.has_alt,
            alt_damped: header.alt_damped,
            coord_mode: header.coord_mode,
            coord_quantum: header.coord_quantum,
            alt_quantum: header.alt_quantum,
            n_points: header.n_points,
            block_points: header.block_points,
            sync_blocks: header.sync_blocks,
            n_blocks: header.n_blocks,
            model_id: header.model_id,
            header_crc32: header.header_crc32,
            index_crc32: header.index_crc32,
            block_index,
            byte_length: bytes.len(),
        },
    })
}

/// Collect both full per-slot priors and compact generic role priors (~16 constants).
pub fn collect_priors_v2(
    tracks: &[(&[i32], &[i32], &[i32], &[i32])],
    opts: &EncodeOptions,
    cfg: &V2Config,
) -> Result<(Vec<u16>, Vec<u16>), Gpsl0Error> {
    let layout = LayoutV2::from_config(cfg);
    let mut ones = vec![0u64; layout.total_slots];
    let mut totals = vec![0u64; layout.total_slots];

    #[inline]
    fn bump(totals: &mut [u64], ones: &mut [u64], idx: usize, bit: u8) {
        totals[idx] += 1;
        ones[idx] += bit as u64;
    }

    #[allow(clippy::too_many_arguments)]
    fn count_res(
        totals: &mut [u64],
        ones: &mut [u64],
        layout: &LayoutV2,
        cfg: &V2Config,
        zero_idx: usize,
        mag_base: usize,
        sign_base: usize,
        is_dt: bool,
        is_coord: bool,
        pred_dt: i32,
        e: i32,
        e_prev: i32,
        v_prev: i32,
        last_nz_sign: i8,
        last_nz_is1: bool,
        zero_gap: u8,
        force_nz: bool,
    ) {
        if e == 0 {
            if !force_nz {
                bump(totals, ones, zero_idx, 0);
            }
            return;
        }
        if !force_nz {
            bump(totals, ones, zero_idx, 1);
        }
        let u = e.unsigned_abs();
        let m = (31 - u.leading_zeros()) as usize;
        if m >= UNARY_SLOTS_V2 {
            for t in 0..UNARY_SLOTS_V2 {
                bump(totals, ones, mag_base + t, 1);
            }
        } else {
            for t in 0..m {
                bump(totals, ones, mag_base + t, 1);
            }
            bump(totals, ones, mag_base + m, 0);
            if m == 1 && cfg.dedicated_m1 {
                bump(totals, ones, mag_base + layout.m1_slot, (u & 1) as u8);
            } else if matches!(
                cfg.bin_mode,
                BinMode::SignMagMsbTree4 | BinMode::SignMagMsbTree3
            ) {
                let mut prefix = 0usize;
                for step in 0..m {
                    let k = m - 1 - step;
                    let bit = ((u >> k) & 1) as u8;
                    if cfg.bypass_from.is_some_and(|bf| step >= bf) {
                        continue;
                    }
                    if step < layout.tree_bits {
                        let node = layout.tree_base + ((1usize << step) - 1) + prefix;
                        bump(totals, ones, mag_base + node, bit);
                        prefix = (prefix << 1) | (bit as usize);
                    } else {
                        bump(
                            totals,
                            ones,
                            mag_base + layout.flat_base + (step - layout.tree_bits),
                            bit,
                        );
                    }
                }
            }
        }
        let (ss, sb) = sign_slot_and_bit_encode(
            cfg,
            sign_base,
            is_dt,
            is_coord,
            e,
            u,
            pred_dt,
            e_prev,
            v_prev,
            last_nz_sign,
            last_nz_is1,
            zero_gap,
        );
        bump(totals, ones, ss, sb);
    }

    for &(t, lat, lon, alt) in tracks {
        let n = t.len();
        if n < 3 {
            continue;
        }
        let q = quantize_points(t, lat, lon, alt, opts)?;
        let cq = q.coord_quantum as i64;
        let dt0 = q.t[1].wrapping_sub(q.t[0]);
        let mut st = V2State {
            t_prev: q.t[1],
            dt_prev: dt0,
            dt_prev2: dt0,
            dt_prev3: dt0,
            dt_base: dt0,
            lat: AxisPredState::new(q.lat[0], q.lat[1], dt0),
            lon: AxisPredState::new(q.lon[0], q.lon[1], dt0),
            alt: AxisPredState::new(q.alt[0], q.alt[1], dt0),
            e_dt_prev: 0,
            zero_run: 0,
        };
        for i in 2..n {
            let dt_prev = st.dt_prev;
            let t_cur = q.t[i];
            let dt_cur = t_cur.wrapping_sub(st.t_prev);
            let pred_dt = st.predict_dt(cfg.dt_pred);
            let e_dt = dt_cur.wrapping_sub(pred_dt);
            let dchg = st.dchg_flag(dt_cur, e_dt, cfg.dchg_mode);
            let vlat_prev = st.lat.x_prev.wrapping_sub(st.lat.x_prev2);
            let vlon_prev = st.lon.x_prev.wrapping_sub(st.lon.x_prev2);
            let stationary = usize::from(vlat_prev == 0 && vlon_prev == 0);
            let pred_lat = predict_coord_axis(&st.lat, dt_prev, dt_cur, cq, cfg.coord_pred);
            let pred_lon = predict_coord_axis(&st.lon, dt_prev, dt_cur, cq, cfg.coord_pred);
            let pred_alt = predict_alt_v2(&st.alt, dt_prev, dt_cur, cfg.alt_pred);
            let e_lat = ((q.lat[i] as i64) - pred_lat) as i32;
            let e_lon = ((q.lon[i] as i64) - pred_lon) as i32;
            let e_alt = ((q.alt[i] as i64) - pred_alt) as i32;

            let mut skip_all = false;
            if cfg.joint_zero == JointZeroMode::AllZero4 {
                let az = u8::from(e_dt == 0 && e_lat == 0 && e_lon == 0 && e_alt == 0);
                let az_slot = layout.all_zero_base
                    + (run_bucket5(st.zero_run) * 2 + stationary) * 2
                    + usize::from(dt_prev == 1);
                bump(&mut totals, &mut ones, az_slot, az);
                if az == 1 {
                    st.zero_run = st.zero_run.saturating_add(1);
                    skip_all = true;
                } else {
                    st.zero_run = 0;
                }
            }
            if !skip_all {
                let (zero_dt, mag_dt) = select_dt_ctx(&layout, cfg, pred_dt, st.e_dt_prev);
                count_res(
                    &mut totals,
                    &mut ones,
                    &layout,
                    cfg,
                    zero_dt,
                    mag_dt,
                    layout.sign_dt_base,
                    true,
                    false,
                    pred_dt,
                    e_dt,
                    st.e_dt_prev,
                    dt_prev,
                    0,
                    false,
                    2,
                    false,
                );
                let mut skip_coords = false;
                if cfg.joint_zero == JointZeroMode::DtThenAllZero3 {
                    let az3 = u8::from(e_lat == 0 && e_lon == 0 && e_alt == 0);
                    let az_slot = layout.all_zero_base
                        + (run_bucket4(st.zero_run) * 2 + stationary) * 2
                        + dchg;
                    bump(&mut totals, &mut ones, az_slot, az3);
                    if az3 == 1 {
                        st.zero_run = st.zero_run.saturating_add(1);
                        skip_coords = true;
                    } else {
                        st.zero_run = 0;
                    }
                }
                if !skip_coords {
                    let (zero_lat, mag_lat) = select_lat_ctx(
                        &layout,
                        cfg,
                        pred_dt,
                        dt_prev,
                        &st.lat,
                        &st.lon,
                        vlat_prev,
                        stationary,
                        dchg,
                    );
                    count_res(
                        &mut totals,
                        &mut ones,
                        &layout,
                        cfg,
                        zero_lat,
                        mag_lat,
                        layout.sign_lat_base,
                        false,
                        true,
                        pred_dt,
                        e_lat,
                        st.lat.e_prev,
                        vlat_prev,
                        st.lat.last_nz_sign,
                        st.lat.last_nz_is1,
                        st.lat.zero_gap,
                        false,
                    );
                    let (zero_lon, mag_lon) = select_lon_ctx(
                        &layout,
                        cfg,
                        pred_dt,
                        dt_prev,
                        &st.lon,
                        vlon_prev,
                        dchg,
                        e_lat,
                    );
                    count_res(
                        &mut totals,
                        &mut ones,
                        &layout,
                        cfg,
                        zero_lon,
                        mag_lon,
                        layout.sign_lon_base,
                        false,
                        true,
                        pred_dt,
                        e_lon,
                        st.lon.e_prev,
                        vlon_prev,
                        st.lon.last_nz_sign,
                        st.lon.last_nz_is1,
                        st.lon.zero_gap,
                        false,
                    );
                    let (zero_alt, mag_alt) =
                        select_alt_ctx(&layout, cfg, &st.alt, dchg, e_lat, e_lon);
                    let afnz = match cfg.joint_zero {
                        JointZeroMode::AllZero4 => e_dt == 0 && e_lat == 0 && e_lon == 0,
                        JointZeroMode::DtThenAllZero3 => e_lat == 0 && e_lon == 0,
                        JointZeroMode::None => false,
                    };
                    count_res(
                        &mut totals,
                        &mut ones,
                        &layout,
                        cfg,
                        zero_alt,
                        mag_alt,
                        layout.sign_alt_base,
                        false,
                        false,
                        pred_dt,
                        e_alt,
                        st.alt.e_prev,
                        st.alt.v_prev,
                        st.alt.last_nz_sign,
                        st.alt.last_nz_is1,
                        st.alt.zero_gap,
                        afnz,
                    );
                }
            }

            if dt_cur == dt_prev && dt_cur > 0 {
                st.dt_base = dt_cur;
            }
            st.dt_prev3 = st.dt_prev2;
            st.dt_prev2 = dt_prev;
            st.dt_prev = dt_cur;
            st.t_prev = t_cur;
            st.e_dt_prev = e_dt;
            update_coord_axis(&mut st.lat, q.lat[i], e_lat, cfg.act_mode);
            update_coord_axis(&mut st.lon, q.lon[i], e_lon, cfg.act_mode);
            update_alt_v2(&mut st.alt, q.alt[i], dt_prev, dt_cur, e_alt, cfg.alt_pred, cfg.act_mode);
        }
    }

    let scale = cfg.rc.prob_scale() as u64;
    let init = cfg.rc.prob_init() as u64;
    let min_p = cfg.rc.min_prob.max(1) as u64;
    let max_p = scale - min_p;
    let pseudo = 16u64;

    let mut per_slot = Vec::with_capacity(layout.total_slots);
    for i in 0..layout.total_slots {
        let tot = totals[i];
        let zeros = tot - ones[i];
        let p = ((zeros * scale + pseudo * init) / (tot + pseudo)).clamp(min_p, max_p);
        per_slot.push(p as u16);
    }

    let mut role_tot = [0u64; 16];
    let mut role_one = [0u64; 16];
    let role_idx = |r: PriorRole| -> usize {
        match r {
            PriorRole::AllZero3(k) => k.min(3),
            PriorRole::DtZero => 4,
            PriorRole::CoordZero => 5,
            PriorRole::AltZero => 6,
            PriorRole::Unary(t) => 7 + t.min(4),
            PriorRole::MantBit => 12,
            PriorRole::SignDt => 13,
            PriorRole::SignGap0 => 14,
            PriorRole::SignGap1 | PriorRole::SignGap2 | PriorRole::SignNeutral => 15,
        }
    };
    for i in 0..layout.total_slots {
        let ri = role_idx(layout.slot_roles[i]);
        role_tot[ri] += totals[i];
        role_one[ri] += ones[i];
    }
    let mut role_vals = [init as u16; 16];
    for r in 0..16 {
        let tot = role_tot[r];
        let zeros = tot - role_one[r];
        let p = ((zeros * scale + pseudo * init) / (tot + pseudo)).clamp(min_p, max_p);
        role_vals[r] = p as u16;
    }
    let mut role_priors = Vec::with_capacity(layout.total_slots);
    for i in 0..layout.total_slots {
        let ri = role_idx(layout.slot_roles[i]);
        role_priors.push(role_vals[ri]);
    }

    Ok((per_slot, role_priors))
}
