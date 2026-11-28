use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use gpsl0_core::rangecoder::RcV2Params;
use gpsl0_core::v2::{
    collect_priors_v2, decode_v2_with_config, encode_v2_with_config, ActMode, AltPredV2, BinMode,
    ChannelBitStats, CoordPredV2, CtxArch, DchgMode, DtPredMode, JointZeroMode, SignMode, V2Config,
    MODEL_ID_V3,
};
use gpsl0_core::{
    decode, decode_window, encode, infer_quantum, inspect_header, AltMode, CoordMode,
    EncodeOptions, QuantumSpec,
};

struct Track {
    id: String,
    t: Vec<i32>,
    lat: Vec<i32>,
    lon: Vec<i32>,
    alt: Vec<i32>,
    gpz_bytes: usize,
}

fn read_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}
fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
fn read_i32(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn load_dataset(repo_root: &Path) -> Vec<Track> {
    let cache_path = repo_root.join("frontend/scripts/lib/.cache/tracks-v1.bin");
    let raw = fs::read(&cache_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", cache_path.display()));
    assert_eq!(&raw[0..8], b"GPSL0DS1", "bad cache magic");
    let mut off = 8usize;
    let track_count = read_u32(&raw, off) as usize;
    off += 4;
    let gpz_dir = repo_root.join("frontend/local-data/r2/tracks");
    let mut tracks = Vec::with_capacity(track_count);

    for _ in 0..track_count {
        let id_len = read_u16(&raw, off) as usize;
        off += 2;
        let id = String::from_utf8(raw[off..off + id_len].to_vec()).unwrap();
        off += id_len;
        let n = read_u32(&raw, off) as usize;
        off += 4;
        let mut t = Vec::with_capacity(n);
        let mut lat = Vec::with_capacity(n);
        let mut lon = Vec::with_capacity(n);
        let mut alt = Vec::with_capacity(n);
        for i in 0..n {
            t.push(read_i32(&raw, off + i * 4));
            lat.push(read_i32(&raw, off + n * 4 + i * 4));
            lon.push(read_i32(&raw, off + n * 8 + i * 4));
            alt.push(read_i32(&raw, off + n * 12 + i * 4));
        }
        off += n * 16;
        let gpz_bytes = fs::metadata(gpz_dir.join(format!("{id}.gpz")))
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        tracks.push(Track {
            id,
            t,
            lat,
            lon,
            alt,
            gpz_bytes,
        });
    }
    tracks
}

fn find_repo_root() -> PathBuf {
    let mut cur = std::env::current_dir().unwrap();
    loop {
        if cur.join("frontend/scripts/lib/.cache/tracks-v1.bin").exists() {
            return cur;
        }
        if !cur.pop() {
            panic!("could not locate repo root containing frontend/scripts/lib/.cache/tracks-v1.bin");
        }
    }
}

fn verify_v1_compat(repo_root: &Path, tracks: &[Track]) {
    let opts = EncodeOptions {
        version: 1,
        model_id: Some(7),
        coord_quantum: QuantumSpec::Auto,
        alt_quantum: QuantumSpec::Fixed(10),
        block_points: Some(16384),
        sync_blocks: 0,
        alt_mode: Some(AltMode::D1),
        coord_mode: Some(CoordMode::TnClamped),
    };

    let gpsl0_dir = repo_root.join("frontend/local-data/r2/tracks-gpsl0");
    let mut total_bytes = 0usize;
    let mut total_gpz = 0usize;
    let mut total_pts = 0usize;
    let mut ref_checked = 0usize;
    let mut ref_mismatches = 0usize;
    let mut enc_time = std::time::Duration::ZERO;
    let mut dec_time = std::time::Duration::ZERO;
    let mut max_alt_dev = 0i32;

    for tr in tracks {
        let t0 = Instant::now();
        let bytes = encode(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts).unwrap();
        enc_time += t0.elapsed();

        let t1 = Instant::now();
        let dec = decode(&bytes).unwrap();
        dec_time += t1.elapsed();

        assert_eq!(dec.t, tr.t, "t mismatch on {}", tr.id);
        assert_eq!(dec.lat, tr.lat, "lat mismatch on {}", tr.id);
        assert_eq!(dec.lon, tr.lon, "lon mismatch on {}", tr.id);
        for (a, b) in dec.alt.iter().zip(tr.alt.iter()) {
            let d = (a - b).abs();
            if d > max_alt_dev {
                max_alt_dev = d;
            }
            assert!(d <= 5, "alt dev > 5 on {}: {d}", tr.id);
        }
        if tr.t.len() >= 10 {
            let w = decode_window(&bytes, tr.t.len() / 2, 5).unwrap();
            assert_eq!(w.t, dec.t[tr.t.len() / 2..tr.t.len() / 2 + 5]);
        }

        let ref_path = gpsl0_dir.join(format!("{}.gpsl0", tr.id));
        if ref_path.exists() {
            let ref_bytes = fs::read(&ref_path).unwrap();
            ref_checked += 1;
            if ref_bytes != bytes {
                ref_mismatches += 1;
                eprintln!(
                    "BYTE MISMATCH vs {}: ref={} B, rust={} B",
                    tr.id,
                    ref_bytes.len(),
                    bytes.len()
                );
            }
        }

        total_bytes += bytes.len();
        total_gpz += tr.gpz_bytes;
        total_pts += tr.t.len();
    }

    let bpt = (total_bytes as f64 * 8.0) / (total_pts as f64);
    println!(
        "v1 compat | tracks={} pts={} | Rust v1={} B ({:.4} b/pt) | GPZ={} B ({:.3}x) | enc={:.2} ms | dec={:.2} ms | maxAltDev={} | refMatched={}/{}",
        tracks.len(),
        total_pts,
        total_bytes,
        bpt,
        total_gpz,
        total_gpz as f64 / total_bytes as f64,
        enc_time.as_secs_f64() * 1000.0,
        dec_time.as_secs_f64() * 1000.0,
        max_alt_dev,
        ref_checked - ref_mismatches,
        ref_checked
    );
    assert_eq!(ref_mismatches, 0, "v1 bytes did not match reference .gpsl0 files");

    // Also verify Tier-0 lossless (auto / 1) and Tier-1 (10 / 10)
    let mut t0_bytes = 0usize;
    let mut t1_bytes = 0usize;
    for tr in tracks {
        let b0 = encode(
            &tr.t,
            &tr.lat,
            &tr.lon,
            &tr.alt,
            &EncodeOptions {
                alt_quantum: QuantumSpec::Fixed(1),
                ..opts.clone()
            },
        )
        .unwrap();
        let d0 = decode(&b0).unwrap();
        assert_eq!(d0.t, tr.t);
        assert_eq!(d0.lat, tr.lat);
        assert_eq!(d0.lon, tr.lon);
        assert_eq!(d0.alt, tr.alt);
        t0_bytes += b0.len();

        let b1 = encode(
            &tr.t,
            &tr.lat,
            &tr.lon,
            &tr.alt,
            &EncodeOptions {
                coord_quantum: QuantumSpec::Fixed(10),
                alt_quantum: QuantumSpec::Fixed(10),
                ..opts.clone()
            },
        )
        .unwrap();
        let d1 = decode(&b1).unwrap();
        if infer_quantum(&tr.lat, 10_000_000) >= 10 {
            assert!(d1.lat.iter().zip(&tr.lat).all(|(a, b)| (a - b).abs() <= 5));
        }
        t1_bytes += b1.len();
    }
    println!(
        "v1 tiers  | Tier-0(auto/1)={} B ({:.4} b/pt) | Tier-1(10/10)={} B ({:.4} b/pt)",
        t0_bytes,
        (t0_bytes as f64 * 8.0) / (total_pts as f64),
        t1_bytes,
        (t1_bytes as f64 * 8.0) / (total_pts as f64)
    );
}

fn run_case(
    name: &str,
    tracks: &[Track],
    opts: &EncodeOptions,
    cfg: &V2Config,
    verify_roundtrip: bool,
) -> (usize, usize, usize, f64, f64, ChannelBitStats) {
    let mut total_bytes = 0usize;
    let mut t0_bytes = 0usize;
    let mut q1_bytes = 0usize;
    let mut total_pts = 0usize;
    let mut q1_pts = 0usize;
    let mut stats = ChannelBitStats::default();
    let mut enc_ms = 0.0f64;
    let mut dec_ms = 0.0f64;

    let opts_t0 = EncodeOptions {
        alt_quantum: QuantumSpec::Fixed(1),
        ..opts.clone()
    };

    for tr in tracks {
        let t_enc = Instant::now();
        let bytes = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, opts, cfg, Some(&mut stats)).unwrap();
        enc_ms += t_enc.elapsed().as_secs_f64() * 1000.0;
        total_bytes += bytes.len();
        total_pts += tr.t.len();

        let is_q1 = infer_quantum(&tr.lat, 10_000_000) == 1 || infer_quantum(&tr.lon, 10_000_000) == 1;
        if is_q1 {
            q1_bytes += bytes.len();
            q1_pts += tr.t.len();
        }

        if verify_roundtrip && cfg.compact_container {
            let t_dec = Instant::now();
            let dec = decode_v2_with_config(&bytes, cfg).unwrap();
            dec_ms += t_dec.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(dec.t, tr.t, "t mismatch in {name} on {}", tr.id);
            assert_eq!(dec.lat, tr.lat, "lat mismatch in {name} on {}", tr.id);
            assert_eq!(dec.lon, tr.lon, "lon mismatch in {name} on {}", tr.id);
            for (a, b) in dec.alt.iter().zip(tr.alt.iter()) {
                assert!((a - b).abs() <= 5, "alt dev > 5 in {name} on {}", tr.id);
            }
        }

        let b0 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, cfg, None).unwrap();
        t0_bytes += b0.len();
        if verify_roundtrip && cfg.compact_container {
            let d0 = decode_v2_with_config(&b0, cfg).unwrap();
            assert_eq!(d0.t, tr.t);
            assert_eq!(d0.lat, tr.lat);
            assert_eq!(d0.lon, tr.lon);
            assert_eq!(d0.alt, tr.alt);
        }
    }

    let pts = total_pts as f64;
    let bpt = (total_bytes as f64 * 8.0) / pts;
    let t0_bpt = (t0_bytes as f64 * 8.0) / pts;
    let q1_bpt = (q1_bytes as f64 * 8.0) / (q1_pts.max(1) as f64);
    println!(
        "{:<38} | {:>8} B ({:.4} b/pt) | T0:{:>8} ({:.4}) | q1:{:.4} | az:{:.3} dt:{:.3} lat:{:.3} lon:{:.3} alt:{:.3} ctr:{:.3} | {:.0}/{:.0}ms",
        name,
        total_bytes,
        bpt,
        t0_bytes,
        t0_bpt,
        q1_bpt,
        stats.all_zero_bits / pts,
        stats.dt_bits / pts,
        stats.lat_bits / pts,
        stats.lon_bits / pts,
        stats.alt_bits / pts,
        (stats.container_bytes as f64 * 8.0) / pts,
        enc_ms,
        dec_ms
    );
    (total_bytes, t0_bytes, q1_bytes, enc_ms, dec_ms, stats)
}

fn run_ablate(tracks: &[Track]) {
    let opts = EncodeOptions {
        version: 2,
        model_id: Some(20),
        coord_quantum: QuantumSpec::Auto,
        alt_quantum: QuantumSpec::Fixed(10),
        block_points: None,
        sync_blocks: 0,
        alt_mode: Some(AltMode::D1),
        coord_mode: Some(CoordMode::TnClamped),
    };

    println!("=== GPSL0 v2 Step-3b Ablation (123 tracks, 2,022,295 pts) ===");

    // Step 3a winner baseline (`4a` from Step 3a)
    let base_3a = V2Config {
        rc: RcV2Params {
            prob_bits: 12,
            exact_bound: true,
            min_prob: 4,
            dual_speed: true,
            slow_zero_shift: 6,
            fast_zero_shift: 5,
            mag_shift: 5,
        },
        bin_mode: BinMode::SignMagMsbTree4,
        dedicated_m1: false,
        bypass_from: None,
        sign_mode: SignMode::PrevRel,
        joint_zero: JointZeroMode::DtThenAllZero3,
        dt_pred: DtPredMode::Prev,
        dchg_mode: DchgMode::EDtNz,
        act_mode: ActMode::None,
        ctx_arch: CtxArch::Decoupled,
        lon_cross_zero: true,
        lon_cross_mag: true,
        alt_cross_zero: true,
        coord_pred: CoordPredV2::TnClamped,
        alt_pred: AltPredV2::D1,
        block_points: 32768,
        compact_container: true,
        priors: None,
        v3_grid_ctx: false,
    };
    run_case("0. 3a-winner (rc12,az3,msb4)", tracks, &opts, &base_3a, true);

    // 1. dt predictor + dchg mode
    let c_med3 = V2Config { dt_pred: DtPredMode::Median3, dchg_mode: DchgMode::DtStepOrBase, ..base_3a.clone() };
    run_case("1a. +dt=Median3 + dchg=step", tracks, &opts, &c_med3, true);
    let c_sbase = V2Config { dt_pred: DtPredMode::SteadyBase, dchg_mode: DchgMode::DtStepOrBase, ..base_3a.clone() };
    run_case("1b. +dt=SteadyBase + dchg=step", tracks, &opts, &c_sbase, true);
    let c_sbase_e = V2Config { dt_pred: DtPredMode::SteadyBase, dchg_mode: DchgMode::EDtNz, ..base_3a.clone() };
    run_case("1c. +dt=SteadyBase + dchg=e_dt", tracks, &opts, &c_sbase_e, true);

    // 2. Activity EWMA + last_nz_sign + zero_gap
    let c_act4 = V2Config { act_mode: ActMode::MagEwma4, ..c_sbase.clone() };
    run_case("2a. +act=MagEwma4", tracks, &opts, &c_act4, true);
    let c_act8 = V2Config { act_mode: ActMode::MagEwma8, ..c_sbase.clone() };
    run_case("2b. +act=MagEwma8", tracks, &opts, &c_act8, true);
    let c_actb = V2Config { act_mode: ActMode::BothEwma4, ..c_sbase.clone() };
    run_case("2c. +act=BothEwma4", tracks, &opts, &c_actb, true);

    let c_lnz = V2Config { sign_mode: SignMode::LastNzGap, ..c_act4.clone() };
    run_case("2d. +sign=LastNzGap (on MagEwma4)", tracks, &opts, &c_lnz, true);
    let c_lnz_noact = V2Config { sign_mode: SignMode::LastNzGap, ..c_sbase.clone() };
    run_case("2e. +sign=LastNzGap (no Ewma)", tracks, &opts, &c_lnz_noact, true);

    // 3. Per-role speeds + dedicated m1 + bypass_from + tree3/tree4 + prob_bits
    for &(label, pbits, sz, fz, ms) in &[
        ("3a. rc12 sz=6 fz=5 ms=5", 12, 6, 5, 5),
        ("3b. rc12 sz=7 fz=5 ms=5", 12, 7, 5, 5),
        ("3c. rc12 sz=6 fz=4 ms=4", 12, 6, 4, 4),
        ("3d. rc12 sz=6 fz=5 ms=4", 12, 6, 5, 4),
        ("3e. rc12 sz=7 fz=4 ms=4", 12, 7, 4, 4),
        ("3f. rc14 sz=7 fz=5 ms=5", 14, 7, 5, 5),
        ("3g. rc14 sz=7 fz=4 ms=4", 14, 7, 4, 4),
    ] {
        let cfg = V2Config {
            rc: RcV2Params { prob_bits: pbits, slow_zero_shift: sz, fast_zero_shift: fz, mag_shift: ms, ..c_lnz.rc },
            ..c_lnz.clone()
        };
        run_case(label, tracks, &opts, &cfg, true);
    }

    let c_m1 = V2Config { dedicated_m1: true, ..c_lnz.clone() };
    run_case("3h. +dedicated_m1", tracks, &opts, &c_m1, true);
    for bf in [4usize, 5, 6] {
        let cfg = V2Config { bypass_from: Some(bf), ..c_m1.clone() };
        run_case(&format!("3i. +bypass_from={bf}"), tracks, &opts, &cfg, true);
    }
    let c_t3 = V2Config { bin_mode: BinMode::SignMagMsbTree3, bypass_from: Some(5), ..c_m1.clone() };
    run_case("3j. +MsbTree3 + bypass=5", tracks, &opts, &c_t3, true);

    // 4. Predictors: Q1SpikeDamped + Alt AlphaBeta + Sparse D1
    println!("--- Step 3b Predictors ---");
    let best_rc = RcV2Params { prob_bits: 12, slow_zero_shift: 7, fast_zero_shift: 5, mag_shift: 5, ..c_m1.rc };
    let pred_base = V2Config { rc: best_rc, coord_pred: CoordPredV2::Q1SpikeDamped, ..c_m1.clone() };
    run_case("4a. coord=Q1SpikeDamped alt=D1", tracks, &opts, &pred_base, true);
    for &(label, a, b) in &[
        ("4b. alt=AB(205,52)", 205, 52),
        ("4c. alt=AB(218,64)", 218, 64),
        ("4d. alt=AB(224,70)", 224, 70),
        ("4e. alt=AB(230,77)", 230, 77),
    ] {
        let cfg = V2Config { alt_pred: AltPredV2::AlphaBeta(a, b), ..pred_base.clone() };
        run_case(label, tracks, &opts, &cfg, true);
    }
    let c_lms_alt = V2Config { alt_pred: AltPredV2::OnlineLms2, ..pred_base.clone() };
    run_case("4f. alt=OnlineLms2", tracks, &opts, &c_lms_alt, true);

    let win_cfg = V2Config { alt_pred: AltPredV2::AlphaBeta(218, 64), ..pred_base.clone() };
    // Sparse/small track D1 vs Q1SpikeDamped selection check
    {
        let cfg_d1 = V2Config { coord_pred: CoordPredV2::D1, ..win_cfg.clone() };
        let mut base_sum = 0usize;
        let mut heur_sum = 0usize;
        let mut oracle_sum = 0usize;
        let mut heur_picked = 0usize;
        for tr in tracks {
            let b_tn = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &win_cfg, None).unwrap();
            let b_d1 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &cfg_d1, None).unwrap();
            base_sum += b_tn.len();
            oracle_sum += b_tn.len().min(b_d1.len());
            let dur = if tr.t.len() >= 2 { (tr.t[tr.t.len() - 1] - tr.t[0]).max(0) as usize } else { 0 };
            let sparse_or_small = tr.t.len() <= 4096 || dur >= tr.t.len() * 3;
            if sparse_or_small && b_d1.len() < b_tn.len() {
                heur_sum += b_d1.len();
                heur_picked += 1;
            } else {
                heur_sum += b_tn.len();
            }
        }
        println!("4g. coord selector | base={base_sum} B | heur={heur_sum} B (d1={heur_picked}, saved={}) | oracle={oracle_sum} B", base_sum - heur_sum);
    }

    // 5. 5-Fold CV Priors: Role Priors (16 constants) vs Full Slot Priors vs Zero Prior
    println!("--- Step 3b Priors (5-Fold CV) ---");
    let mut no_p = 0usize;
    let mut role_p = 0usize;
    let mut full_p = 0usize;
    let mut no_p_t0 = 0usize;
    let mut role_p_t0 = 0usize;
    let mut full_p_t0 = 0usize;
    let opts_t0 = EncodeOptions { alt_quantum: QuantumSpec::Fixed(1), ..opts.clone() };
    for fold in 0..5usize {
        let mut train_refs = Vec::new();
        let mut test_tracks = Vec::new();
        for (idx, tr) in tracks.iter().enumerate() {
            if idx % 5 == fold {
                test_tracks.push(tr);
            } else {
                train_refs.push((tr.t.as_slice(), tr.lat.as_slice(), tr.lon.as_slice(), tr.alt.as_slice()));
            }
        }
        let (full_priors, role_priors) = collect_priors_v2(&train_refs, &opts, &win_cfg).unwrap();
        let cfg_role = V2Config { priors: Some(role_priors), ..win_cfg.clone() };
        let cfg_full = V2Config { priors: Some(full_priors), ..win_cfg.clone() };
        for tr in test_tracks {
            let bn = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &win_cfg, None).unwrap();
            let br = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &cfg_role, None).unwrap();
            let bf = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &cfg_full, None).unwrap();
            no_p += bn.len();
            role_p += br.len();
            full_p += bf.len();

            let bn0 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, &win_cfg, None).unwrap();
            let br0 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, &cfg_role, None).unwrap();
            let bf0 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, &cfg_full, None).unwrap();
            no_p_t0 += bn0.len();
            role_p_t0 += br0.len();
            full_p_t0 += bf0.len();
        }
    }
    println!("5-fold CV (def) | zero={no_p} B | role16={role_p} B (saved={} B) | full={full_p} B (saved={} B)", no_p as isize - role_p as isize, no_p as isize - full_p as isize);
    println!("5-fold CV (T0)  | zero={no_p_t0} B | role16={role_p_t0} B (saved={} B) | full={full_p_t0} B (saved={} B)", no_p_t0 as isize - role_p_t0 as isize, no_p_t0 as isize - full_p_t0 as isize);
}

fn run_ablate_final_check(tracks: &[Track]) {
    let opts = EncodeOptions {
        version: 2,
        model_id: Some(20),
        coord_quantum: QuantumSpec::Auto,
        alt_quantum: QuantumSpec::Fixed(10),
        block_points: None,
        sync_blocks: 0,
        alt_mode: Some(AltMode::D1),
        coord_mode: Some(CoordMode::TnClamped),
    };
    let c_base = V2Config {
        rc: RcV2Params { prob_bits: 12, exact_bound: true, min_prob: 4, dual_speed: true, slow_zero_shift: 7, fast_zero_shift: 5, mag_shift: 5 },
        bin_mode: BinMode::SignMagMsbTree4,
        dedicated_m1: true,
        bypass_from: None,
        sign_mode: SignMode::LastNzGap,
        joint_zero: JointZeroMode::DtThenAllZero3,
        dt_pred: DtPredMode::SteadyBase,
        dchg_mode: DchgMode::DtStepOrBase,
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
    };
    println!("=== Combined Step 3b Winner Check ===");
    run_case("W1. sz=7 dchg=step m1=true bp=32k", tracks, &opts, &c_base, true);
    let c_sz6 = V2Config { rc: RcV2Params { slow_zero_shift: 6, ..c_base.rc }, ..c_base.clone() };
    run_case("W2. sz=6 dchg=step m1=true bp=32k", tracks, &opts, &c_sz6, true);
    let c_edt = V2Config { dchg_mode: DchgMode::EDtNz, ..c_base.clone() };
    run_case("W3. sz=7 dchg=e_dt m1=true bp=32k", tracks, &opts, &c_edt, true);
    let c_bp64 = V2Config { block_points: 65536, ..c_base.clone() };
    run_case("W4. sz=7 dchg=step m1=true bp=64k", tracks, &opts, &c_bp64, true);
    let c_alt_lms = V2Config { alt_pred: AltPredV2::OnlineLms2, ..c_bp64.clone() };
    run_case("W5. W4 + alt=OnlineLms2", tracks, &opts, &c_alt_lms, true);
    let c_alt_ab = V2Config { alt_pred: AltPredV2::AlphaBeta(230, 77), ..c_bp64.clone() };
    run_case("W6. W4 + alt=AB(230,77)", tracks, &opts, &c_alt_ab, true);

    // W4 + sparse/small D1 selector + auto alt (D1 if aq>=5 else OnlineLms2)
    let cfg_d1 = V2Config { coord_pred: CoordPredV2::D1, ..c_bp64.clone() };
    let cfg_d1_t0 = V2Config { coord_pred: CoordPredV2::D1, alt_pred: AltPredV2::OnlineLms2, ..c_bp64.clone() };
    let opts_t0 = EncodeOptions { alt_quantum: QuantumSpec::Fixed(1), ..opts.clone() };
    let mut def_sum = 0usize;
    let mut t0_sum = 0usize;
    let mut q1_sum = 0usize;
    let mut q1_pts = 0usize;
    let mut pts = 0usize;
    let mut d1_cnt = 0usize;
    for tr in tracks {
        pts += tr.t.len();
        let dur = if tr.t.len() >= 2 { (tr.t[tr.t.len() - 1] - tr.t[0]).max(0) as usize } else { 0 };
        let try_d1 = tr.t.len() <= 4096 || dur >= tr.t.len() * 3;
        let b_tn = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &c_bp64, None).unwrap();
        let best_def = if try_d1 {
            let b_d1 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts, &cfg_d1, None).unwrap();
            if b_d1.len() < b_tn.len() { d1_cnt += 1; b_d1 } else { b_tn }
        } else { b_tn };
        def_sum += best_def.len();
        if infer_quantum(&tr.lat, 10_000_000) == 1 || infer_quantum(&tr.lon, 10_000_000) == 1 {
            q1_sum += best_def.len();
            q1_pts += tr.t.len();
        }

        let b0_tn = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, &c_alt_lms, None).unwrap();
        let best_t0 = if try_d1 {
            let b0_d1 = encode_v2_with_config(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts_t0, &cfg_d1_t0, None).unwrap();
            if b0_d1.len() < b0_tn.len() { b0_d1 } else { b0_tn }
        } else { b0_tn };
        t0_sum += best_t0.len();
    }
    println!(
        "W_FINAL (def+T0 auto) | def={} B ({:.4} b/pt, -{:.2}% vs v1, {:.3}x GPZ) | T0={} B ({:.4} b/pt, -{:.2}% vs v1) | q1={:.4} b/pt | d1_picked={}/123",
        def_sum,
        (def_sum as f64 * 8.0) / (pts as f64),
        (1.0 - (def_sum as f64) / 1171096.0) * 100.0,
        10275509.0 / (def_sum as f64),
        t0_sum,
        (t0_sum as f64 * 8.0) / (pts as f64),
        (1.0 - (t0_sum as f64) / 1632632.0) * 100.0,
        (q1_sum as f64 * 8.0) / (q1_pts as f64),
        d1_cnt,
    );
}

fn verify_v3(tracks: &[Track]) {
    let opts = EncodeOptions {
        model_id: Some(MODEL_ID_V3),
        ..EncodeOptions::default()
    };
    let mut total_bytes = 0usize;
    let mut total_gpz = 0usize;
    let mut total_pts = 0usize;
    let mut q1_bytes = 0usize;
    let mut q1_pts = 0usize;
    let mut enc_time = std::time::Duration::ZERO;
    let mut dec_time = std::time::Duration::ZERO;
    let mut max_alt_dev = 0i32;

    for tr in tracks {
        let t0 = Instant::now();
        let bytes = encode(&tr.t, &tr.lat, &tr.lon, &tr.alt, &opts).unwrap();
        enc_time += t0.elapsed();

        let t1 = Instant::now();
        let dec = decode(&bytes).unwrap();
        dec_time += t1.elapsed();

        assert_eq!(dec.meta.version, 2);
        assert_eq!(dec.meta.model_id, MODEL_ID_V3, "model_id mismatch on {}", tr.id);
        assert_eq!(dec.t, tr.t, "m22 t mismatch on {}", tr.id);
        assert_eq!(dec.lat, tr.lat, "m22 lat mismatch on {}", tr.id);
        assert_eq!(dec.lon, tr.lon, "m22 lon mismatch on {}", tr.id);
        for (a, b) in dec.alt.iter().zip(tr.alt.iter()) {
            let d = (a - b).abs();
            if d > max_alt_dev {
                max_alt_dev = d;
            }
            assert!(d <= 5, "m22 alt dev > 5 on {}: {d}", tr.id);
        }
        if tr.t.len() >= 10 {
            let s = tr.t.len() / 2;
            let w = decode_window(&bytes, s, 5).unwrap();
            assert_eq!(w.t, dec.t[s..s + 5]);
            assert_eq!(w.lat, dec.lat[s..s + 5]);
            assert_eq!(w.lon, dec.lon[s..s + 5]);
            assert_eq!(w.alt, dec.alt[s..s + 5]);
        }
        if infer_quantum(&tr.lat, 10_000_000) == 1 || infer_quantum(&tr.lon, 10_000_000) == 1 {
            q1_bytes += bytes.len();
            q1_pts += tr.t.len();
        }
        total_bytes += bytes.len();
        total_gpz += tr.gpz_bytes;
        total_pts += tr.t.len();
    }

    let mut t0_bytes = 0usize;
    let mut t1_bytes = 0usize;
    for tr in tracks {
        let b0 = encode(
            &tr.t,
            &tr.lat,
            &tr.lon,
            &tr.alt,
            &EncodeOptions {
                alt_quantum: QuantumSpec::Fixed(1),
                ..opts.clone()
            },
        )
        .unwrap();
        let d0 = decode(&b0).unwrap();
        assert_eq!(d0.t, tr.t);
        assert_eq!(d0.lat, tr.lat);
        assert_eq!(d0.lon, tr.lon);
        assert_eq!(d0.alt, tr.alt);
        t0_bytes += b0.len();

        let b1 = encode(
            &tr.t,
            &tr.lat,
            &tr.lon,
            &tr.alt,
            &EncodeOptions {
                coord_quantum: QuantumSpec::Fixed(10),
                alt_quantum: QuantumSpec::Fixed(10),
                ..opts.clone()
            },
        )
        .unwrap();
        let d1 = decode(&b1).unwrap();
        assert!(d1.lat.iter().zip(&tr.lat).all(|(a, b)| (a - b).abs() <= 5));
        t1_bytes += b1.len();
    }

    println!(
        "Rust v3   | tracks={} pts={} | m22={} B ({:.4} b/pt) | GPZ={:.3}x | vs v1 -{:.2}% | enc={:.2} ms | dec={:.2} ms | maxAltDev={} | q1={:.4} b/pt",
        tracks.len(),
        total_pts,
        total_bytes,
        (total_bytes as f64 * 8.0) / (total_pts as f64),
        total_gpz as f64 / total_bytes as f64,
        (1.0 - (total_bytes as f64) / 1171096.0) * 100.0,
        enc_time.as_secs_f64() * 1000.0,
        dec_time.as_secs_f64() * 1000.0,
        max_alt_dev,
        (q1_bytes as f64 * 8.0) / (q1_pts as f64),
    );
    println!(
        "v3 tiers  | Tier-0(auto/1)={} B ({:.4} b/pt, -{:.2}% vs v1) | Tier-1(10/10)={} B ({:.4} b/pt, -{:.2}% vs v1)",
        t0_bytes,
        (t0_bytes as f64 * 8.0) / (total_pts as f64),
        (1.0 - (t0_bytes as f64) / 1632632.0) * 100.0,
        t1_bytes,
        (t1_bytes as f64 * 8.0) / (total_pts as f64),
        (1.0 - (t1_bytes as f64) / 1426665.0) * 100.0,
    );
    assert_eq!(total_bytes, 1_079_995, "frozen m22 total bytes changed");
}

fn run_report_stats(tracks: &[Track]) {
    let run_tier = |label: &str, model_id: u32, opts: &EncodeOptions| {
        let mut pts = 0usize;
        let mut total_bytes = 0usize;
        let mut d1_picked = 0usize;
        let mut sum = ChannelBitStats::default();
        let tier_opts = EncodeOptions {
            model_id: Some(model_id),
            ..opts.clone()
        };
        for tr in tracks {
            let n = tr.t.len();
            pts += n;
            let cq = match tier_opts.coord_quantum {
                QuantumSpec::Auto => gpsl0_core::gcd_u64(
                    infer_quantum(&tr.lat, 10_000_000) as u64,
                    infer_quantum(&tr.lon, 10_000_000) as u64,
                )
                .max(1) as u32,
                QuantumSpec::Fixed(v) => v,
            };
            let aq = match tier_opts.alt_quantum {
                QuantumSpec::Auto => infer_quantum(&tr.alt, 10),
                QuantumSpec::Fixed(v) => v,
            };
            let alt_pred = if aq >= 5 {
                AltPredV2::D1
            } else {
                AltPredV2::AlphaBeta(230, 77)
            };
            let cfg_base = |pred: CoordPredV2| -> V2Config {
                if model_id == MODEL_ID_V3 {
                    V2Config::v3(cq, pred, alt_pred, 32768)
                } else {
                    V2Config {
                        coord_pred: pred,
                        alt_pred,
                        ..V2Config::default()
                    }
                }
            };
            let mut s_tn = ChannelBitStats::default();
            let b_tn = encode_v2_with_config(
                &tr.t,
                &tr.lat,
                &tr.lon,
                &tr.alt,
                &tier_opts,
                &cfg_base(CoordPredV2::Q1SpikeDamped),
                Some(&mut s_tn),
            )
            .unwrap();
            let dur = if n >= 2 {
                (tr.t[n - 1] as i64).saturating_sub(tr.t[0] as i64).max(0) as usize
            } else {
                0
            };
            let (chosen, chosen_stats, is_d1) = if n >= 3 && (n <= 4096 || dur >= n.saturating_mul(3)) {
                let mut s_d1 = ChannelBitStats::default();
                let b_d1 = encode_v2_with_config(
                    &tr.t,
                    &tr.lat,
                    &tr.lon,
                    &tr.alt,
                    &tier_opts,
                    &cfg_base(CoordPredV2::D1),
                    Some(&mut s_d1),
                )
                .unwrap();
                if b_d1.len() < b_tn.len() {
                    (b_d1, s_d1, true)
                } else {
                    (b_tn, s_tn, false)
                }
            } else {
                (b_tn, s_tn, false)
            };
            if is_d1 {
                d1_picked += 1;
            }
            let canonical = encode(&tr.t, &tr.lat, &tr.lon, &tr.alt, &tier_opts).unwrap();
            assert_eq!(chosen, canonical, "stats path differed from encode on {} (m{model_id})", tr.id);
            total_bytes += chosen.len();
            sum.total_bits += chosen_stats.total_bits;
            sum.all_zero_bits += chosen_stats.all_zero_bits;
            sum.dt_bits += chosen_stats.dt_bits;
            sum.lat_bits += chosen_stats.lat_bits;
            sum.lon_bits += chosen_stats.lon_bits;
            sum.alt_bits += chosen_stats.alt_bits;
            sum.container_bytes += chosen_stats.container_bytes;
            sum.payload_bytes += chosen_stats.payload_bytes;
        }
        let p = pts as f64;
        println!(
            "{label} | bytes={total_bytes} ({:.4} b/pt) | d1_picked={d1_picked}/{} | payload={} B container={} B | az={:.4} dt={:.4} lat={:.4} lon={:.4} alt={:.4} ctr={:.4} rc_sum={:.4}",
            (total_bytes as f64 * 8.0) / p,
            tracks.len(),
            sum.payload_bytes,
            sum.container_bytes,
            sum.all_zero_bits / p,
            sum.dt_bits / p,
            sum.lat_bits / p,
            sum.lon_bits / p,
            sum.alt_bits / p,
            (sum.container_bytes as f64 * 8.0) / p,
            sum.total_bits / p,
        );
    };

    run_tier("v3-default", MODEL_ID_V3, &EncodeOptions::default());
    run_tier(
        "v3-tier0",
        MODEL_ID_V3,
        &EncodeOptions {
            alt_quantum: QuantumSpec::Fixed(1),
            ..EncodeOptions::default()
        },
    );

    let vt = [1700000000, 1700000001, 1700000002, 1700000003, 1700000004, 1700000006];
    let vlat = [311196800, 311196900, 311197000, 311197000, 311197100, 311197300];
    let vlon = [1214730000, 1214730100, 1214730200, 1214730200, 1214730300, 1214730500];
    let valt = [150, 150, 150, 150, 160, 170];
    for (tag, mid) in [("vector6_m22", MODEL_ID_V3)] {
        let vec_bytes = encode(
            &vt,
            &vlat,
            &vlon,
            &valt,
            &EncodeOptions {
                model_id: Some(mid),
                ..EncodeOptions::default()
            },
        )
        .unwrap();
        let vec_dec = decode(&vec_bytes).unwrap();
        assert_eq!(vec_dec.t, vt);
        assert_eq!(vec_dec.lat, vlat);
        assert_eq!(vec_dec.lon, vlon);
        assert_eq!(vec_dec.alt, valt);
        let meta = inspect_header(&vec_bytes).unwrap();
        let hex: String = vec_bytes.iter().map(|b| format!("{b:02x}")).collect();
        println!(
            "{tag} | bytes={} version={} model_id={} coord_mode={} coord_quantum={} alt_quantum={} alt_damped={} block_points={} n_blocks={} header_crc32=0x{:08x} index_crc32=0x{:08x} payload_crc32=0x{:08x}",
            vec_bytes.len(),
            meta.version,
            meta.model_id,
            meta.coord_mode,
            meta.coord_quantum,
            meta.alt_quantum,
            meta.alt_damped,
            meta.block_points,
            meta.n_blocks,
            meta.header_crc32,
            meta.index_crc32,
            meta.block_index[0].crc32,
        );
        println!("{tag}_hex | {hex}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let repo_root = find_repo_root();
    let tracks = load_dataset(&repo_root);
    if args.iter().any(|a| a == "--final-check") {
        run_ablate_final_check(&tracks);
    } else if args.iter().any(|a| a == "--report-stats") {
        run_report_stats(&tracks);
    } else if args.iter().any(|a| a == "--ablate") {
        run_ablate(&tracks);
    } else if args.iter().any(|a| a == "--verify") {
        verify_v1_compat(&repo_root, &tracks);
        verify_v3(&tracks);
    } else {
        verify_v1_compat(&repo_root, &tracks);
    }
}
