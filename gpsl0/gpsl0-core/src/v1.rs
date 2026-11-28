use alloc::{format, vec, vec::Vec};

use crate::container::{
    crc32, write_i32_le, write_u32_le, write_v1_header, Gpsl0BlockEntry, Gpsl0HeaderV1,
    HEADER_SIZE_V1, INDEX_ENTRY_SIZE_V1,
};
#[cfg(feature = "decode")]
use crate::container::{read_i32_le, read_v1_block_index, read_v1_header};
use crate::error::Gpsl0Error;
pub use crate::pred::{dt_bucket, predict_coord_v1, q1, round_div, unzigzag, zigzag, TN_CLAMP};
#[cfg(feature = "decode")]
use crate::rangecoder::RangeDecoderV1;
use crate::rangecoder::{RangeEncoderV1, PROB_INIT_V1};
use crate::{quantize_points, AltMode, CoordMode, DecodedTrack, EncodeOptions, Gpsl0Meta};

pub const ZERO_SLOT: usize = 0;
pub const UNARY_SLOT0: usize = 1;
pub const SEED_BYTES_V1: usize = 32;
pub const DEFAULT_MODEL_ID_V1: u32 = 7;

#[derive(Debug, Clone)]
pub struct ModelSpecV1 {
    pub id: u32,
    pub unary_slots: usize,
    pub mant_tree_bits: usize,
    pub speed_thresholds: &'static [i64],
    pub q_levels: usize,
    pub alt_levels: usize,
    pub lon_uses_lat_residual: bool,
    pub dt_levels: usize,
    pub coord_dt_changed: bool,
}

#[derive(Debug, Clone)]
pub struct ModelLayoutV1 {
    pub spec: ModelSpecV1,
    pub n_slot: usize,
    pub tree_base: usize,
    pub tree_nodes: usize,
    pub flat_base: usize,
    pub n_q1: usize,
    pub n_alt_q: usize,
    pub n_speed: usize,
    pub dt_ctx0: usize,
    pub lat_ctx0: usize,
    pub lon_ctx0: usize,
    pub alt_ctx0: usize,
    pub n_ctx: usize,
    pub coord_dt_changed: usize,
}

const THRESHOLDS_2: &[i64] = &[300, 2200];
const THRESHOLDS_5: &[i64] = &[300, 2200, 5500, 12000, 30000];
const THRESHOLDS_0: &[i64] = &[];

pub fn get_v1_spec(model_id: u32) -> Result<ModelSpecV1, Gpsl0Error> {
    let spec = match model_id {
        1 => ModelSpecV1 {
            id: 1,
            unary_slots: 24,
            mant_tree_bits: 0,
            speed_thresholds: THRESHOLDS_5,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        2 => ModelSpecV1 {
            id: 2,
            unary_slots: 24,
            mant_tree_bits: 3,
            speed_thresholds: THRESHOLDS_2,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        3 => ModelSpecV1 {
            id: 3,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_2,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        4 => ModelSpecV1 {
            id: 4,
            unary_slots: 24,
            mant_tree_bits: 5,
            speed_thresholds: THRESHOLDS_2,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        5 => ModelSpecV1 {
            id: 5,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_5,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        6 => ModelSpecV1 {
            id: 6,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_0,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: false,
        },
        7 => ModelSpecV1 {
            id: 7,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_0,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: true,
        },
        8 => ModelSpecV1 {
            id: 8,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_2,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: true,
        },
        9 => ModelSpecV1 {
            id: 9,
            unary_slots: 24,
            mant_tree_bits: 4,
            speed_thresholds: THRESHOLDS_0,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 6,
            coord_dt_changed: true,
        },
        10 => ModelSpecV1 {
            id: 10,
            unary_slots: 24,
            mant_tree_bits: 0,
            speed_thresholds: THRESHOLDS_0,
            q_levels: 8,
            alt_levels: 4,
            lon_uses_lat_residual: false,
            dt_levels: 5,
            coord_dt_changed: true,
        },
        _ => return Err(Gpsl0Error::UnsupportedModel(model_id)),
    };
    Ok(spec)
}

pub fn get_v1_layout(model_id: u32) -> Result<ModelLayoutV1, Gpsl0Error> {
    let spec = get_v1_spec(model_id)?;
    let tree_nodes = if spec.mant_tree_bits == 0 {
        0
    } else {
        (1usize << spec.mant_tree_bits) - 1
    };
    let tree_base = 1 + spec.unary_slots;
    let flat_base = tree_base + tree_nodes;
    let flat_slots = spec.unary_slots.saturating_sub(1 + spec.mant_tree_bits);
    let n_slot = flat_base + flat_slots;
    let n_q1 = 2 * spec.q_levels + 1;
    let n_alt_q = 2 * spec.alt_levels + 1;
    let n_speed = spec.speed_thresholds.len() + 1;
    let dchg = if spec.coord_dt_changed { 2 } else { 1 };
    let dt_count = spec.dt_levels * 2;
    let dt_ctx0 = 0;
    let lat_ctx0 = dt_ctx0 + dt_count;
    let lat_count = n_speed * n_q1 * dchg;
    let lon_ctx0 = lat_ctx0 + lat_count;
    let lon_count = if spec.lon_uses_lat_residual {
        n_speed * n_q1 * dchg * n_q1
    } else {
        n_speed * n_q1 * dchg
    };
    let alt_ctx0 = lon_ctx0 + lon_count;
    let alt_count = n_speed * n_alt_q;
    Ok(ModelLayoutV1 {
        spec,
        n_slot,
        tree_base,
        tree_nodes,
        flat_base,
        n_q1,
        n_alt_q,
        n_speed,
        dt_ctx0,
        lat_ctx0,
        lon_ctx0,
        alt_ctx0,
        n_ctx: alt_ctx0 + alt_count,
        coord_dt_changed: dchg,
    })
}

#[inline]
pub fn speed_regime(vlat: i32, vlon: i32, dt_prev: i32, thresholds: &[i64]) -> usize {
    if thresholds.is_empty() {
        return 0;
    }
    let sum = (vlat as i64).abs() + (vlon as i64).abs();
    let dt = if dt_prev > 0 { dt_prev as i64 } else { 1 };
    let mmps = (sum * 111) / dt;
    for (i, &t) in thresholds.iter().enumerate() {
        if mmps < t {
            return i;
        }
    }
    thresholds.len()
}

#[inline]
pub fn predict_alt_v1(x_prev2: i32, x_prev: i32, alt_mode: u8) -> i64 {
    let xp = x_prev as i64;
    if alt_mode == AltMode::Damped as u8 {
        return xp + (((xp) - (x_prev2 as i64)) >> 1);
    }
    xp
}

#[derive(Debug, Clone, Copy)]
struct BlockSeedV1 {
    t0: i32,
    lat0: i32,
    lon0: i32,
    alt0: i32,
    dt0: i32,
    vlat0: i32,
    vlon0: i32,
    valt0: i32,
}

#[derive(Debug, Clone, Copy)]
struct BlockStateV1 {
    t_prev2: i32,
    t_prev: i32,
    dt_prev: i32,
    lat_prev2: i32,
    lat_prev: i32,
    lon_prev2: i32,
    lon_prev: i32,
    alt_prev2: i32,
    alt_prev: i32,
    e_dt_prev: i32,
    e_lat_prev: i32,
    e_lon_prev: i32,
    e_alt_prev: i32,
}

fn make_seed(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    start: usize,
    count: usize,
) -> BlockSeedV1 {
    let has_two = count >= 2;
    BlockSeedV1 {
        t0: t[start],
        lat0: lat[start],
        lon0: lon[start],
        alt0: alt[start],
        dt0: if has_two { t[start + 1].wrapping_sub(t[start]) } else { 0 },
        vlat0: if has_two { lat[start + 1].wrapping_sub(lat[start]) } else { 0 },
        vlon0: if has_two { lon[start + 1].wrapping_sub(lon[start]) } else { 0 },
        valt0: if has_two { alt[start + 1].wrapping_sub(alt[start]) } else { 0 },
    }
}

fn write_seed(out: &mut [u8], s: &BlockSeedV1) {
    write_i32_le(out, 0, s.t0);
    write_i32_le(out, 4, s.lat0);
    write_i32_le(out, 8, s.lon0);
    write_i32_le(out, 12, s.alt0);
    write_i32_le(out, 16, s.dt0);
    write_i32_le(out, 20, s.vlat0);
    write_i32_le(out, 24, s.vlon0);
    write_i32_le(out, 28, s.valt0);
}

fn read_seed(bytes: &[u8]) -> BlockSeedV1 {
    BlockSeedV1 {
        t0: read_i32_le(bytes, 0),
        lat0: read_i32_le(bytes, 4),
        lon0: read_i32_le(bytes, 8),
        alt0: read_i32_le(bytes, 12),
        dt0: read_i32_le(bytes, 16),
        vlat0: read_i32_le(bytes, 20),
        vlon0: read_i32_le(bytes, 24),
        valt0: read_i32_le(bytes, 28),
    }
}

fn init_state(s: &BlockSeedV1) -> BlockStateV1 {
    BlockStateV1 {
        t_prev2: s.t0,
        t_prev: s.t0.wrapping_add(s.dt0),
        dt_prev: s.dt0,
        lat_prev2: s.lat0,
        lat_prev: s.lat0.wrapping_add(s.vlat0),
        lon_prev2: s.lon0,
        lon_prev: s.lon0.wrapping_add(s.vlon0),
        alt_prev2: s.alt0,
        alt_prev: s.alt0.wrapping_add(s.valt0),
        e_dt_prev: 0,
        e_lat_prev: 0,
        e_lon_prev: 0,
        e_alt_prev: 0,
    }
}

#[inline]
fn encode_residual_v1(
    enc: &mut RangeEncoderV1,
    probs: &mut [u16],
    layout: &ModelLayoutV1,
    ctx: usize,
    e: i32,
) -> Result<(), Gpsl0Error> {
    let base = ctx * layout.n_slot;
    let u = zigzag(e);
    if u == 0 {
        enc.encode_bit(probs, base + ZERO_SLOT, 0)?;
        return Ok(());
    }
    enc.encode_bit(probs, base + ZERO_SLOT, 1)?;
    let m = (31 - u.leading_zeros()) as usize;
    if m >= layout.spec.unary_slots {
        for t in 0..layout.spec.unary_slots {
            enc.encode_bit(probs, base + UNARY_SLOT0 + t, 1)?;
        }
        for k in (0..32).rev() {
            enc.encode_direct(((u >> k) & 1) as u8);
        }
        return Ok(());
    }
    for t in 0..m {
        enc.encode_bit(probs, base + UNARY_SLOT0 + t, 1)?;
    }
    enc.encode_bit(probs, base + UNARY_SLOT0 + m, 0)?;

    let tree_bits = layout.spec.mant_tree_bits;
    for k in 0..m {
        let bit = ((u >> k) & 1) as u8;
        if k < tree_bits {
            let node = layout.tree_base + ((1usize << k) - 1) + ((u as usize) & ((1usize << k) - 1));
            enc.encode_bit(probs, base + node, bit)?;
        } else {
            enc.encode_bit(probs, base + layout.flat_base + (k - tree_bits), bit)?;
        }
    }
    Ok(())
}

#[cfg(feature = "decode")]
#[inline]
fn decode_residual_v1(
    dec: &mut RangeDecoderV1<'_>,
    probs: &mut [u16],
    layout: &ModelLayoutV1,
    ctx: usize,
) -> Result<i32, Gpsl0Error> {
    let base = ctx * layout.n_slot;
    if dec.decode_bit(probs, base + ZERO_SLOT)? == 0 {
        return Ok(0);
    }
    let mut m = 0usize;
    while m < layout.spec.unary_slots {
        let bit = dec.decode_bit(probs, base + UNARY_SLOT0 + m)?;
        if bit == 0 {
            break;
        }
        m += 1;
    }
    if m == layout.spec.unary_slots {
        let mut u = 0u32;
        for _ in 0..32 {
            u = (u << 1) | (dec.decode_direct()? as u32);
        }
        return Ok(unzigzag(u));
    }
    let mut u = 0u32;
    let tree_bits = layout.spec.mant_tree_bits;
    for k in 0..m {
        let bit = if k < tree_bits {
            let node = layout.tree_base + ((1usize << k) - 1) + (u as usize);
            dec.decode_bit(probs, base + node)?
        } else {
            dec.decode_bit(probs, base + layout.flat_base + (k - tree_bits))?
        };
        u |= (bit as u32) << k;
    }
    u |= 1u32 << m;
    Ok(unzigzag(u))
}

#[inline]
fn is_sync_block(b: usize, sync_blocks: u32) -> bool {
    b == 0 || (sync_blocks > 0 && b % (sync_blocks as usize) == 0)
}

#[cfg(feature = "decode")]
fn meta_from_v1(
    h: &Gpsl0HeaderV1,
    block_index: Vec<Gpsl0BlockEntry>,
    byte_length: usize,
) -> Gpsl0Meta {
    Gpsl0Meta {
        version: h.version,
        tier0: h.tier0,
        has_alt: h.has_alt,
        alt_damped: h.alt_damped,
        coord_mode: h.coord_mode,
        coord_quantum: h.coord_quantum,
        alt_quantum: h.alt_quantum,
        n_points: h.n_points,
        block_points: h.block_points,
        sync_blocks: h.sync_blocks,
        n_blocks: h.n_blocks,
        model_id: h.model_id,
        header_crc32: h.header_crc32,
        index_crc32: h.index_crc32,
        block_index,
        byte_length,
    }
}

pub fn encode_v1(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &EncodeOptions,
) -> Result<Vec<u8>, Gpsl0Error> {
    let n = t.len();
    let model_id = opts.model_id.unwrap_or(DEFAULT_MODEL_ID_V1);
    let layout = get_v1_layout(model_id)?;

    let block_points = opts.block_points.unwrap_or(16384);
    if block_points < 2 || block_points > (1 << 20) {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad block_points {block_points}"
        )));
    }
    let alt_mode = opts.alt_mode.unwrap_or(AltMode::D1) as u8;
    let coord_mode_enum = opts.coord_mode.unwrap_or(CoordMode::TnClamped);
    if coord_mode_enum == CoordMode::D1 {
        return Err(Gpsl0Error::InvalidInput(
            "GPSL0 v1 does not support coord_mode D1".into(),
        ));
    }
    let coord_mode = coord_mode_enum as u8;

    let q = quantize_points(t, lat, lon, alt, opts)?;

    let n_blocks = if n == 0 { 0 } else { n.div_ceil(block_points as usize) };
    let mut sync_blocks = opts.sync_blocks;
    if sync_blocks > 0 && n_blocks > 0 && (sync_blocks as usize) > n_blocks {
        sync_blocks = n_blocks as u32;
    }

    let mut payloads: Vec<Vec<u8>> = Vec::with_capacity(n_blocks);
    let mut entries: Vec<Gpsl0BlockEntry> = Vec::with_capacity(n_blocks);
    let mut probs = vec![PROB_INIT_V1; layout.n_ctx * layout.n_slot];
    let mut carried: Option<BlockStateV1> = None;

    for b in 0..n_blocks {
        let start = b * (block_points as usize);
        let count = (block_points as usize).min(n - start);
        let sync = is_sync_block(b, sync_blocks);
        if sync {
            if b > 0 {
                probs.fill(PROB_INIT_V1);
            }
            carried = None;
        }

        let mut seed_buf = [0u8; SEED_BYTES_V1];
        let (mut st, i_start) = if sync {
            let seed = make_seed(&q.t, &q.lat, &q.lon, &q.alt, start, count);
            write_seed(&mut seed_buf, &seed);
            (init_state(&seed), start + 2)
        } else {
            let prev = carried.ok_or_else(|| {
                Gpsl0Error::InvalidInput("continuation block without carried state".into())
            })?;
            (prev, start)
        };

        let mut enc = RangeEncoderV1::new();
        for i in i_start..(start + count) {
            let lat_prev2 = st.lat_prev2;
            let lat_prev = st.lat_prev;
            let lon_prev2 = st.lon_prev2;
            let lon_prev = st.lon_prev;
            let alt_prev2 = st.alt_prev2;
            let alt_prev = st.alt_prev;
            let dt_prev = st.dt_prev;

            let t_cur = q.t[i];
            let dt_cur = t_cur.wrapping_sub(st.t_prev);
            let e_dt = dt_cur.wrapping_sub(dt_prev);
            let ctx_dt = layout.dt_ctx0
                + dt_bucket(dt_prev, layout.spec.dt_levels) * 2
                + usize::from(st.e_dt_prev != 0);
            encode_residual_v1(&mut enc, &mut probs, &layout, ctx_dt, e_dt)?;

            let spd = speed_regime(
                lat_prev.wrapping_sub(lat_prev2),
                lon_prev.wrapping_sub(lon_prev2),
                dt_prev,
                layout.spec.speed_thresholds,
            );
            let dchg = if layout.coord_dt_changed == 2 && e_dt != 0 {
                1
            } else {
                0
            };

            let e_lat = ((q.lat[i] as i64)
                - predict_coord_v1(lat_prev2, lat_prev, dt_prev, dt_cur, coord_mode))
                as i32;
            let ctx_lat = layout.lat_ctx0
                + (spd * layout.n_q1 + q1(st.e_lat_prev, layout.spec.q_levels))
                    * layout.coord_dt_changed
                + dchg;
            encode_residual_v1(&mut enc, &mut probs, &layout, ctx_lat, e_lat)?;

            let e_lon = ((q.lon[i] as i64)
                - predict_coord_v1(lon_prev2, lon_prev, dt_prev, dt_cur, coord_mode))
                as i32;
            let lon_ctx_base = (spd * layout.n_q1 + q1(st.e_lon_prev, layout.spec.q_levels))
                * layout.coord_dt_changed;
            let ctx_lon = if layout.spec.lon_uses_lat_residual {
                layout.lon_ctx0 + lon_ctx_base * layout.n_q1 + q1(e_lat, layout.spec.q_levels)
            } else {
                layout.lon_ctx0 + lon_ctx_base + dchg
            };
            encode_residual_v1(&mut enc, &mut probs, &layout, ctx_lon, e_lon)?;

            let e_alt =
                ((q.alt[i] as i64) - predict_alt_v1(alt_prev2, alt_prev, alt_mode)) as i32;
            let ctx_alt =
                layout.alt_ctx0 + spd * layout.n_alt_q + q1(st.e_alt_prev, layout.spec.alt_levels);
            encode_residual_v1(&mut enc, &mut probs, &layout, ctx_alt, e_alt)?;

            st.t_prev2 = st.t_prev;
            st.t_prev = t_cur;
            st.dt_prev = dt_cur;
            st.lat_prev2 = lat_prev;
            st.lat_prev = q.lat[i];
            st.lon_prev2 = lon_prev;
            st.lon_prev = q.lon[i];
            st.alt_prev2 = alt_prev;
            st.alt_prev = q.alt[i];
            st.e_dt_prev = e_dt;
            st.e_lat_prev = e_lat;
            st.e_lon_prev = e_lon;
            st.e_alt_prev = e_alt;
        }
        carried = Some(st);

        let coded = enc.finish();
        let mut payload = Vec::with_capacity((if sync { SEED_BYTES_V1 } else { 0 }) + coded.len());
        if sync {
            payload.extend_from_slice(&seed_buf);
        }
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

    let index_bytes = entries.len() * INDEX_ENTRY_SIZE_V1;
    let total_payload: usize = payloads.iter().map(|p| p.len()).sum();
    let total_size = HEADER_SIZE_V1 + index_bytes + total_payload;
    let mut out = vec![0u8; total_size];

    let mut off = HEADER_SIZE_V1 + index_bytes;
    for (i, p) in payloads.iter().enumerate() {
        entries[i].byte_offset = off as u32;
        out[off..off + p.len()].copy_from_slice(p);
        off += p.len();
    }

    let mut idx_off = HEADER_SIZE_V1;
    for e in &entries {
        write_u32_le(&mut out, idx_off, e.start_ts);
        write_u32_le(&mut out, idx_off + 4, e.end_ts);
        write_u32_le(&mut out, idx_off + 8, e.point_count);
        write_u32_le(&mut out, idx_off + 12, e.byte_offset);
        write_u32_le(&mut out, idx_off + 16, e.byte_length);
        write_u32_le(&mut out, idx_off + 20, e.crc32);
        idx_off += INDEX_ENTRY_SIZE_V1;
    }

    let index_crc32 = crc32(&out[HEADER_SIZE_V1..HEADER_SIZE_V1 + index_bytes]);
    write_v1_header(
        &mut out,
        &Gpsl0HeaderV1 {
            version: 1,
            tier0: q.coord_quantum == 1,
            has_alt: true,
            alt_damped: alt_mode == AltMode::Damped as u8,
            coord_mode,
            coord_quantum: q.coord_quantum,
            alt_quantum: q.alt_quantum,
            n_points: n as u32,
            block_points,
            sync_blocks,
            n_blocks: n_blocks as u32,
            model_id,
            header_crc32: 0,
            index_crc32,
        },
    );

    Ok(out)
}

#[cfg(feature = "decode")]
#[allow(clippy::too_many_arguments)]
fn decode_one_block_v1(
    payload: &[u8],
    point_count: usize,
    alt_mode: u8,
    coord_mode: u8,
    layout: &ModelLayoutV1,
    probs: &mut [u16],
    out_t: &mut [i32],
    out_lat: &mut [i32],
    out_lon: &mut [i32],
    out_alt: &mut [i32],
    out_offset: usize,
    sync: bool,
    carried: Option<BlockStateV1>,
) -> Result<BlockStateV1, Gpsl0Error> {
    let (mut st, j_start, rc_off) = if sync {
        if payload.len() < SEED_BYTES_V1 + 5 {
            return Err(Gpsl0Error::Truncated(format!(
                "sync block payload too short ({} B)",
                payload.len()
            )));
        }
        let seed = read_seed(payload);
        out_t[out_offset] = seed.t0;
        out_lat[out_offset] = seed.lat0;
        out_lon[out_offset] = seed.lon0;
        out_alt[out_offset] = seed.alt0;
        let s = init_state(&seed);
        if point_count >= 2 {
            out_t[out_offset + 1] = s.t_prev;
            out_lat[out_offset + 1] = s.lat_prev;
            out_lon[out_offset + 1] = s.lon_prev;
            out_alt[out_offset + 1] = s.alt_prev;
        }
        (s, 2, SEED_BYTES_V1)
    } else {
        if payload.len() < 5 {
            return Err(Gpsl0Error::Truncated(format!(
                "block payload too short ({} B)",
                payload.len()
            )));
        }
        let s = carried.ok_or_else(|| {
            Gpsl0Error::InvalidInput("continuation block without carried state".into())
        })?;
        (s, 0, 0)
    };

    let mut dec = RangeDecoderV1::new(&payload[rc_off..])?;
    for j in j_start..point_count {
        let lat_prev2 = st.lat_prev2;
        let lat_prev = st.lat_prev;
        let lon_prev2 = st.lon_prev2;
        let lon_prev = st.lon_prev;
        let alt_prev2 = st.alt_prev2;
        let alt_prev = st.alt_prev;
        let dt_prev = st.dt_prev;

        let ctx_dt = layout.dt_ctx0
            + dt_bucket(dt_prev, layout.spec.dt_levels) * 2
            + usize::from(st.e_dt_prev != 0);
        let e_dt = decode_residual_v1(&mut dec, probs, layout, ctx_dt)?;
        let dt_cur = dt_prev.wrapping_add(e_dt);
        let t_cur = st.t_prev.wrapping_add(dt_cur);

        let spd = speed_regime(
            lat_prev.wrapping_sub(lat_prev2),
            lon_prev.wrapping_sub(lon_prev2),
            dt_prev,
            layout.spec.speed_thresholds,
        );
        let dchg = if layout.coord_dt_changed == 2 && e_dt != 0 {
            1
        } else {
            0
        };

        let ctx_lat = layout.lat_ctx0
            + (spd * layout.n_q1 + q1(st.e_lat_prev, layout.spec.q_levels))
                * layout.coord_dt_changed
            + dchg;
        let e_lat = decode_residual_v1(&mut dec, probs, layout, ctx_lat)?;
        let lat_cur =
            (predict_coord_v1(lat_prev2, lat_prev, dt_prev, dt_cur, coord_mode) + (e_lat as i64))
                as i32;

        let lon_ctx_base = (spd * layout.n_q1 + q1(st.e_lon_prev, layout.spec.q_levels))
            * layout.coord_dt_changed;
        let ctx_lon = if layout.spec.lon_uses_lat_residual {
            layout.lon_ctx0 + lon_ctx_base * layout.n_q1 + q1(e_lat, layout.spec.q_levels)
        } else {
            layout.lon_ctx0 + lon_ctx_base + dchg
        };
        let e_lon = decode_residual_v1(&mut dec, probs, layout, ctx_lon)?;
        let lon_cur =
            (predict_coord_v1(lon_prev2, lon_prev, dt_prev, dt_cur, coord_mode) + (e_lon as i64))
                as i32;

        let ctx_alt =
            layout.alt_ctx0 + spd * layout.n_alt_q + q1(st.e_alt_prev, layout.spec.alt_levels);
        let e_alt = decode_residual_v1(&mut dec, probs, layout, ctx_alt)?;
        let alt_cur =
            (predict_alt_v1(alt_prev2, alt_prev, alt_mode) + (e_alt as i64)) as i32;

        out_t[out_offset + j] = t_cur;
        out_lat[out_offset + j] = lat_cur;
        out_lon[out_offset + j] = lon_cur;
        out_alt[out_offset + j] = alt_cur;

        st.t_prev2 = st.t_prev;
        st.t_prev = t_cur;
        st.dt_prev = dt_cur;
        st.lat_prev2 = lat_prev;
        st.lat_prev = lat_cur;
        st.lon_prev2 = lon_prev;
        st.lon_prev = lon_cur;
        st.alt_prev2 = alt_prev;
        st.alt_prev = alt_cur;
        st.e_dt_prev = e_dt;
        st.e_lat_prev = e_lat;
        st.e_lon_prev = e_lon;
        st.e_alt_prev = e_alt;
    }

    Ok(st)
}

#[cfg(feature = "decode")]
#[inline]
fn dequantize_in_place(arr: &mut [i32], quantum: i32) {
    if quantum == 1 {
        return;
    }
    for v in arr.iter_mut() {
        *v = v.wrapping_mul(quantum);
    }
}

#[cfg(feature = "decode")]
pub fn inspect_v1_header(bytes: &[u8]) -> Result<Gpsl0Meta, Gpsl0Error> {
    let header = read_v1_header(bytes)?;
    let _ = get_v1_layout(header.model_id)?;
    let block_index = read_v1_block_index(bytes, &header)?;
    Ok(meta_from_v1(&header, block_index, bytes.len()))
}

#[cfg(feature = "decode")]
pub fn decode_v1(bytes: &[u8]) -> Result<DecodedTrack, Gpsl0Error> {
    let header = read_v1_header(bytes)?;
    let layout = get_v1_layout(header.model_id)?;
    let block_index = read_v1_block_index(bytes, &header)?;
    let n = header.n_points as usize;
    let mut t = vec![0i32; n];
    let mut lat = vec![0i32; n];
    let mut lon = vec![0i32; n];
    let mut alt = vec![0i32; n];

    if n == 0 {
        let meta = meta_from_v1(&header, block_index, bytes.len());
        return Ok(DecodedTrack {
            t,
            lat,
            lon,
            alt,
            meta,
        });
    }

    let alt_mode = if header.alt_damped {
        AltMode::Damped as u8
    } else {
        AltMode::D1 as u8
    };
    let coord_mode = header.coord_mode;
    let mut probs = vec![PROB_INIT_V1; layout.n_ctx * layout.n_slot];
    let mut state: Option<BlockStateV1> = None;
    let mut point_off = 0usize;

    for (b, entry) in block_index.iter().enumerate() {
        let sync = is_sync_block(b, header.sync_blocks);
        if sync {
            if b > 0 {
                probs.fill(PROB_INIT_V1);
            }
            state = None;
        }
        let start_b = entry.byte_offset as usize;
        let end_b = start_b + (entry.byte_length as usize);
        let payload = &bytes[start_b..end_b];
        if crc32(payload) != entry.crc32 {
            return Err(Gpsl0Error::CrcMismatch(format!(
                "block {b} payload crc mismatch"
            )));
        }
        state = Some(decode_one_block_v1(
            payload,
            entry.point_count as usize,
            alt_mode,
            coord_mode,
            &layout,
            &mut probs,
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

    dequantize_in_place(&mut lat, header.coord_quantum as i32);
    dequantize_in_place(&mut lon, header.coord_quantum as i32);
    dequantize_in_place(&mut alt, header.alt_quantum as i32);

    let meta = meta_from_v1(&header, block_index, bytes.len());
    Ok(DecodedTrack {
        t,
        lat,
        lon,
        alt,
        meta,
    })
}

#[cfg(feature = "decode")]
pub fn decode_v1_window(
    bytes: &[u8],
    start_point: usize,
    len: usize,
) -> Result<DecodedTrack, Gpsl0Error> {
    let header = read_v1_header(bytes)?;
    let layout = get_v1_layout(header.model_id)?;
    let block_index = read_v1_block_index(bytes, &header)?;

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

    let alt_mode = if header.alt_damped {
        AltMode::Damped as u8
    } else {
        AltMode::D1 as u8
    };
    let coord_mode = header.coord_mode;
    let mut probs = vec![PROB_INIT_V1; layout.n_ctx * layout.n_slot];
    let mut state: Option<BlockStateV1> = None;
    let mut buf_off = 0usize;

    for (b, entry) in block_index
        .iter()
        .enumerate()
        .skip(sync_start_block)
        .take(last_block - sync_start_block + 1)
    {
        let sync = is_sync_block(b, header.sync_blocks);
        if sync {
            probs.fill(PROB_INIT_V1);
            state = None;
        }
        let start_b = entry.byte_offset as usize;
        let end_b = start_b + (entry.byte_length as usize);
        let payload = &bytes[start_b..end_b];
        if crc32(payload) != entry.crc32 {
            return Err(Gpsl0Error::CrcMismatch(format!(
                "block {b} payload crc mismatch"
            )));
        }
        state = Some(decode_one_block_v1(
            payload,
            entry.point_count as usize,
            alt_mode,
            coord_mode,
            &layout,
            &mut probs,
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

    dequantize_in_place(&mut lat, header.coord_quantum as i32);
    dequantize_in_place(&mut lon, header.coord_quantum as i32);
    dequantize_in_place(&mut alt, header.alt_quantum as i32);

    let meta = meta_from_v1(&header, block_index, bytes.len());
    Ok(DecodedTrack {
        t,
        lat,
        lon,
        alt,
        meta,
    })
}
