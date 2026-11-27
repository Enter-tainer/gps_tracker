#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

#[cfg(feature = "alloc")]
extern crate alloc;

#[cfg(feature = "alloc")]
use alloc::{format, vec::Vec};

pub mod container;
pub mod error;
pub mod pred;
pub mod rangecoder;
pub mod stream;
#[cfg(feature = "v1")]
pub mod v1;
#[cfg(feature = "alloc")]
pub mod v2;

#[cfg(feature = "decode")]
use crate::container::peek_version;
#[cfg(feature = "alloc")]
use crate::container::Gpsl0BlockEntry;
#[cfg(feature = "alloc")]
use crate::error::Gpsl0Error;
pub use crate::pred::{gcd_u64, AltMode, CoordMode};
#[cfg(feature = "alloc")]
use crate::pred::round_div_half_up_pos;

pub const DEFAULT_VERSION: u16 = 2;
pub const MODEL_ID_V3: u32 = crate::stream::V3_MODEL_ID;
pub const DEFAULT_MODEL_ID: u32 = MODEL_ID_V3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuantumSpec {
    Auto,
    Fixed(u32),
}

#[derive(Debug, Clone)]
pub struct EncodeOptions {
    pub version: u16,
    pub model_id: Option<u32>,
    pub coord_quantum: QuantumSpec,
    pub alt_quantum: QuantumSpec,
    pub block_points: Option<u32>,
    pub sync_blocks: u32,
    pub alt_mode: Option<AltMode>,
    pub coord_mode: Option<CoordMode>,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            version: DEFAULT_VERSION,
            model_id: None,
            coord_quantum: QuantumSpec::Auto,
            alt_quantum: QuantumSpec::Fixed(10),
            block_points: None,
            sync_blocks: 0,
            alt_mode: None,
            coord_mode: None,
        }
    }
}

#[cfg(feature = "alloc")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gpsl0Meta {
    pub version: u16,
    pub tier0: bool,
    pub has_alt: bool,
    pub alt_damped: bool,
    pub coord_mode: u8,
    pub coord_quantum: u32,
    pub alt_quantum: u32,
    pub n_points: u32,
    pub block_points: u32,
    pub sync_blocks: u32,
    pub n_blocks: u32,
    pub model_id: u32,
    pub header_crc32: u32,
    pub index_crc32: u32,
    pub block_index: Vec<Gpsl0BlockEntry>,
    pub byte_length: usize,
}

#[cfg(feature = "alloc")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTrack {
    pub t: Vec<i32>,
    pub lat: Vec<i32>,
    pub lon: Vec<i32>,
    pub alt: Vec<i32>,
    pub meta: Gpsl0Meta,
}

#[cfg(feature = "alloc")]
pub(crate) struct QuantizedTrack {
    pub t: Vec<i32>,
    pub lat: Vec<i32>,
    pub lon: Vec<i32>,
    pub alt: Vec<i32>,
    pub coord_quantum: u32,
    pub alt_quantum: u32,
}

pub fn infer_quantum(values: &[i32], cap: u32) -> u32 {
    let cap_u = cap as u64;
    let mut g: u64 = 0;
    for &v in values {
        g = gcd_u64(g, (v as i64).unsigned_abs());
        if g == 1 {
            return 1;
        }
    }
    if g == 0 {
        return cap;
    }
    let res = gcd_u64(g, cap_u);
    if res == 0 {
        1
    } else {
        res as u32
    }
}

#[cfg(feature = "alloc")]
fn quantize_exact(src: &[i32], quantum: u32) -> Result<Vec<i32>, Gpsl0Error> {
    if quantum == 1 {
        return Ok(src.to_vec());
    }
    let q = quantum as i64;
    let mut out = Vec::with_capacity(src.len());
    for &val in src {
        if (val as i64) % q != 0 {
            return Err(Gpsl0Error::InvalidInput(format!(
                "value {val} is not a multiple of quantum {quantum}"
            )));
        }
        out.push(((val as i64) / q) as i32);
    }
    Ok(out)
}

#[cfg(feature = "alloc")]
fn quantize_lossy(src: &[i32], quantum: u32) -> Vec<i32> {
    if quantum == 1 {
        return src.to_vec();
    }
    src.iter()
        .map(|&v| round_div_half_up_pos(v, quantum))
        .collect()
}

#[cfg(feature = "alloc")]
pub(crate) fn quantize_points(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &EncodeOptions,
) -> Result<QuantizedTrack, Gpsl0Error> {
    let n = t.len();
    if lat.len() != n || lon.len() != n || alt.len() != n {
        return Err(Gpsl0Error::InvalidInput(
            "t/lat/lon/alt arrays must have equal length".into(),
        ));
    }

    let (auto_quant, coord_quantum) = match opts.coord_quantum {
        QuantumSpec::Auto => {
            let glat = infer_quantum(lat, 10_000_000) as u64;
            let glon = infer_quantum(lon, 10_000_000) as u64;
            let g = gcd_u64(glat, glon).max(1) as u32;
            (true, g)
        }
        QuantumSpec::Fixed(q) => (false, q),
    };
    if coord_quantum < 1 || coord_quantum > 10_000_000 || 10_000_000 % coord_quantum != 0 {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad coord quantum {coord_quantum}"
        )));
    }

    let (auto_alt, alt_quantum) = match opts.alt_quantum {
        QuantumSpec::Auto => (true, infer_quantum(alt, 10).max(1)),
        QuantumSpec::Fixed(q) => (false, q),
    };
    if alt_quantum < 1 || 10 % alt_quantum != 0 {
        return Err(Gpsl0Error::InvalidInput(format!(
            "bad alt quantum {alt_quantum}"
        )));
    }

    let lat_q = if auto_quant {
        quantize_exact(lat, coord_quantum)?
    } else {
        quantize_lossy(lat, coord_quantum)
    };
    let lon_q = if auto_quant {
        quantize_exact(lon, coord_quantum)?
    } else {
        quantize_lossy(lon, coord_quantum)
    };
    let alt_q = if auto_alt {
        quantize_exact(alt, alt_quantum)?
    } else {
        quantize_lossy(alt, alt_quantum)
    };

    Ok(QuantizedTrack {
        t: t.to_vec(),
        lat: lat_q,
        lon: lon_q,
        alt: alt_q,
        coord_quantum,
        alt_quantum,
    })
}

#[cfg(feature = "alloc")]
pub fn encode(
    t: &[i32],
    lat: &[i32],
    lon: &[i32],
    alt: &[i32],
    opts: &EncodeOptions,
) -> Result<Vec<u8>, Gpsl0Error> {
    match opts.version {
        #[cfg(feature = "v1")]
        1 => v1::encode_v1(t, lat, lon, alt, opts),
        2 => v2::encode_v2(t, lat, lon, alt, opts),
        v => Err(Gpsl0Error::UnsupportedVersion(v)),
    }
}

#[cfg(feature = "decode")]
pub fn decode(bytes: &[u8]) -> Result<DecodedTrack, Gpsl0Error> {
    match peek_version(bytes)? {
        #[cfg(feature = "v1")]
        1 => v1::decode_v1(bytes),
        2 => v2::decode_v2(bytes),
        v => Err(Gpsl0Error::UnsupportedVersion(v)),
    }
}

#[cfg(feature = "decode")]
pub fn decode_window(
    bytes: &[u8],
    start_point: usize,
    len: usize,
) -> Result<DecodedTrack, Gpsl0Error> {
    match peek_version(bytes)? {
        #[cfg(feature = "v1")]
        1 => v1::decode_v1_window(bytes, start_point, len),
        2 => v2::decode_v2_window(bytes, start_point, len),
        v => Err(Gpsl0Error::UnsupportedVersion(v)),
    }
}

#[cfg(feature = "decode")]
pub fn inspect_header(bytes: &[u8]) -> Result<Gpsl0Meta, Gpsl0Error> {
    match peek_version(bytes)? {
        #[cfg(feature = "v1")]
        1 => v1::inspect_v1_header(bytes),
        2 => v2::inspect_v2_header(bytes),
        v => Err(Gpsl0Error::UnsupportedVersion(v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rangecoder::{
        RangeDecoderV1, RangeDecoderV2, RangeEncoderV1, RangeEncoderV2, RcV2Params, SlotKind,
        PROB_INIT_V1,
    };
    use crate::v1::{dt_bucket, q1, round_div, speed_regime, unzigzag, zigzag};

    #[test]
    fn test_spec_assertions() {
        assert_eq!(q1(0, 8), 0);
        assert_eq!(q1(1, 8), 1);
        assert_eq!(q1(-1, 8), 2);
        assert_eq!(q1(2, 8), 3);
        assert_eq!(q1(3, 8), 3);
        assert_eq!(q1(4, 8), 5);
        assert_eq!(q1(7, 8), 5);
        assert_eq!(q1(8, 8), 7);
        assert_eq!(q1(-8, 8), 8);
        assert_eq!(q1(64, 8), 13);
        assert_eq!(q1(127, 8), 13);
        assert_eq!(q1(128, 8), 15);
        assert_eq!(q1(-129, 8), 16);

        assert_eq!(q1(0, 4), 0);
        assert_eq!(q1(1, 4), 1);
        assert_eq!(q1(-1, 4), 2);
        assert_eq!(q1(2, 4), 3);
        assert_eq!(q1(4, 4), 5);
        assert_eq!(q1(16, 4), 7);

        assert_eq!(dt_bucket(0, 5), 0);
        assert_eq!(dt_bucket(1, 5), 1);
        assert_eq!(dt_bucket(2, 5), 2);
        assert_eq!(dt_bucket(4, 5), 3);
        assert_eq!(dt_bucket(9, 5), 4);
        assert_eq!(dt_bucket(-1, 5), 0);

        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
        assert_eq!(zigzag(-2), 3);
        assert_eq!(zigzag(2), 4);
        assert_eq!(unzigzag(3), -2);
        assert_eq!(unzigzag(zigzag(i32::MIN)), i32::MIN);
        assert_eq!(unzigzag(zigzag(i32::MAX)), i32::MAX);

        assert_eq!(speed_regime(0, 0, 0, &[]), 0);
        assert_eq!(round_div(5, 2), 3);
        assert_eq!(round_div(-5, 2), -3);
        assert_eq!(round_div(3, 10), 0);
        assert_eq!(round_div(-3, 10), 0);

        // Math.round ties toward +inf
        assert_eq!(round_div_half_up_pos(5, 10), 1);
        assert_eq!(round_div_half_up_pos(-5, 10), 0);
        assert_eq!(round_div_half_up_pos(-25, 10), -2);
        assert_eq!(round_div_half_up_pos(-26, 10), -3);
    }

    #[test]
    fn test_rangecoder_v1_and_v2_roundtrip() {
        let mut enc = RangeEncoderV1::new();
        let mut probs_e = vec![PROB_INIT_V1; 16 * 4];
        let mut bits = Vec::with_capacity(100_000);
        let mut seed: u32 = 12345;
        for i in 0..100_000usize {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7FFF_FFFF;
            let ctx = i & 15;
            let thresh = ((0.2 + 0.05 * (ctx as f64)) * (0x7FFF_FFFF as f64)) as u32;
            let bit = if seed < thresh { 0 } else { 1 };
            bits.push(bit);
            enc.encode_bit(&mut probs_e, ctx * 4 + (i & 3), bit).unwrap();
        }
        for i in 0..10_000 {
            enc.encode_direct((i & 1) as u8);
        }
        let coded = enc.finish();

        let mut dec = RangeDecoderV1::new(&coded).unwrap();
        let mut probs_d = vec![PROB_INIT_V1; 16 * 4];
        for (i, &expected) in bits.iter().enumerate() {
            let ctx = i & 15;
            let got = dec.decode_bit(&mut probs_d, ctx * 4 + (i & 3)).unwrap();
            assert_eq!(got, expected);
        }
        for i in 0..10_000 {
            assert_eq!(dec.decode_direct().unwrap(), (i & 1) as u8);
        }

        // v2 range coder roundtrip
        let params = RcV2Params {
            prob_bits: 12,
            exact_bound: true,
            min_prob: 4,
            dual_speed: true,
            slow_zero_shift: 7,
            fast_zero_shift: 5,
            mag_shift: 5,
        };
        let mut enc2 = RangeEncoderV2::new(params);
        let mut probs2_e = vec![params.prob_init(); 64];
        let mut cnt2_e = vec![0u8; 64];
        for (i, &bit) in bits.iter().enumerate() {
            let kind = match i % 3 {
                0 => SlotKind::SlowZero,
                1 => SlotKind::FastZero,
                _ => SlotKind::MagSign,
            };
            enc2.encode_bit(&mut probs2_e, &mut cnt2_e, i & 63, bit, kind).unwrap();
        }
        let coded2 = enc2.finish();
        let mut dec2 = RangeDecoderV2::new(&coded2, params).unwrap();
        let mut probs2_d = vec![params.prob_init(); 64];
        let mut cnt2_d = vec![0u8; 64];
        for (i, &expected) in bits.iter().enumerate() {
            let kind = match i % 3 {
                0 => SlotKind::SlowZero,
                1 => SlotKind::FastZero,
                _ => SlotKind::MagSign,
            };
            let got = dec2.decode_bit(&mut probs2_d, &mut cnt2_d, i & 63, kind).unwrap();
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn test_v1_and_v2_edge_cases() {
        for version in [1u16, 2u16] {
            let enc0 = encode(
                &[],
                &[],
                &[],
                &[],
                &EncodeOptions {
                    version,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(enc0.len(), if version == 1 { 48 } else { 36 });
            let dec0 = decode(&enc0).unwrap();
            assert_eq!(dec0.t.len(), 0);
            assert_eq!(
                decode_window(&enc0, 0, 0).unwrap_err(),
                Gpsl0Error::BadWindow("len must be >= 1".into())
            );

            let enc1 = encode(
                &[1700000000],
                &[311196800],
                &[1214730000],
                &[150],
                &EncodeOptions {
                    version,
                    alt_quantum: QuantumSpec::Fixed(1),
                    ..Default::default()
                },
            )
            .unwrap();
            let dec1 = decode(&enc1).unwrap();
            assert_eq!(dec1.t, vec![1700000000]);
            assert_eq!(dec1.lat, vec![311196800]);
            assert_eq!(dec1.lon, vec![1214730000]);
            assert_eq!(dec1.alt, vec![150]);
            let w1 = decode_window(&enc1, 0, 1).unwrap();
            assert_eq!(w1.t, vec![1700000000]);

            let t2 = vec![1700000000, 1700000001];
            let lat2 = vec![-311196800, -311196900];
            let lon2 = vec![-1214730000, -1214730100];
            let alt2 = vec![-50, -45];
            let enc2 = encode(
                &t2,
                &lat2,
                &lon2,
                &alt2,
                &EncodeOptions {
                    version,
                    alt_quantum: QuantumSpec::Fixed(1),
                    ..Default::default()
                },
            )
            .unwrap();
            let dec2 = decode(&enc2).unwrap();
            assert_eq!(dec2.t, t2);
            assert_eq!(dec2.lat, lat2);
            assert_eq!(dec2.lon, lon2);
            assert_eq!(dec2.alt, alt2);
        }
    }

    #[test]
    fn test_v1_models_and_modes_roundtrip() {
        let n = 300usize;
        let t: Vec<i32> = (0..n)
            .map(|i| 1700000000 + (i as i32) * if i % 17 == 0 { 3 } else { 1 })
            .collect();
        let lat: Vec<i32> = (0..n)
            .map(|i| 311196800 + (i as i32) * 100 + ((i * i) as i32 % 5) * 100)
            .collect();
        let lon: Vec<i32> = (0..n).map(|i| 1214730000 - (i as i32) * 200).collect();
        let alt: Vec<i32> = (0..n)
            .map(|i| 150 + ((i as i32 % 7) - 3) * 10)
            .collect();

        for model_id in 1..=10 {
            for &coord_mode in &[CoordMode::Tn, CoordMode::Naive, CoordMode::TnClamped] {
                for &alt_mode in &[AltMode::D1, AltMode::Damped] {
                    let bytes = encode(
                        &t,
                        &lat,
                        &lon,
                        &alt,
                        &EncodeOptions {
                            version: 1,
                            model_id: Some(model_id),
                            alt_quantum: QuantumSpec::Fixed(1),
                            block_points: Some(64),
                            sync_blocks: 2,
                            alt_mode: Some(alt_mode),
                            coord_mode: Some(coord_mode),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                    let dec = decode(&bytes).unwrap();
                    assert_eq!(dec.t, t);
                    assert_eq!(dec.lat, lat);
                    assert_eq!(dec.lon, lon);
                    assert_eq!(dec.alt, alt);

                    let w = decode_window(&bytes, 100, 100).unwrap();
                    assert_eq!(w.t, t[100..200]);
                    assert_eq!(w.lat, lat[100..200]);
                    assert_eq!(w.lon, lon[100..200]);
                    assert_eq!(w.alt, alt[100..200]);
                }
            }
        }
    }

    #[test]
    fn test_v2_modes_windows_and_corrupt_inputs() {
        let n = 400usize;
        let t: Vec<i32> = (0..n)
            .map(|i| 1700000000 + (i as i32) * if i % 23 == 0 { 15 } else { 1 })
            .collect();
        let lat: Vec<i32> = (0..n)
            .map(|i| {
                if (100..150).contains(&i) {
                    311196800
                } else {
                    311196800 + (i as i32) * 100 + ((i * 7) as i32 % 3) * 100
                }
            })
            .collect();
        let lon: Vec<i32> = (0..n)
            .map(|i| {
                if (100..150).contains(&i) {
                    1214730000
                } else {
                    1214730000 - (i as i32) * 150
                }
            })
            .collect();
        let alt: Vec<i32> = (0..n)
            .map(|i| 200 + ((i as i32 % 11) - 5))
            .collect();

        for &coord_mode in &[
            None,
            Some(CoordMode::Tn),
            Some(CoordMode::Naive),
            Some(CoordMode::TnClamped),
            Some(CoordMode::D1),
        ] {
            for &alt_mode in &[None, Some(AltMode::D1), Some(AltMode::Damped)] {
                for &sync_blocks in &[0u32, 2u32] {
                    let bytes = encode(
                        &t,
                        &lat,
                        &lon,
                        &alt,
                        &EncodeOptions {
                            version: 2,
                            alt_quantum: QuantumSpec::Fixed(1),
                            block_points: Some(64),
                            sync_blocks,
                            alt_mode,
                            coord_mode,
                            ..Default::default()
                        },
                    )
                    .unwrap();
                    let dec = decode(&bytes).unwrap();
                    assert_eq!(dec.meta.version, 2);
                    assert_eq!(dec.meta.model_id, DEFAULT_MODEL_ID);
                    assert_eq!(dec.t, t);
                    assert_eq!(dec.lat, lat);
                    assert_eq!(dec.lon, lon);
                    assert_eq!(dec.alt, alt);

                    for &(start, len) in &[(0, 1), (63, 2), (120, 90), (350, 50)] {
                        let w = decode_window(&bytes, start, len).unwrap();
                        assert_eq!(w.t, t[start..start + len]);
                        assert_eq!(w.lat, lat[start..start + len]);
                        assert_eq!(w.lon, lon[start..start + len]);
                        assert_eq!(w.alt, alt[start..start + len]);
                    }
                }
            }
        }

        // Corrupt & truncated & bitflip robustness across both v1 and v2
        for ver in [1u16, 2u16] {
            let bytes = encode(
                &t,
                &lat,
                &lon,
                &alt,
                &EncodeOptions {
                    version: ver,
                    block_points: Some(64),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(decode(&[]).is_err());
            assert!(decode(&[0x47]).is_err());
            for cut in 1..bytes.len().min(60) {
                assert!(decode(&bytes[..cut]).is_err());
            }
            assert!(decode(&bytes[..bytes.len() - 1]).is_err());
            assert!(decode(&bytes[..bytes.len() - 5]).is_err());
            for pos in 0..bytes.len() {
                let mut mutated = bytes.clone();
                mutated[pos] ^= 0x5A;
                // Must NEVER panic; almost every single byte flip is rejected by CRCs/headers
                let _ = decode(&mutated);
            }
            // Forged huge n_points with recomputed header CRC must reject cleanly without OOM
            let mut forged = bytes.clone();
            if ver == 2 {
                forged[16..20].copy_from_slice(&(1u32 << 30).to_le_bytes());
                forged[20..24].copy_from_slice(&2u32.to_le_bytes());
                let hc = crate::container::crc32(&forged[..28]);
                forged[28..32].copy_from_slice(&hc.to_le_bytes());
            } else {
                forged[20..24].copy_from_slice(&(1u32 << 30).to_le_bytes());
                forged[24..28].copy_from_slice(&2u32.to_le_bytes());
                let hc = crate::container::crc32(&forged[..40]);
                forged[40..44].copy_from_slice(&hc.to_le_bytes());
            }
            assert!(decode(&forged).is_err());
        }
    }

    #[test]
    fn test_streaming_v3_parity_and_footprint() {
        use alloc::boxed::Box;
        use crate::container::{write_v2_header_and_index, ByteSink, Gpsl0BlockEntry, SliceSink};
        use crate::stream::{QuantumScanner, StreamV3Options, StreamingEncoderV3};

        let enc_size = core::mem::size_of::<StreamingEncoderV3>();
        #[cfg(feature = "std")]
        std::println!("StreamingEncoderV3 size_of = {enc_size} B");
        assert!(
            enc_size < 63_000,
            "StreamingEncoderV3 too large for MCU .bss: {enc_size} B"
        );

        let encode_via_fixed_buffers = |t: &[i32],
                                        lat: &[i32],
                                        lon: &[i32],
                                        alt: &[i32],
                                        coord_quantum: u32,
                                        coord_exact: bool,
                                        alt_quantum: u32,
                                        alt_exact: bool,
                                        block_points: u32,
                                        sync_blocks: u32,
                                        coord_mode: CoordMode,
                                        alt_mode: AltMode|
         -> Vec<u8> {
            let mut enc = Box::new(StreamingEncoderV3::new_unconfigured());
            enc.reset(StreamV3Options {
                coord_quantum,
                coord_exact,
                alt_quantum,
                alt_exact,
                block_points,
                sync_blocks,
                coord_mode,
                alt_mode,
            })
            .unwrap();
            let mut payload_buf = [0u8; 8192];
            let mut payload_sink = SliceSink::new(&mut payload_buf);
            let mut entries = [Gpsl0BlockEntry {
                start_ts: 0,
                end_ts: 0,
                point_count: 0,
                byte_offset: 0,
                byte_length: 0,
                crc32: 0,
            }; 16];
            let mut n_entries = 0usize;
            for i in 0..t.len() {
                if let Some(e) = enc
                    .push_point(t[i], lat[i], lon[i], alt[i], &mut payload_sink)
                    .unwrap()
                {
                    entries[n_entries] = e;
                    n_entries += 1;
                }
            }
            if let Some(e) = enc.finish(&mut payload_sink).unwrap() {
                entries[n_entries] = e;
                n_entries += 1;
            }
            let mut hdr = enc.make_header(&entries[..n_entries]);
            let mut out_buf = [0u8; 8704];
            let mut out_sink = SliceSink::new(&mut out_buf);
            write_v2_header_and_index(&mut hdr, &entries[..n_entries], &mut out_sink).unwrap();
            out_sink.write_all(payload_sink.written()).unwrap();
            out_sink.written().to_vec()
        };

        // Empty track
        let b0 = encode_via_fixed_buffers(
            &[],
            &[],
            &[],
            &[],
            10_000_000,
            true,
            10,
            false,
            32768,
            0,
            CoordMode::TnClamped,
            AltMode::D1,
        );
        assert_eq!(b0, encode(&[], &[], &[], &[], &EncodeOptions::default()).unwrap());

        // 1-point and 2-point tracks
        for k in [1usize, 2usize] {
            let t = &[1700000000, 1700000001][..k];
            let lat = &[311196800, 311196900][..k];
            let lon = &[1214730000, 1214730100][..k];
            let alt = &[155, 165][..k];
            let mut scan = QuantumScanner::new();
            for i in 0..k {
                scan.push_point(t[i], lat[i], lon[i], alt[i]);
            }
            assert_eq!(
                scan.coord_quantum(),
                gcd_u64(
                    infer_quantum(lat, 10_000_000) as u64,
                    infer_quantum(lon, 10_000_000) as u64
                ) as u32
            );
            let s = encode_via_fixed_buffers(
                t,
                lat,
                lon,
                alt,
                scan.coord_quantum(),
                true,
                1,
                false,
                2,
                0,
                CoordMode::TnClamped,
                AltMode::Damped,
            );
            let r = encode(
                t,
                lat,
                lon,
                alt,
                &EncodeOptions {
                    block_points: Some(2),
                    alt_quantum: QuantumSpec::Fixed(1),
                    coord_mode: Some(CoordMode::TnClamped),
                    alt_mode: Some(AltMode::Damped),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(s, r);
        }

        // Multi-block, all coord modes, both alt modes, both q > 10 (grid) and q <= 10 regimes
        let n = 400usize;
        let t: Vec<i32> = (0..n)
            .map(|i| 1700000000 + (i as i32) * if i % 23 == 0 { 15 } else { 1 })
            .collect();
        let lat_q50: Vec<i32> = (0..n)
            .map(|i| 311196800 + (i as i32) * 100 + ((i * 7) as i32 % 3) * 100)
            .collect();
        let lon_q50: Vec<i32> = (0..n).map(|i| 1214730000 - (i as i32) * 150).collect();
        let lat_q1: Vec<i32> = (0..n)
            .map(|i| 311196801 + (i as i32) * 17 + ((i * 5) as i32 % 11))
            .collect();
        let lon_q1: Vec<i32> = (0..n)
            .map(|i| 1214730003 - (i as i32) * 23 + ((i * 3) as i32 % 7))
            .collect();
        let alt: Vec<i32> = (0..n).map(|i| 200 + ((i as i32 % 11) - 5)).collect();

        for (lat_case, lon_case, expected_q) in [
            (&lat_q50, &lon_q50, 50u32),
            (&lat_q1, &lon_q1, 1u32),
        ] {
            let mut scan = QuantumScanner::new();
            for i in 0..n {
                scan.push_point(t[i], lat_case[i], lon_case[i], alt[i]);
            }
            assert_eq!(scan.coord_quantum(), expected_q);

            for &coord_mode in
                &[CoordMode::Tn, CoordMode::Naive, CoordMode::TnClamped, CoordMode::D1]
            {
                for &alt_mode in &[AltMode::D1, AltMode::Damped] {
                    for &sync_blocks in &[0u32, 1u32, 2u32] {
                        let s = encode_via_fixed_buffers(
                            &t,
                            lat_case,
                            lon_case,
                            &alt,
                            scan.coord_quantum(),
                            true,
                            1,
                            false,
                            64,
                            sync_blocks,
                            coord_mode,
                            alt_mode,
                        );
                        let r = encode(
                            &t,
                            lat_case,
                            lon_case,
                            &alt,
                            &EncodeOptions {
                                alt_quantum: QuantumSpec::Fixed(1),
                                block_points: Some(64),
                                sync_blocks,
                                coord_mode: Some(coord_mode),
                                alt_mode: Some(alt_mode),
                                ..Default::default()
                            },
                        )
                        .unwrap();
                        assert_eq!(s, r);
                        let dec = decode(&r).unwrap();
                        assert_eq!(dec.meta.model_id, MODEL_ID_V3);
                        assert_eq!(dec.t, t);
                        assert_eq!(dec.lat, *lat_case);
                        assert_eq!(dec.lon, *lon_case);
                        assert_eq!(dec.alt, alt);
                    }
                }
            }
        }
    }

    #[test]
    fn test_v3_model22_grid_and_q1_parity() {
        // Empty, 1-point, 2-point default v3 headers and round-trip
        let enc0 = encode(&[], &[], &[], &[], &EncodeOptions::default()).unwrap();
        assert_eq!(enc0.len(), 36);
        let dec0 = decode(&enc0).unwrap();
        assert_eq!(dec0.meta.model_id, MODEL_ID_V3);
        assert!(dec0.t.is_empty());

        for k in [1usize, 2usize] {
            let t = &[1700000000, 1700000001][..k];
            let lat = &[311196800, 311196900][..k];
            let lon = &[1214730000, 1214730100][..k];
            let alt = &[155, 165][..k];
            let bytes = encode(
                t,
                lat,
                lon,
                alt,
                &EncodeOptions {
                    alt_quantum: QuantumSpec::Fixed(1),
                    ..Default::default()
                },
            )
            .unwrap();
            let dec = decode(&bytes).unwrap();
            assert_eq!(dec.meta.model_id, MODEL_ID_V3);
            assert_eq!(dec.t, t);
            assert_eq!(dec.lat, lat);
            assert_eq!(dec.lon, lon);
            assert_eq!(dec.alt, alt);
        }

        // Grid-quantized track (coord_quantum = 100 > 10): all CoordModes + AltModes + sync blocks
        let n = 400usize;
        let t: Vec<i32> = (0..n)
            .map(|i| 1700000000 + (i as i32) * if i % 23 == 0 { 15 } else { 1 })
            .collect();
        let lat: Vec<i32> = (0..n)
            .map(|i| {
                if (100..140).contains(&i) {
                    311196800
                } else {
                    311196800 + (i as i32) * 100 + ((i * 7) as i32 % 3) * 100
                }
            })
            .collect();
        let lon: Vec<i32> = (0..n)
            .map(|i| {
                if (100..140).contains(&i) {
                    1214730000
                } else {
                    1214730000 - (i as i32) * 100 + ((i * 3) as i32 % 4) * 100
                }
            })
            .collect();
        let alt: Vec<i32> = (0..n).map(|i| 200 + ((i as i32 % 11) - 5)).collect();

        for &coord_mode in &[
            None,
            Some(CoordMode::Tn),
            Some(CoordMode::Naive),
            Some(CoordMode::TnClamped),
            Some(CoordMode::D1),
        ] {
            for &alt_mode in &[AltMode::D1, AltMode::Damped] {
                let b22 = encode(
                    &t,
                    &lat,
                    &lon,
                    &alt,
                    &EncodeOptions {
                        model_id: Some(MODEL_ID_V3),
                        alt_quantum: QuantumSpec::Fixed(1),
                        block_points: Some(64),
                        sync_blocks: 2,
                        coord_mode,
                        alt_mode: Some(alt_mode),
                        ..Default::default()
                    },
                )
                .unwrap();
                let dec = decode(&b22).unwrap();
                assert_eq!(dec.meta.model_id, MODEL_ID_V3);
                assert_eq!(dec.meta.coord_quantum, 100);
                assert_eq!(dec.t, t);
                assert_eq!(dec.lat, lat);
                assert_eq!(dec.lon, lon);
                assert_eq!(dec.alt, alt);

                let w = decode_window(&b22, 60, 120).unwrap();
                assert_eq!(w.t, t[60..180]);
                assert_eq!(w.lat, lat[60..180]);
                assert_eq!(w.lon, lon[60..180]);
                assert_eq!(w.alt, alt[60..180]);
            }
        }

        // Full-precision track (coord_quantum = 1 <= 10)
        let lat_q1: Vec<i32> = (0..n)
            .map(|i| 311196801 + (i as i32) * 17 + ((i * 5) as i32 % 11))
            .collect();
        let lon_q1: Vec<i32> = (0..n)
            .map(|i| 1214730003 - (i as i32) * 23 + ((i * 3) as i32 % 7))
            .collect();
        let b_m22 = encode(
            &t,
            &lat_q1,
            &lon_q1,
            &alt,
            &EncodeOptions {
                model_id: Some(MODEL_ID_V3),
                alt_quantum: QuantumSpec::Fixed(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(b_m22[27], MODEL_ID_V3 as u8);
        let dec_q1 = decode(&b_m22).unwrap();
        assert_eq!(dec_q1.t, t);
        assert_eq!(dec_q1.lat, lat_q1);
        assert_eq!(dec_q1.lon, lon_q1);
        assert_eq!(dec_q1.alt, alt);

        // Deprecated/experimental model IDs (20, 21) and unknown model IDs must be rejected cleanly
        for bad_id in [20u32, 21u32, 99u32] {
            let err = encode(
                &t,
                &lat,
                &lon,
                &alt,
                &EncodeOptions {
                    model_id: Some(bad_id),
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert_eq!(err, Gpsl0Error::UnsupportedModel(bad_id));

            let mut tampered = b_m22.clone();
            tampered[27] = bad_id as u8;
            let hc = crate::container::crc32(&tampered[..28]);
            tampered[28..32].copy_from_slice(&hc.to_le_bytes());
            assert_eq!(decode(&tampered).unwrap_err(), Gpsl0Error::UnsupportedModel(bad_id));
        }
    }
}
