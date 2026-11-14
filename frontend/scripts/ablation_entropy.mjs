#!/usr/bin/env node
/**
 * GPSL0 Step-1 ablation: empirical entropy of predictor + context choices.
 *
 * No encoder is touched. Everything here is *measured* on the real corpus
 * (123 tracks / 2,022,295 points):
 *
 *   H0      plugin (zero-order) empirical entropy of a residual stream
 *   H1      plugin empirical conditional entropy H(e | ctx)      <- ORACLE bound
 *   H1_mm   H1 + Miller-Madow bias correction                    <- oracle, corrected
 *   LOSO    leave-one-track-out code length of the *two-part* model
 *           (zero flag / unary order / raw mantissa) - i.e. what a real adaptive
 *           range coder with a cross-track warm-start prior actually reaches.
 *
 * Usage (works from any cwd):
 *   node frontend/scripts/ablation_entropy.mjs
 *   node frontend/scripts/ablation_entropy.mjs --prec=1e6      # Tier-1 only
 *   node frontend/scripts/ablation_entropy.mjs --no-adaptive   # skip the range-coder sim
 *   node frontend/scripts/ablation_entropy.mjs --no-write
 *
 * Writes frontend/scripts/.cache/ablation_entropy.json (full numeric dump).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataset, totalPoints, loadGpzSizes } from "./lib/dataset.mjs";
import {
  roundDiv,
  zigzag,
  floorLog2,
  signedBucket,
  bucketDt,
  hEntropy,
  hMerge,
  condEntropy,
  CtxHists,
  summarize,
  bitsToMB,
  fn,
  pct,
  padEnd,
  padStart,
  slotLayout,
  SlotModel,
  chargeResidual,
} from "./lib/entropy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON_DEFAULT = path.join(__dirname, ".cache", "ablation_entropy.json");

/* ================================================================== *
 * CLI
 * ================================================================== */
function parseArgs(argv) {
  const opts = { prec: "both", adaptive: true, write: true, jsonPath: OUT_JSON_DEFAULT };
  for (const a of argv) {
    if (a.startsWith("--prec=")) opts.prec = a.slice(7);
    else if (a === "--no-adaptive") opts.adaptive = false;
    else if (a === "--no-write") opts.write = false;
    else if (a.startsWith("--json=")) opts.jsonPath = a.slice(7);
    else if (a === "--help" || a === "-h") {
      console.log("usage: node ablation_entropy.mjs [--prec=1e6|1e7|both] [--no-adaptive] [--no-write] [--json=path]");
      process.exit(0);
    }
  }
  const map = { "1e5": [1e5], "1e6": [1e6], "1e7": [1e7], both: [1e6, 1e7], all: [1e6, 1e7, 1e5] };
  if (!map[opts.prec]) throw new Error(`bad --prec=${opts.prec} (use 1e6 | 1e7 | both)`);
  opts.precisions = map[opts.prec];
  return opts;
}

/* ================================================================== *
 * Model constants
 * ================================================================== */

const D1 = 0;
const D2 = 1;
const TN2 = 2;
const HYB = 3;
const PRED_NAME = ["d1", "naive_d2", "time_norm_d2", "hybrid_d2"];

/**
 * First scored index. i>=4 needs x[i-2] AND x[i-3] (plus t[i-2], t[i-3]), so
 * the previous residual e[i-1] - the prev_q1 context - is defined for every
 * predictor. Uniform across predictors => the comparison is apples to apples.
 */
const START_I = 4;

/** Fine coordinate context: speed(8) x prev_q1(17) x dt_changed(2) x prev_dt_bucket(5). */
const F_SPD = 8;
const F_Q1 = 17;
const F_DCHG = 2;
const F_DTB = 5;
const FINE_N = F_SPD * F_Q1 * F_DCHG * F_DTB; // 1360
const SPD8_TO_6 = [0, 0, 1, 1, 2, 3, 4, 5];
const SPD6_NAMES = ["static", "walk", "slowride", "fastride", "city", "rail"];
const REGIME_LEGEND =
  "spd6: 0 static <0.3 | 1 walk 0.3-2.2 | 2 slowride 2.2-5.5 | 3 fastride 5.5-12 | 4 city 12-30 | 5 rail >30 (m/s)";
const REGIME8_LEGEND =
  "spd8: 0 <0.1 | 1 0.1-0.3 | 2 0.3-1.0 | 3 1.0-2.2 | 4 2.2-5.5 | 5 5.5-12 | 6 12-30 | 7 >30 (m/s)";

/** The coordinate scheme we recommend / use everywhere downstream. */
const COORD_PICK = "spd6+q1+dchg+dtb"; // 1020 contexts

/**
 * Reference slot count for the *recommended* slot layout (M_MAX=23 with a
 * low-3-bit mantissa tree, see §6b): 1 + 23 + 23*(7 + 20) = 645 slots.
 * Used only to translate "how many contexts" into "how many bytes of tables".
 */
const NSLOT_EST = 645;
const PROB_BYTES = 2;
const tablesMB = (ctx) => (ctx * 2 * NSLOT_EST * PROB_BYTES) / (1024 * 1024); // lat and lon get separate tables

function fineKey(spd8, q1, dchg, dtb) {
  return ((spd8 * F_Q1 + (q1 + 8)) * F_DCHG + dchg) * F_DTB + dtb;
}

function decodeFine(f) {
  const dtb = f % F_DTB;
  let r = (f - dtb) / F_DTB;
  const dchg = r % F_DCHG;
  r = (r - dchg) / F_DCHG;
  const q1i = r % F_Q1;
  r = (r - q1i) / F_Q1;
  return { spd8: r, q1: q1i - 8, dchg, dtb };
}

/** degree -> round(1024 * cos(deg)), 0..90. Literal table: no trig at run time. */
const COS1024 = [
  1024, 1024, 1023, 1023, 1022, 1020, 1018, 1016, 1014, 1011, 1008, 1005, 1002, 998, 994, 989, 984, 979,
  974, 968, 962, 956, 949, 943, 935, 928, 920, 912, 904, 896, 887, 878, 868, 859, 849, 839, 828, 818,
  807, 796, 784, 773, 761, 749, 737, 724, 711, 698, 685, 672, 658, 644, 630, 616, 602, 587, 573, 558,
  543, 527, 512, 496, 481, 465, 449, 433, 416, 400, 384, 367, 350, 333, 316, 299, 282, 265, 248, 230,
  213, 195, 178, 160, 143, 125, 107, 89, 71, 54, 36, 18, 0,
];

/** Metres per quantised lat/lon unit (1 deg lat = 111319.49 m). */
const UNITM_OF = new Map([
  [1e5, 1.1131949],
  [1e6, 0.11131949],
  [1e7, 0.011131949],
]);
/** Divisor from the dataset's native 1e7 units down to the tier. */
const DIV_OF = new Map([
  [1e5, 100],
  [1e6, 10],
  [1e7, 1],
]);
const TIER_NAME = new Map([
  [1e5, "1e5 (~1.1 m, GPZ V1 native)"],
  [1e6, "1e6 (~11 cm, Tier-1)"],
  [1e7, "1e7 (~1.1 cm, Tier-0)"],
]);

function speedRegime8(latQ, vlat, vlon, dtPrev, prec) {
  if (dtPrev <= 0) return 0;
  let degIdx = Math.trunc(Math.abs(latQ) / prec);
  if (degIdx > 90) degIdx = 90;
  const cosf = COS1024[degIdx];
  const units = Math.abs(vlat) + Math.floor((Math.abs(vlon) * cosf) / 1024);
  const mps = (units * UNITM_OF.get(prec)) / dtPrev;
  if (mps < 0.1) return 0;
  if (mps < 0.3) return 1;
  if (mps < 1.0) return 2;
  if (mps < 2.2) return 3;
  if (mps < 5.5) return 4;
  if (mps < 12) return 5;
  if (mps < 30) return 6;
  return 7;
}

/* ================================================================== *
 * Per-track preparation
 * ================================================================== */

function quantizeInt32(arr, div) {
  if (div === 1) return arr;
  const out = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = roundDiv(arr[i], div);
  return out;
}

/** Quantise a track to the tier and build the residual arrays for one predictor. */
function prepTrack(tr, prec, pred) {
  const n = tr.n;
  const t = tr.t;
  const div = DIV_OF.get(prec);
  const lat = quantizeInt32(tr.lat, div);
  const lon = quantizeInt32(tr.lon, div);
  const m = Math.max(0, n - 2);
  const eLat = new Int32Array(m);
  const eLon = new Int32Array(m);

  if (pred === D1) {
    for (let i = 2; i < n; i++) {
      eLat[i - 2] = lat[i] - lat[i - 1];
      eLon[i - 2] = lon[i] - lon[i - 1];
    }
  } else if (pred === D2) {
    for (let i = 2; i < n; i++) {
      eLat[i - 2] = lat[i] - 2 * lat[i - 1] + lat[i - 2];
      eLon[i - 2] = lon[i] - 2 * lon[i - 1] + lon[i - 2];
    }
  } else if (pred === TN2) {
    for (let i = 2; i < n; i++) {
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      let pl;
      let pn;
      if (dtPrev > 0) {
        pl = lat[i - 1] + roundDiv((lat[i - 1] - lat[i - 2]) * dtCur, dtPrev);
        pn = lon[i - 1] + roundDiv((lon[i - 1] - lon[i - 2]) * dtCur, dtPrev);
      } else {
        pl = lat[i - 1];
        pn = lon[i - 1];
      }
      eLat[i - 2] = lat[i] - pl;
      eLon[i - 2] = lon[i] - pn;
    }
  } else {
    // HYB: naive d2 by default; time-normalised only when the interval RATIO is
    // far from 1 (that is where d2's constant-velocity assumption breaks);
    // x[i-1] when dtCur == 0.
    for (let i = 2; i < n; i++) {
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      let pl;
      let pn;
      if (dtCur === 0) {
        pl = lat[i - 1];
        pn = lon[i - 1];
      } else if (dtPrev > 0 && (dtCur >= 3 * dtPrev || dtPrev >= 3 * dtCur)) {
        pl = lat[i - 1] + roundDiv((lat[i - 1] - lat[i - 2]) * dtCur, dtPrev);
        pn = lon[i - 1] + roundDiv((lon[i - 1] - lon[i - 2]) * dtCur, dtPrev);
      } else {
        pl = 2 * lat[i - 1] - lat[i - 2];
        pn = 2 * lon[i - 1] - lon[i - 2];
      }
      eLat[i - 2] = lat[i] - pl;
      eLon[i - 2] = lon[i] - pn;
    }
  }
  return { n, t, lat, lon, eLat, eLon };
}

/** Residual magnitude accumulator. */
class MagStats {
  constructor() {
    this.n = 0;
    this.zero = 0;
    this.m = new Float64Array(48);
    this.maxAbs = 0;
    this.ge12 = 0;
    this.ge16 = 0;
    this.ge18 = 0;
    this.ge20 = 0;
    this.ge21 = 0;
    this.ge22 = 0;
    this.ge24 = 0;
  }

  add(e) {
    this.n += 1;
    if (e === 0) {
      this.zero += 1;
      return;
    }
    const a = e > 0 ? e : -e;
    if (a > this.maxAbs) this.maxAbs = a;
    const mm = floorLog2(zigzag(e));
    this.m[mm < 47 ? mm : 47] += 1;
    if (a >= 4096) this.ge12 += 1;
    if (a >= 65536) this.ge16 += 1;
    if (a >= 262144) this.ge18 += 1;
    if (a >= 1048576) this.ge20 += 1;
    if (a >= 2097152) this.ge21 += 1;
    if (a >= 4194304) this.ge22 += 1;
    if (a >= 16777216) this.ge24 += 1;
  }

  toJSON() {
    const n = this.n || 1;
    return {
      n: this.n,
      zeroFrac: this.zero / n,
      maxAbs: this.maxAbs,
      mHist: Array.from(this.m),
      ge2p12: this.ge12 / n,
      ge2p16: this.ge16 / n,
      ge2p18: this.ge18 / n,
      ge2p20: this.ge20 / n,
      ge2p21: this.ge21 / n,
      ge2p22: this.ge22 / n,
      ge2p24: this.ge24 / n,
    };
  }
}

/* ================================================================== *
 * Context schemes for the coordinate channels
 * ================================================================== */

const SCHEMES = [
  { name: "ctx=0", size: 1, f: () => 0 },
  { name: "q1", size: F_Q1, f: (d) => d.q1 + 8 },
  { name: "spd8", size: 8, f: (d) => d.spd8 },
  { name: "spd6", size: 6, f: (d) => SPD8_TO_6[d.spd8] },
  { name: "spd6+q1", size: 6 * 17, f: (d) => SPD8_TO_6[d.spd8] * 17 + (d.q1 + 8) },
  { name: "spd8+q1", size: 8 * 17, f: (d) => d.spd8 * 17 + (d.q1 + 8) },
  { name: "spd6+dtb", size: 6 * 5, f: (d) => SPD8_TO_6[d.spd8] * 5 + d.dtb },
  { name: "q1+dtb", size: 17 * 5, f: (d) => (d.q1 + 8) * 5 + d.dtb },
  { name: "spd6+q1+dchg", size: 6 * 17 * 2, f: (d) => (SPD8_TO_6[d.spd8] * 17 + (d.q1 + 8)) * 2 + d.dchg },
  { name: "spd8+q1+dchg", size: 8 * 17 * 2, f: (d) => (d.spd8 * 17 + (d.q1 + 8)) * 2 + d.dchg },
  { name: "spd6+q1+dchg+dtb", size: 6 * 17 * 2 * 5, f: (d) => ((SPD8_TO_6[d.spd8] * 17 + (d.q1 + 8)) * 2 + d.dchg) * 5 + d.dtb },
  { name: "FULL", size: FINE_N, f: (d) => fineKey(d.spd8, d.q1, d.dchg, d.dtb) },
];
for (const sc of SCHEMES) {
  const arr = new Int32Array(FINE_N);
  for (let f = 0; f < FINE_N; f++) arr[f] = sc.f(decodeFine(f));
  sc.keyArr = arr;
  sc.f = null;
}
const SCHEME_BY_NAME = new Map(SCHEMES.map((s) => [s.name, s]));

/* ================================================================== *
 * Coordinate channel: predictor x context
 * ================================================================== */

function analyzeCoord(tracks, prec, pred) {
  const fineLat = new CtxHists(FINE_N);
  const fineLon = new CtxHists(FINE_N);
  const h0Lat = new Map();
  const h0Lon = new Map();
  const magLat = new MagStats();
  const magLon = new MagStats();
  let nSamples = 0;
  const t0 = Date.now();

  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    const P = prepTrack(tr, prec, pred);
    const { n, t, lat, lon, eLat, eLon } = P;
    for (let i = START_I; i < n; i++) {
      const j = i - 2;
      const eL = eLat[j];
      const eN = eLon[j];
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      const spd = speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec);
      const dchg = dtCur === dtPrev ? 0 : 1;
      const dtb = bucketDt(dtPrev);
      fineLat.add(fineKey(spd, signedBucket(eLat[j - 1], 8), dchg, dtb), eL);
      fineLon.add(fineKey(spd, signedBucket(eLon[j - 1], 8), dchg, dtb), eN);
      h0Lat.set(eL, (h0Lat.get(eL) || 0) + 1);
      h0Lon.set(eN, (h0Lon.get(eN) || 0) + 1);
      magLat.add(eL);
      magLon.add(eN);
      nSamples += 1;
    }
  }

  const H0lat = hEntropy(h0Lat, nSamples);
  const H0lon = hEntropy(h0Lon, nSamples);
  const schemes = {};
  const SHARED_FOR = new Set(["spd6+q1", "spd6+q1+dchg", COORD_PICK, "FULL"]);
  for (const sc of SCHEMES) {
    const isIdentity = sc.size === FINE_N;
    const cLat = isIdentity ? fineLat : fineLat.marginalize(sc.size, (f) => sc.keyArr[f]);
    const cLon = isIdentity ? fineLon : fineLon.marginalize(sc.size, (f) => sc.keyArr[f]);
    const eLat = condEntropy(cLat, nSamples);
    const eLon = condEntropy(cLon, nSamples);
    let Hshared = -1;
    if (SHARED_FOR.has(sc.name)) {
      const merged = new CtxHists(sc.size);
      cLat.mergeInto(merged);
      cLon.mergeInto(merged);
      Hshared = condEntropy(merged, nSamples * 2).H;
    }
    schemes[sc.name] = {
      ctx: sc.size,
      Hlat: eLat.H,
      Hlon: eLon.H,
      Hsum: eLat.H + eLon.H,
      HsumMm: eLat.Hmm + eLon.Hmm,
      mm: eLat.mmBits + eLon.mmBits,
      kEff: eLat.kEff + eLon.kEff,
      kUsed: eLat.kUsed + eLon.kUsed,
      Hshared,
    };
  }

  return {
    prec,
    predictor: PRED_NAME[pred],
    nSamples,
    H0: { lat: H0lat, lon: H0lon, sum: H0lat + H0lon, kLat: h0Lat.size, kLon: h0Lon.size },
    schemes,
    mag: { lat: magLat.toJSON(), lon: magLon.toJSON() },
    elapsedMs: Date.now() - t0,
  };
}

/* ================================================================== *
 * Isolated single-dimension granularity experiments (chosen predictor only)
 * ================================================================== */
/*
 * Base dims:  spd6(6) x q1(17) x dt_changed(2) x dtb(5) = 1020
 *   A) q1 17 -> 33 signed buckets          => 1980, marginalise back to 1020
 *   B) dt_changed 2 -> dt_relation 4       => 2040, marginalise back to 1020
 *   C) lon additionally conditioned on bucket17(lat residual of the same point)
 *      on top of spd6 x q1 x dt_changed     => 3468 vs 204
 * Each refinement is compared against the *marginalised* version of the same
 * pass, so the only thing that changes is that one dimension.
 */
const XA_N = 6 * 33 * 2 * 5; // 1980
const XB_N = 6 * 17 * 4 * 5; // 2040
const XD_N = 6 * 17 * 2 * 17; // 3468
const XC_N = 6 * 17 * 2; // 204

const clampQ17 = (q) => (q > 8 ? 8 : q < -8 ? -8 : q);

function analyzeExtraDims(tracks, prec, pred) {
  const hA = { lat: new CtxHists(XA_N), lon: new CtxHists(XA_N) };
  const hB = { lat: new CtxHists(XB_N), lon: new CtxHists(XB_N) };
  const hDlon = new CtxHists(XD_N);
  const hClon = new CtxHists(XC_N);
  let n = 0;

  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    const P = prepTrack(tr, prec, pred);
    const { n: N, t, lat, lon, eLat, eLon } = P;
    for (let i = START_I; i < N; i++) {
      const j = i - 2;
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      const dtb = bucketDt(dtPrev);
      const spd6 = SPD8_TO_6[speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec)];
      const dtrel = dtCur === 0 ? 0 : dtCur > dtPrev ? 1 : dtCur < dtPrev ? 2 : 3;
      const dchg = dtrel === 3 ? 0 : 1;
      const q33L = signedBucket(eLat[j - 1], 16);
      const q33N = signedBucket(eLon[j - 1], 16);
      const q17L = clampQ17(q33L);
      const q17N = clampQ17(q33N);
      const eL = eLat[j];
      const eN = eLon[j];
      const latB = signedBucket(eL, 8);
      hA.lat.add(((spd6 * 33 + (q33L + 16)) * 2 + dchg) * 5 + dtb, eL);
      hA.lon.add(((spd6 * 33 + (q33N + 16)) * 2 + dchg) * 5 + dtb, eN);
      hB.lat.add(((spd6 * 17 + (q17L + 8)) * 4 + dtrel) * 5 + dtb, eL);
      hB.lon.add(((spd6 * 17 + (q17N + 8)) * 4 + dtrel) * 5 + dtb, eN);
      hClon.add((spd6 * 17 + (q17N + 8)) * 2 + dchg, eN);
      hDlon.add(((spd6 * 17 + (q17N + 8)) * 2 + dchg) * 17 + (latB + 8), eN);
      n += 1;
    }
  }

  // marginalisations back to the 1020 base
  const aLatBase = hA.lat.marginalize(1020, (f) => {
    const dtb = f % 5;
    let r = (f - dtb) / 5;
    const dchg = r % 2;
    r = (r - dchg) / 2;
    const q33i = r % 33;
    const spd6 = (r - q33i) / 33;
    const q17 = clampQ17(q33i - 16);
    return ((spd6 * 17 + (q17 + 8)) * 2 + dchg) * 5 + dtb;
  });
  const aLonBase = hA.lon.marginalize(1020, (f) => {
    const dtb = f % 5;
    let r = (f - dtb) / 5;
    const dchg = r % 2;
    r = (r - dchg) / 2;
    const q33i = r % 33;
    const spd6 = (r - q33i) / 33;
    const q17 = clampQ17(q33i - 16);
    return ((spd6 * 17 + (q17 + 8)) * 2 + dchg) * 5 + dtb;
  });
  const bLatBase = hB.lat.marginalize(1020, (f) => {
    const dtb = f % 5;
    let r = (f - dtb) / 5;
    const dtrel = r % 4;
    r = (r - dtrel) / 4;
    const qi = r % 17;
    const spd6 = (r - qi) / 17;
    const dchg = dtrel === 3 ? 0 : 1;
    return ((spd6 * 17 + qi) * 2 + dchg) * 5 + dtb;
  });
  const bLonBase = hB.lon.marginalize(1020, (f) => {
    const dtb = f % 5;
    let r = (f - dtb) / 5;
    const dtrel = r % 4;
    r = (r - dtrel) / 4;
    const qi = r % 17;
    const spd6 = (r - qi) / 17;
    const dchg = dtrel === 3 ? 0 : 1;
    return ((spd6 * 17 + qi) * 2 + dchg) * 5 + dtb;
  });

  const sum2 = (a, b) => a.H + b.H;
  const eA = { lat: condEntropy(hA.lat, n), lon: condEntropy(hA.lon, n) };
  const eAB = { lat: condEntropy(aLatBase, n), lon: condEntropy(aLonBase, n) };
  const eB = { lat: condEntropy(hB.lat, n), lon: condEntropy(hB.lon, n) };
  const eBB = { lat: condEntropy(bLatBase, n), lon: condEntropy(bLonBase, n) };
  const eC = condEntropy(hClon, n);
  const eD = condEntropy(hDlon, n);

  return {
    nSamples: n,
    q1_33: { ctx: XA_N, H: sum2(eA.lat, eA.lon), baseCtx: 1020, baseH: sum2(eAB.lat, eAB.lon), gain: sum2(eAB.lat, eAB.lon) - sum2(eA.lat, eA.lon) },
    dtrel_4: { ctx: XB_N, H: sum2(eB.lat, eB.lon), baseCtx: 1020, baseH: sum2(eBB.lat, eBB.lon), gain: sum2(eBB.lat, eBB.lon) - sum2(eB.lat, eB.lon) },
    lonLatCross: { ctx: XD_N, H: eD.H, baseCtx: XC_N, baseH: eC.H, gain: eC.H - eD.H },
  };
}

/* ================================================================== *
 * alt channel
 * ================================================================== */

const ALT_QS = [1, 5, 10]; // alt unit is 0.1 m: /1, /5, /10 => 0.1 m, 0.5 m, 1.0 m
const ALT_PREDS = [
  { name: "d1", id: 0 },
  { name: "decay_d2", id: 1 },
];
const F_ALT_N = 8 * 9 * 5;
const ALT_SCHEMES = [
  { name: "ctx=0", size: 1, f: () => 0 },
  { name: "dalt9", size: 9, f: (d) => d.dalt + 4 },
  { name: "spd6", size: 6, f: (d) => SPD8_TO_6[d.spd8] },
  { name: "spd6+dalt9", size: 54, f: (d) => SPD8_TO_6[d.spd8] * 9 + (d.dalt + 4) },
  { name: "FULL", size: F_ALT_N, f: (d) => (d.spd8 * 9 + (d.dalt + 4)) * 5 + d.dtb },
];
for (const sc of ALT_SCHEMES) {
  const arr = new Int32Array(F_ALT_N);
  for (let f = 0; f < F_ALT_N; f++) {
    const dtb = f % 5;
    let r = (f - dtb) / 5;
    const daltI = r % 9;
    r = (r - daltI) / 9;
    arr[f] = sc.f({ spd8: r, dalt: daltI - 4, dtb });
  }
  sc.keyArr = arr;
  sc.f = null;
}
const ALT_PICK = "spd6+dalt9";

/** Full H1 treatment for these; the rest only get H0. */
const ALT_FINE_KEYS = ["1|0", "5|0", "10|0", "10|1"];

function analyzeAlt(tracks, prec) {
  const h0 = new Map();
  const mag = new Map();
  const fine = new Map();
  for (const q of ALT_QS) {
    for (const p of ALT_PREDS) {
      const k = q + "|" + p.id;
      h0.set(k, new Map());
      mag.set(k, new MagStats());
      if (ALT_FINE_KEYS.includes(k)) fine.set(k, new CtxHists(F_ALT_N));
    }
  }
  let nSamples = 0;

  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    const n = tr.n;
    const t = tr.t;
    const div = DIV_OF.get(prec);
    const lat = quantizeInt32(tr.lat, div);
    const lon = quantizeInt32(tr.lon, div);
    const alts = new Map();
    for (const q of ALT_QS) alts.set(q, q === 1 ? tr.alt : quantizeInt32(tr.alt, q));

    for (let i = START_I; i < n; i++) {
      const dtPrev = t[i - 1] - t[i - 2];
      const dtb = bucketDt(dtPrev);
      const spd = speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec);
      for (const q of ALT_QS) {
        const a = alts.get(q);
        const e1 = a[i] - a[i - 1];
        const ePrevD1 = a[i - 1] - a[i - 2];
        const ePrevD2 = a[i - 1] - (a[i - 2] + ((a[i - 2] - a[i - 3]) >> 1));
        const eDecay = a[i] - (a[i - 1] + (ePrevD1 >> 1));
        const k0 = q + "|0";
        const k1 = q + "|1";
        h0.get(k0).set(e1, (h0.get(k0).get(e1) || 0) + 1);
        mag.get(k0).add(e1);
        h0.get(k1).set(eDecay, (h0.get(k1).get(eDecay) || 0) + 1);
        mag.get(k1).add(eDecay);
        const f0 = fine.get(k0);
        if (f0) f0.add((spd * 9 + (signedBucket(ePrevD1, 4) + 4)) * 5 + dtb, e1);
        const f1 = fine.get(k1);
        if (f1) f1.add((spd * 9 + (signedBucket(ePrevD2, 4) + 4)) * 5 + dtb, eDecay);
      }
      nSamples += 1;
    }
  }

  const out = {};
  for (const q of ALT_QS) {
    for (const p of ALT_PREDS) {
      const k = q + "|" + p.id;
      const entry = {
        altQuantM: q / 10,
        predictor: p.name,
        nSamples,
        H0: hEntropy(h0.get(k), nSamples),
        kDistinct: h0.get(k).size,
        mag: mag.get(k).toJSON(),
        schemes: {},
      };
      const fh = fine.get(k);
      if (fh) {
        for (const sc of ALT_SCHEMES) {
          const coarse = fh.marginalize(sc.size, (f) => sc.keyArr[f]);
          const ce = condEntropy(coarse, nSamples);
          entry.schemes[sc.name] = { ctx: sc.size, H: ce.H, Hmm: ce.Hmm, kEff: ce.kEff };
        }
      }
      out[k] = entry;
    }
  }
  return out;
}

/* ================================================================== *
 * dt channel
 * ================================================================== */

const F_DT_N = 5 * 2;
const DT_SCHEMES = [
  { name: "ctx=0", size: 1, f: () => 0 },
  { name: "dtb5", size: 5, f: (d) => d.dtb },
  { name: "FULL", size: F_DT_N, f: (d) => d.dtb * 2 + d.zprev },
];

function analyzeDt(tracks) {
  const h0 = new Map();
  const mag = new MagStats();
  const fine = new CtxHists(F_DT_N);
  let nSamples = 0;
  for (const tr of tracks) {
    const n = tr.n;
    if (n <= START_I) continue;
    const t = tr.t;
    let ePrev = 0;
    for (let i = START_I; i < n; i++) {
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      const e = dtCur - dtPrev;
      const dtb = bucketDt(dtPrev);
      h0.set(e, (h0.get(e) || 0) + 1);
      mag.add(e);
      fine.add(dtb * 2 + (ePrev === 0 ? 0 : 1), e);
      ePrev = e;
      nSamples += 1;
    }
  }
  const schemes = {};
  for (const sc of DT_SCHEMES) {
    const coarse = fine.marginalize(sc.size, (f) => {
      if (sc.size === F_DT_N) return f;
      const zprev = f % 2;
      return sc.f({ dtb: (f - zprev) / 2, zprev });
    });
    const ce = condEntropy(coarse, nSamples);
    schemes[sc.name] = { ctx: sc.size, H: ce.H, Hmm: ce.Hmm, kEff: ce.kEff };
  }
  return { nSamples, H0: hEntropy(h0, nSamples), kDistinct: h0.size, schemes, mag: mag.toJSON(), dtValueHist: h0 };
}

/* ================================================================== *
 * Static / repeated points, regime occupancy, dt transitions
 * ================================================================== */

function analyzeStatic(tracks, prec) {
  const div = DIV_OF.get(prec);
  let n = 0;
  let bothSame = 0;
  let latSame = 0;
  let lonSame = 0;
  let dtChanged = 0;
  const spd8Count = new Float64Array(8);
  const bothSameBySpd8 = new Float64Array(8);
  const spd6Count = new Float64Array(6);
  let sumAbsDlat = 0;
  let sumAbsDlon = 0;
  const trans = new Map();
  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    const lat = quantizeInt32(tr.lat, div);
    const lon = quantizeInt32(tr.lon, div);
    const t = tr.t;
    for (let i = START_I; i < tr.n; i++) {
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      const spd = speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec);
      const dLat = lat[i] - lat[i - 1];
      const dLon = lon[i] - lon[i - 1];
      const ls = dLat === 0;
      const ns = dLon === 0;
      n += 1;
      if (ls) latSame += 1;
      if (ns) lonSame += 1;
      if (ls && ns) {
        bothSame += 1;
        bothSameBySpd8[spd] += 1;
      }
      if (dtCur !== dtPrev) {
        dtChanged += 1;
        const k = `${dtPrev}>${dtCur}`;
        trans.set(k, (trans.get(k) || 0) + 1);
      }
      spd8Count[spd] += 1;
      spd6Count[SPD8_TO_6[spd]] += 1;
      sumAbsDlat += dLat < 0 ? -dLat : dLat;
      sumAbsDlon += dLon < 0 ? -dLon : dLon;
    }
  }
  const topTrans = [...trans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    prec,
    nSamples: n,
    bothSameFrac: n ? bothSame / n : 0,
    latSameFrac: n ? latSame / n : 0,
    lonSameFrac: n ? lonSame / n : 0,
    dtChangedFrac: n ? dtChanged / n : 0,
    meanAbsDlat: n ? sumAbsDlat / n : 0,
    meanAbsDlon: n ? sumAbsDlon / n : 0,
    spd8Count: Array.from(spd8Count),
    spd8Frac: Array.from(spd8Count, (c) => (n ? c / n : 0)),
    spd6Frac: Array.from(spd6Count, (c) => (n ? c / n : 0)),
    spd6Names: SPD6_NAMES,
    bothSameFracBySpd8: Array.from(bothSameBySpd8, (c, i) => (spd8Count[i] ? c / spd8Count[i] : 0)),
    topDtTransitions: topTrans.map(([k, v]) => ({ transition: k, count: v, frac: v / dtChanged })),
    nDtChanged: dtChanged,
  };
}

/* ================================================================== *
 * What precision is the corpus *actually* stored at?
 * ================================================================== */
/*
 * GPZ V1 stored coordinates at 1e5 deg (~1.1 m) and V2 at 1e7. The decoder
 * always hands us 1e7-scaled ints, so a V1 track shows up as "every value is a
 * multiple of 100". This matters enormously: for a V1 track, quantising to 1e6
 * (or even 1e5) is *exactly lossless*, so the Tier-1 "slight loss" only applies
 * to the V2 subset.
 */
function analyzeLattice(tracks) {
  const classes = new Map(); // step -> { tracks, points, ids }
  let pts = 0;
  for (const tr of tracks) {
    let step = 1;
    for (const d of [100, 10]) {
      let ok = true;
      const l0 = tr.lat[0];
      const n0 = tr.lon[0];
      for (let i = 1; i < tr.n; i++) {
        if ((tr.lat[i] - l0) % d !== 0 || (tr.lon[i] - n0) % d !== 0) {
          ok = false;
          break;
        }
      }
      if (ok) {
        step = d;
        break;
      }
    }
    if (!classes.has(step)) classes.set(step, { tracks: 0, points: 0, ids: [] });
    const c = classes.get(step);
    c.tracks += 1;
    c.points += tr.n;
    if (c.ids.length < 6) c.ids.push(tr.id);
    pts += tr.n;
  }
  const out = { totalPoints: pts, classes: [] };
  for (const step of [100, 10, 1]) {
    const c = classes.get(step) || { tracks: 0, points: 0, ids: [] };
    out.classes.push({
      step,
      label: step === 100 ? "1e5 (1.11 m, GPZ V1)" : step === 10 ? "1e6 (11 cm)" : "1e7 (1.11 cm, GPZ V2)",
      tracks: c.tracks,
      points: c.points,
      pointFrac: pts ? c.points / pts : 0,
      ids: c.ids,
    });
  }
  return out;
}

/* ================================================================== *
 * Mantissa coding structure: flat per-bit vs low-first binary tree
 * ================================================================== */
/*
 * The design's slot layout codes the m mantissa bits with *independent* binary
 * models indexed by (m, k). That only reaches H(e) if the mantissa bits are
 * independent given m. On a coordinate lattice they are not: e.g. 83% of the
 * m=4 samples are u in {19, 20}, so (b0,b1,b2) are three deterministic
 * functions of the sign and the flat model pays ~3 bits instead of 1.
 *
 * A binary *tree* over the low q bits (conditioning each bit on the prefix)
 * recovers the joint entropy of those q bits at a cost of 2^q - 1 slots per m.
 * This function measures the ideal (no-learning) binarised cost for q = 0..6
 * and reports the trade-off.
 */
function analyzeMantissaTree(tracks, prec, pred) {
  const QMAX = 8;
  const MAXM = 26;
  const mCount = new Float64Array(MAXM + 2);
  const lowQ = Array.from({ length: MAXM + 2 }, () => new Float64Array(1 << QMAX));
  const bitCount = new Float64Array((MAXM + 2) * (MAXM + 2) * 2);
  const eHist = new Map();
  let n = 0;
  let zeros = 0;
  let escapes = 0;
  const MMAX = 23;

  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    const P = prepTrack(tr, prec, pred);
    const { n: N, eLat, eLon } = P;
    for (let i = START_I; i < N; i++) {
      const j = i - 2;
      for (const e of [eLat[j], eLon[j]]) {
        n += 1;
        eHist.set(e, (eHist.get(e) || 0) + 1);
        if (e === 0) {
          zeros += 1;
          continue;
        }
        const u = zigzag(e);
        const m = floorLog2(u);
        if (m >= MMAX - 1) {
          escapes += 1;
          continue;
        }
        mCount[m] += 1;
        lowQ[m][u & ((1 << QMAX) - 1)] += 1;
        for (let k = 0; k < m && k < MAXM; k++) {
          bitCount[m * (MAXM + 2) * 2 + k * 2 + ((Math.floor(u / 2 ** k) & 1) | 0)] += 1;
        }
      }
    }
  }

  const H = (counts, total) => {
    let h = 0;
    for (const c of counts) {
      if (c > 0) {
        const p = c / total;
        h -= p * Math.log2(p);
      }
    }
    return h;
  };

  const He = H(eHist.values(), n);
  const pz = zeros / n;
  const Hzero = pz > 0 && pz < 1 ? -pz * Math.log2(pz) - (1 - pz) * Math.log2(1 - pz) : 0;

  // per-m: count, and for each q the cost of the low-q tree + flat higher bits
  const rows = [];
  for (let q = 0; q <= 6; q++) {
    let mantBits = 0;
    let slotPerM = 0;
    for (let m = 0; m < MAXM; m++) {
      const cnt = mCount[m];
      if (!cnt) continue;
      const share = cnt / (n - zeros); // P(m | nonzero)
      let cost;
      if (q === 0) {
        // fully flat: independent marginal of every bit position
        cost = 0;
        for (let k = 0; k < m; k++) {
          const base = m * (MAXM + 2) * 2 + k * 2;
          cost += H([bitCount[base], bitCount[base + 1]], cnt);
        }
        slotPerM = MMAX;
      } else {
        const qe = Math.min(q, m);
        // joint entropy of the low qe bits (a full binary tree over them)
        const buckets = new Map();
        const mask = (1 << qe) - 1;
        const lowAll = lowQ[m];
        for (let v = 0; v < 1 << QMAX; v++) {
          const c = lowAll[v];
          if (c > 0) {
            const key = v & mask;
            buckets.set(key, (buckets.get(key) || 0) + c);
          }
        }
        cost = H(buckets.values(), cnt);
        // remaining bits (>= qe) flat
        for (let k = qe; k < m; k++) {
          const base = m * (MAXM + 2) * 2 + k * 2;
          cost += H([bitCount[base], bitCount[base + 1]], cnt);
        }
        slotPerM = (1 << q) - 1 + Math.max(0, MMAX - q);
      }
      mantBits += share * cost;
    }
    const ideal = Hzero + (1 - pz) * (H(mCount, n - zeros) + mantBits);
    const nSlot = 1 + MMAX + (q === 0 ? MMAX * MMAX : MMAX * slotPerM);
    rows.push({
      q,
      bitsPerAxis: ideal,
      bitsPerPoint: ideal * 2,
      mantissaBitsPerAxis: (1 - pz) * mantBits,
      nSlot,
      slotBytes: nSlot * 2,
      tableKBat1020: (nSlot * 2 * 1020) / 1024,
    });
  }

  return { n, zeros, escapes, He, Hzero, zfrac: pz, rows };
}

/* ================================================================== *
 * Leave-one-track-out code length of the two-part model
 * ================================================================== */
/*
 * The real coder charges, per residual:
 *   zero flag        (binary, per ctx)
 *   unary order m    (per ctx, and per m within the ctx)
 *   m mantissa bits  (per ctx x m; ≈ m bits, slight gains from sign modelling)
 * We charge exactly those three parts, with a ctx -> corpus backoff, and
 * subtract the track's own counts (LOSO) so the estimate is unbiased.
 */
const MC = 25; // order clamp; values above pay an escape surcharge
const MCBINS = MC + 1;
const LOSO_A = 4; // ctx -> corpus backoff weight
const LOSO_B = 200; // corpus order distribution -> uniform weight
const P_UNIF_ORDER = 1 / (MCBINS + 1);

function orderOf(e) {
  if (e === 0) return -1;
  const m = floorLog2(zigzag(e));
  return m > MC ? MC : m;
}

function newChan() {
  return { z: new Map(), nz: new Map(), om: new Map() };
}

/** Global flat-mantissa bit statistics: [m][k][bit]. */
function newMantModel() {
  return new Float64Array((MC + 1) * (MC + 1) * 2);
}

/** Expected flat bitwise mantissa cost (bits) for each order m. */
function mantCosts(mantModel) {
  const out = new Float64Array(MCBINS);
  for (let m = 0; m < MCBINS; m++) {
    let h = 0;
    for (let k = 0; k < m && k < MC; k++) {
      const base = (m * (MC + 1) + k) * 2;
      const c0 = mantModel[base];
      const c1 = mantModel[base + 1];
      const t = c0 + c1;
      if (t === 0) continue;
      for (const c of [c0, c1]) {
        if (c > 0) {
          const p = c / t;
          h -= p * Math.log2(p);
        }
      }
    }
    out[m] = h;
  }
  return out;
}

function chanAdd(ch, ctx, e, mantModel) {
  const m = orderOf(e);
  if (m < 0) {
    ch.z.set(ctx, (ch.z.get(ctx) || 0) + 1);
    return;
  }
  ch.nz.set(ctx, (ch.nz.get(ctx) || 0) + 1);
  const k = ctx * MCBINS + m;
  ch.om.set(k, (ch.om.get(k) || 0) + 1);
  if (mantModel) {
    const u = zigzag(e);
    for (let b = 0; b < m && b < MC; b++) {
      const bit = Math.floor(u / 2 ** b) & 1;
      mantModel[(m * (MC + 1) + b) * 2 + bit] += 1;
    }
  }
}

function chanMerge(dst, src) {
  for (const [k, v] of src.z) dst.z.set(k, (dst.z.get(k) || 0) + v);
  for (const [k, v] of src.nz) dst.nz.set(k, (dst.nz.get(k) || 0) + v);
  for (const [k, v] of src.om) dst.om.set(k, (dst.om.get(k) || 0) + v);
}

function chanTotals(ch) {
  const nCtx = new Map();
  for (const [k, v] of ch.z) nCtx.set(k, v);
  for (const [k, v] of ch.nz) nCtx.set(k, (nCtx.get(k) || 0) + v);
  const oG = new Float64Array(MCBINS);
  let z = 0;
  let nz = 0;
  for (const v of ch.z.values()) z += v;
  for (const v of ch.nz.values()) nz += v;
  for (const [k, v] of ch.om) oG[k % MCBINS] += v;
  return { nCtx, nzByCtx: ch.nz, oG, z, nz, n: z + nz };
}

/** LOSO code length (bits) of one track for one channel.
 *  Mantissa is charged at the *global flat bitwise* expected cost (matches the
 *  design's slot layout); zero flag and order are charged LOSO. */
function chargeChanLoso(track, glob, gt, tt, mantC) {
  let bits = 0;
  const gzL = gt.z - tt.z;
  const gnL = gt.n - tt.n;
  const gzGlob = (gzL + 0.5) / (gnL + 1);

  for (const [ctx, zt] of track.z) {
    const nt = tt.nCtx.get(ctx) || 0;
    const zL = (glob.z.get(ctx) || 0) - zt;
    const nL = (gt.nCtx.get(ctx) || 0) - nt;
    const pZero = (zL + LOSO_A * gzGlob) / ((nL > 0 ? nL : 0) + LOSO_A);
    bits += zt * -Math.log2(pZero);
  }
  for (const [ctx, nzt] of track.nz) {
    const nt = tt.nCtx.get(ctx) || 0;
    const nzL = (glob.nz.get(ctx) || 0) - nzt;
    const nL = (gt.nCtx.get(ctx) || 0) - nt;
    const pNz = (nzL + LOSO_A * (1 - gzGlob)) / ((nL > 0 ? nL : 0) + LOSO_A);
    bits += nzt * -Math.log2(pNz);
  }
  for (const [k, c] of track.om) {
    const ctx = (k - (k % MCBINS)) / MCBINS;
    const m = k % MCBINS;
    const nzT = tt.nzByCtx.get(ctx) || 0;
    const nzL = (glob.nz.get(ctx) || 0) - nzT;
    const oCtxL = (glob.om.get(k) || 0) - c;
    const oGlobLoso = gt.oG[m] - (tt.oG[m] || 0);
    const nzGlobLoso = gt.nz - tt.nz;
    const pOrderGlob = (oGlobLoso + LOSO_B * P_UNIF_ORDER) / (nzGlobLoso + LOSO_B);
    const pOrder = (oCtxL + LOSO_A * pOrderGlob) / ((nzL > 0 ? nzL : 0) + LOSO_A);
    const mant = m >= MC ? MC + 2 : mantC[m];
    bits += c * (-Math.log2(pOrder) + mant);
  }
  return bits;
}

function perTrackAnalysis(tracks, prec, pred, coordSchemeName, altQ, altPredName) {
  const coordScheme = SCHEME_BY_NAME.get(coordSchemeName);
  const altScheme = ALT_SCHEMES.find((s) => s.name === ALT_PICK);
  const altDiv = altQ;
  const altIsD1 = altPredName === "d1";

  const glob = { lat: newChan(), lon: newChan(), alt: newChan(), dt: newChan() };
  const t0 = Date.now();

  const walk = (cb) => {
    for (const tr of tracks) {
      if (tr.n <= START_I) continue;
      const P = prepTrack(tr, prec, pred);
      const { n, t, lat, lon, eLat, eLon } = P;
      const alt = altDiv === 1 ? tr.alt : quantizeInt32(tr.alt, altDiv);
      for (let i = START_I; i < n; i++) {
        const j = i - 2;
        const dtPrev = t[i - 1] - t[i - 2];
        const dtCur = t[i] - t[i - 1];
        const dtb = bucketDt(dtPrev);
        const dchg = dtCur === dtPrev ? 0 : 1;
        const spd = speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec);
        cb({
          tr,
          n,
          nT: tr.n,
          eL: eLat[j],
          eN: eLon[j],
          eA: altIsD1 ? alt[i] - alt[i - 1] : alt[i] - (alt[i - 1] + ((alt[i - 1] - alt[i - 2]) >> 1)),
          eDt: dtCur - dtPrev,
          keyL: coordScheme.keyArr[fineKey(spd, signedBucket(eLat[j - 1], 8), dchg, dtb)],
          keyN: coordScheme.keyArr[fineKey(spd, signedBucket(eLon[j - 1], 8), dchg, dtb)],
          keyA: altScheme.keyArr[(spd * 9 + (signedBucket(alt[i - 1] - alt[i - 2], 4) + 4)) * 5 + dtb],
          keyD: dtb * 2 + (i >= 5 && t[i - 1] - t[i - 2] === t[i - 2] - t[i - 3] ? 1 : 0),
          maxAbs: Math.max(Math.abs(eLat[j]), Math.abs(eLon[j])),
        });
      }
    }
  };

  // ---- pass A: corpus tables ----
  const mantModels = { lat: newMantModel(), lon: newMantModel(), alt: newMantModel(), dt: newMantModel() };
  walk((p) => {
    chanAdd(glob.lat, p.keyL, p.eL, mantModels.lat);
    chanAdd(glob.lon, p.keyN, p.eN, mantModels.lon);
    chanAdd(glob.alt, p.keyA, p.eA, mantModels.alt);
    chanAdd(glob.dt, p.keyD, p.eDt, mantModels.dt);
  });
  const G = {
    lat: chanTotals(glob.lat),
    lon: chanTotals(glob.lon),
    alt: chanTotals(glob.alt),
    dt: chanTotals(glob.dt),
  };
  const MANT = {
    lat: mantCosts(mantModels.lat),
    lon: mantCosts(mantModels.lon),
    alt: mantCosts(mantModels.alt),
    dt: mantCosts(mantModels.dt),
  };

  // ---- pass B: per track ----
  const tB = Date.now();
  const out = [];
  let cur = null;
  walk((p) => {
    if (cur === null || cur.tr !== p.tr) {
      cur = {
        id: p.tr.id,
        n: p.tr.n,
        ns: 0,
        maxAbs: 0,
        big: 0,
        ch: { lat: newChan(), lon: newChan(), alt: newChan(), dt: newChan() },
        tr: p.tr,
      };
      out.push(cur);
    }
    chanAdd(cur.ch.lat, p.keyL, p.eL);
    chanAdd(cur.ch.lon, p.keyN, p.eN);
    chanAdd(cur.ch.alt, p.keyA, p.eA);
    chanAdd(cur.ch.dt, p.keyD, p.eDt);
    if (p.maxAbs > cur.maxAbs) cur.maxAbs = p.maxAbs;
    if (p.maxAbs >= 4096) cur.big += 1;
    cur.ns += 1;
  });

  const rows = out.map((t) => {
    const per = {};
    let bits = 0;
    for (const name of ["lat", "lon", "alt", "dt"]) {
      const b = chargeChanLoso(t.ch[name], glob[name], G[name], chanTotals(t.ch[name]), MANT[name]);
      per[name] = t.ns ? b / t.ns : 0;
      bits += b;
    }
    return {
      id: t.id,
      n: t.n,
      ns: t.ns,
      bitsPerPt: t.ns ? bits / t.ns : 0,
      parts: per,
      maxAbs: t.maxAbs,
      bigFrac: t.ns ? t.big / t.ns : 0,
    };
  });
  const passBms = Date.now() - tB;

  // ---- aggregates ----
  const valid = rows.filter((p) => p.ns > 0);
  const totalScored = valid.reduce((a, p) => a + p.ns, 0);
  const totalCost = valid.reduce((a, p) => a + p.bitsPerPt * p.ns, 0);
  const pooled = totalScored ? totalCost / totalScored : 0;
  const dist = summarize(valid.map((p) => p.bitsPerPt));

  const classDefs = [
    ["n<=10", 0, 10],
    ["11-100", 10, 100],
    ["101-1k", 100, 1000],
    ["1k-10k", 1000, 10000],
    ["10k-100k", 10000, 100000],
    [">100k", 100000, Infinity],
  ];
  const classes = classDefs.map(([label, lo, hi]) => {
    const sel = valid.filter((p) => p.n > lo && p.n <= hi);
    const pts = sel.reduce((a, p) => a + p.ns, 0);
    const c = sel.reduce((a, p) => a + p.bitsPerPt * p.ns, 0);
    return {
      label,
      tracks: sel.length,
      points: pts,
      bitsPerPt: pts ? c / pts : 0,
      medianTrackBitsPerPt: sel.length ? summarize(sel.map((r) => r.bitsPerPt)).median : 0,
    };
  });

  const sorted = [...valid].sort((a, b) => b.bitsPerPt * b.ns - a.bitsPerPt * a.ns);
  const totalBits = sorted.reduce((a, p) => a + p.bitsPerPt * p.ns, 0);
  const topN = 10;
  const top = sorted.slice(0, topN).map((p) => ({
    id: p.id,
    n: p.n,
    bitsPerPt: p.bitsPerPt,
    share: totalBits ? (p.bitsPerPt * p.ns) / totalBits : 0,
    maxAbs: p.maxAbs,
  }));
  const tailShare = totalBits
    ? sorted.slice(topN).reduce((a, p) => a + p.bitsPerPt * p.ns, 0) / totalBits
    : 0;

  return {
    prec,
    predictor: PRED_NAME[pred],
    coordScheme: coordSchemeName,
    altQuantM: altQ / 10,
    altPredictor: altPredName,
    nTracksScored: valid.length,
    nTracksZeroSample: rows.length - valid.length,
    nScored: totalScored,
    pooledBitsPerPt: pooled,
    channelBitsPerPt: (() => {
      const o = {};
      for (const name of ["lat", "lon", "alt", "dt"]) {
        let s = 0;
        for (const p of valid) s += p.parts[name] * p.ns;
        o[name] = totalScored ? s / totalScored : 0;
      }
      return o;
    })(),
    perTrackDist: dist,
    classes,
    top,
    tailShare,
    passBms,
    tracks: rows,
  };
}

/* ================================================================== *
 * Adaptive binarised range-coder simulation
 * ================================================================== */

function adaptiveSim(tracks, prec, pred, schemeName, mMax, resetPerTrack) {
  const scheme = SCHEME_BY_NAME.get(schemeName);
  const layout = slotLayout(mMax, 32);
  const nCtx = scheme.size * 2;
  const model = new SlotModel(nCtx, layout.nSlot);
  let escapes = 0;
  const stats = { escapes: 0 };
  let cost = 0;
  let nSamples = 0;
  const t0 = Date.now();

  for (const tr of tracks) {
    if (tr.n <= START_I) continue;
    if (resetPerTrack) model.reset();
    const P = prepTrack(tr, prec, pred);
    const { n, t, lat, lon, eLat, eLon } = P;
    for (let i = START_I; i < n; i++) {
      const j = i - 2;
      const dtPrev = t[i - 1] - t[i - 2];
      const dtCur = t[i] - t[i - 1];
      const dtb = bucketDt(dtPrev);
      const dchg = dtCur === dtPrev ? 0 : 1;
      const spd = speedRegime8(lat[i - 2], lat[i - 1] - lat[i - 2], lon[i - 1] - lon[i - 2], dtPrev, prec);
      const keyL = scheme.keyArr[fineKey(spd, signedBucket(eLat[j - 1], 8), dchg, dtb)];
      const keyN = scheme.keyArr[fineKey(spd, signedBucket(eLon[j - 1], 8), dchg, dtb)];
      stats.escapes = 0;
      cost += chargeResidual(model, layout, keyL * layout.nSlot, eLat[j], stats);
      cost += chargeResidual(model, layout, (scheme.size + keyN) * layout.nSlot, eLon[j], stats);
      escapes += stats.escapes;
      nSamples += 1;
    }
  }

  return {
    prec,
    predictor: PRED_NAME[pred],
    scheme: schemeName,
    ctx: scheme.size,
    mMax,
    nSlot: layout.nSlot,
    resetPerTrack,
    bitsPerPt: nSamples ? cost / nSamples : 0,
    escapes,
    elapsedMs: Date.now() - t0,
  };
}

/* ================================================================== *
 * Reporting
 * ================================================================== */
function mdTable(headers, rows, aligns) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  out("| " + headers.map((h, i) => padEnd(String(h), widths[i])).join(" | ") + " |");
  out(
    "|" +
      widths
        .map((w, i) => (aligns && aligns[i] === "r" ? " " + "-".repeat(w) + ": " : " :" + "-".repeat(w) + " "))
        .join("|") +
      "|"
  );
  for (const r of rows) {
    out(
      "| " +
        headers
          .map((_, i) =>
            aligns && aligns[i] === "r" ? padStart(String(r[i] ?? ""), widths[i]) : padEnd(String(r[i] ?? ""), widths[i])
          )
          .join(" | ") +
        " |"
    );
  }
}

function out(s = "") {
  console.log(s);
}

/* ================================================================== *
 * main
 * ================================================================== */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tStart = Date.now();
  const tracks = loadDataset();
  const N_ALL = totalPoints(tracks);
  const gpzSizes = loadGpzSizes();
  let gpzBytes = 0;
  for (const s of gpzSizes.values()) gpzBytes += s;
  const gpzBitsPerPt = (gpzBytes * 8) / N_ALL;
  const sizesSorted = tracks.map((t) => t.n).sort((a, b) => a - b);

  const result = {
    generatedAt: new Date().toISOString(),
    config: {
      precisionDefault: 1e6,
      precisions: opts.precisions,
      startIndex: START_I,
      fineContext: { speedRegimes: 8, prevQ1: 17, dtChanged: 2, prevDtBuckets: 5 },
      coordinateSchemes: SCHEMES.map((s) => ({ name: s.name, ctx: s.size })),
      coordPick: COORD_PICK,
      loso: { alphaCtx: LOSO_A, betaGlobal: LOSO_B, mClamp: MC },
    },
    dataset: {
      tracks: tracks.length,
      points: N_ALL,
      gpzBytes,
      gpzBitsPerPt,
      trackSizeMin: sizesSorted[0],
      trackSizeMedian: summarize(sizesSorted).median,
      trackSizeMax: sizesSorted[sizesSorted.length - 1],
    },
  };

  out("### GPSL0 Step-1 entropy ablation (predictor x context)");
  out("");
  out(
    `dataset: ${tracks.length} tracks, ${N_ALL.toLocaleString("en-US")} points; GPZ V2 baseline ` +
      `${gpzBytes.toLocaleString("en-US")} B = ${fn(gpzBitsPerPt, 2)} bits/pt`
  );
  out(
    `track sizes: min ${result.dataset.trackSizeMin}, median ${result.dataset.trackSizeMedian}, ` +
      `max ${result.dataset.trackSizeMax} points; scoring starts at i=${START_I} ` +
      `(needs x[i-3] so prev_q1 is defined for d2 predictors as well)`
  );
  out("");

  /* ---------------- 1) predictor comparison ---------------- */
  const coordCache = new Map();
  const getCoord = (prec, pred) => {
    const k = prec + "|" + pred;
    if (!coordCache.has(k)) coordCache.set(k, analyzeCoord(tracks, prec, pred));
    return coordCache.get(k);
  };

  out(`## 1. Predictor comparison (lat/lon; ctx = ${COORD_PICK} = 1020)`);
  out("");
  result.predictors = {};
  const predRows = [];
  for (const prec of opts.precisions) {
    result.predictors[prec] = {};
    const nPreds = prec === 1e6 ? 4 : 3; // hybrid variant only at the default tier
    for (let pred = 0; pred < nPreds; pred++) {
      const a = getCoord(prec, pred);
      const s = a.schemes[COORD_PICK];
      const s204 = a.schemes["spd6+q1+dchg"];
      result.predictors[prec][PRED_NAME[pred]] = {
        nSamples: a.nSamples,
        H0: a.H0,
        H1: s,
        H1_204: s204,
        H1_ctx0: a.schemes["ctx=0"],
        mag: a.mag,
      };
      predRows.push([
        String(prec),
        PRED_NAME[pred],
        fn(a.H0.sum, 3),
        fn(s.Hlat, 3),
        fn(s.Hlon, 3),
        fn(s.Hsum, 3),
        fn(s.HsumMm, 3),
        fn(s204.Hsum, 3),
        fn(a.schemes["ctx=0"].Hsum - s.Hsum, 3),
        a.elapsedMs + " ms",
      ]);
    }
  }
  mdTable(
    ["prec", "predictor", "H0 lat+lon", "H1 lat", "H1 lon", "H1 sum", "H1_mm", "H1@204", "H0->H1 gain", "pass"],
    predRows,
    [null, null, "r", "r", "r", "r", "r", "r", "r", "r"]
  );
  out("");
  out(
    "  H0 is the zero-order entropy of the residual stream (ceiling with no context); H1 is with the " +
      "1020-context model. Both are plugin estimates = ORACLE lower bounds."
  );
  out("");

  /* ---------------- 2) context ablation ---------------- */
  out("## 2. Context ablation / marginal returns (coordinate channels)");
  out("");
  result.ctxAblation = {};
  let bestPredName = "naive_d2";
  if (opts.precisions.includes(1e6)) {
    bestPredName = Object.entries(result.predictors[1e6]).sort(
      (a, b) => a[1].H1.Hsum - b[1].H1.Hsum
    )[0][0];
  }
  const bestPred = PRED_NAME.indexOf(bestPredName);
  out(`chosen predictor (lowest H1 lat+lon at 1e6): **${bestPredName}**`);
  out("");

  for (const prec of opts.precisions) {
    const a = getCoord(prec, bestPred);
    const ordered = [...SCHEMES].sort((x, y) => x.size - y.size);
    const rows = [];
    let prevCtx = 0;
    let prevH = a.schemes["ctx=0"].Hsum;
    let prevHmm = a.schemes["ctx=0"].HsumMm;
    for (const sc of ordered) {
      const s = a.schemes[sc.name];
      const incH = prevH - s.Hsum;
      const incHmm = prevHmm - s.HsumMm;
      const dCtx = sc.size - prevCtx;
      rows.push([
        sc.name,
        String(sc.size),
        fn(s.Hlat, 3),
        fn(s.Hlon, 3),
        fn(s.Hsum, 3),
        fn(s.HsumMm, 3),
        fn(a.schemes["ctx=0"].Hsum - s.Hsum, 3),
        fn(incH, 3),
        dCtx > 0 ? fn((incH / dCtx) * 100, 4) : "-",
        fn(incHmm, 3),
        s.Hshared >= 0 ? fn(s.Hshared * 2, 3) : "-",
        String(s.kEff),
        tablesMB(sc.size).toFixed(2),
      ]);
      prevCtx = sc.size;
      prevH = s.Hsum;
      prevHmm = s.HsumMm;
    }
    mdTable(
      ["scheme", "ctx", "H1 lat", "H1 lon", "H1 sum", "H1_mm", "gain vs ctx=0", "incremental", "gain/100ctx", "incremental_mm", "shared H1", "k_eff", "tables MB"],
      rows,
      [null, "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r"]
    );
    result.ctxAblation[prec] = { predictor: bestPredName, schemes: a.schemes };
    out("");
  }
  out(
    "  `incremental` = oracle bits/pt bought by moving from the previous (smaller) scheme to this one; " +
      "`gain/100ctx` normalises per 100 contexts added; `incremental_mm` is the same on the " +
      "bias-corrected entropy - that is what survives a real adaptive coder. `shared H1` = lat+lon on ONE " +
      "shared table set (x2 so it is comparable to H1 sum)."
  );
  out("");

  /* ---------------- 2b) single-dimension granularity ---------------- */
  if (opts.precisions.includes(1e6)) {
    out("## 2b. Isolated dimension-granularity experiments (1e6, chosen predictor)");
    out("");
    const x = analyzeExtraDims(tracks, 1e6, bestPred);
    result.extraDims = x;
    mdTable(
      ["refinement", "base ctx", "H1 base", "new ctx", "H1 refined", "isolated gain", "extra ctx"],
      [
        ["q1 17 -> 33 buckets", String(x.q1_33.baseCtx), fn(x.q1_33.baseH, 3), String(x.q1_33.ctx), fn(x.q1_33.H, 3), fn(x.q1_33.gain, 3), String(x.q1_33.ctx - x.q1_33.baseCtx)],
        ["dt_changed 2 -> dt_relation 4", String(x.dtrel_4.baseCtx), fn(x.dtrel_4.baseH, 3), String(x.dtrel_4.ctx), fn(x.dtrel_4.H, 3), fn(x.dtrel_4.gain, 3), String(x.dtrel_4.ctx - x.dtrel_4.baseCtx)],
        ["lon | ... + bucket17(lat residual)", String(x.lonLatCross.baseCtx), fn(x.lonLatCross.baseH, 3), String(x.lonLatCross.ctx), fn(x.lonLatCross.H, 3), fn(x.lonLatCross.gain, 3), String(x.lonLatCross.ctx - x.lonLatCross.baseCtx)],
      ],
      [null, "r", "r", "r", "r", "r", "r"]
    );
    out("");
    out(
      "  each row re-runs the whole corpus with exactly one dimension changed and marginalises back to " +
        "the same base, so the gain is not confounded with the rest of the context."
    );
    out("");
  }

  /* ---------------- 3) static / regimes ---------------- */
  out("## 3. Repeated points, speed-regime occupancy, dt structure");
  out("");
  result.static = {};
  const staticRows = [];
  for (const prec of opts.precisions) {
    const s = analyzeStatic(tracks, prec);
    result.static[prec] = s;
    staticRows.push([
      String(prec),
      pct(s.bothSameFrac),
      pct(s.latSameFrac),
      pct(s.lonSameFrac),
      pct(s.dtChangedFrac),
      fn(s.meanAbsDlat, 1),
      fn(s.meanAbsDlon, 1),
      s.spd6Frac.map((f) => pct(f, 1)).join(" / "),
    ]);
  }
  mdTable(
    ["prec", "lat&lon same", "lat same", "lon same", "dt changed", "mean|dlat|", "mean|dlon|", "spd6 frac"],
    staticRows,
    [null, "r", "r", "r", "r", "r", "r", null]
  );
  out("");
  out(`  ${REGIME_LEGEND}`);
  out(`  ${REGIME8_LEGEND}`);
  const s16 = result.static[opts.precisions.includes(1e6) ? 1e6 : opts.precisions[0]];
  out("");
  mdTable(
    ["dtPrev>dtCur", "points", "share of changed"],
    s16.topDtTransitions.map((t) => [t.transition, String(t.count), pct(t.frac, 2)]),
    [null, "r", "r"]
  );
  out("");
  out(
    `  ${pct(s16.dtChangedFrac, 2)} of scored points have dtCur != dtPrev, and ` +
      `${pct(s16.topDtTransitions.slice(0, 2).reduce((a, t) => a + t.frac, 0), 1)} of those are just the ` +
      `1s<->2s alternation. This is where time-normalised d2 and naive d2 differ.`
  );
  out("");

  /* ---------------- 3b) corpus precision lattice ---------------- */
  const lat = analyzeLattice(tracks);
  result.lattice = lat;
  out("## 3b. What precision is the corpus actually stored at?");
  out("");
  mdTable(
    ["coordinate lattice", "tracks", "points", "share", "examples"],
    lat.classes.map((c) => [c.label, String(c.tracks), c.points.toLocaleString("en-US"), pct(c.pointFrac, 2), c.ids.slice(0, 3).join(", ")]),
    [null, "r", "r", "r", null]
  );
  out("");
  const v1 = lat.classes.find((c) => c.step === 100);
  out(
    `  ${pct(v1.pointFrac, 2)} of all points come from GPZ **V1** files, which were already quantised to 1e5 deg ` +
      `(~1.1 m) on the device. For those tracks a 1e6 (Tier-1) encode is EXACTLY LOSSLESS, and even 1e5 is.`
  );
  out(
    `  The Tier-1 vs Tier-0 difference therefore only concerns ${lat.classes.find((c) => c.step === 1).tracks} tracks / ` +
      `${lat.classes.find((c) => c.step === 1).points.toLocaleString("en-US")} points ` +
      `(${pct(lat.classes.find((c) => c.step === 1).pointFrac, 2)}). Do not calibrate the tier decision on this corpus alone.`
  );
  out("");

  /* ---------------- 4) alt channel ---------------- */
  out("## 4. alt channel (0.1 m units, requantised per tier)");
  out("");
  result.alt = {};
  const altRows = [];
  for (const prec of opts.precisions) {
    const a = analyzeAlt(tracks, prec);
    result.alt[prec] = a;
    for (const q of ALT_QS) {
      for (const p of ALT_PREDS) {
        const e = a[q + "|" + p.id];
        const s54 = e.schemes[ALT_PICK];
        const sFull = e.schemes["FULL"];
        altRows.push([
          String(prec),
          e.altQuantM.toFixed(1) + " m",
          p.name,
          fn(e.H0, 3),
          s54 ? fn(s54.H, 3) : "-",
          sFull ? fn(sFull.H, 3) : "-",
          s54 ? fn(e.H0 - s54.H, 3) : "-",
          pct(e.mag.zeroFrac, 1),
          String(e.kDistinct),
        ]);
      }
    }
  }
  mdTable(
    ["prec", "alt quant", "predictor", "H0", "H1(54)", "H1(360)", "H0->H1 gain", "e==0", "distinct"],
    altRows,
    [null, "r", null, "r", "r", "r", "r", "r", "r"]
  );
  out("");

  /* ---------------- 5) dt channel ---------------- */
  out("## 5. dt channel (e_dt = dt[i] - dt[i-1])");
  out("");
  const dt = analyzeDt(tracks);
  result.dt = { nSamples: dt.nSamples, H0: dt.H0, kDistinct: dt.kDistinct, schemes: dt.schemes, mag: dt.mag };
  mdTable(
    ["scheme", "ctx", "H(e_dt|ctx)", "H_mm", "k_eff"],
    Object.entries(dt.schemes).map(([n, s]) => [n, String(s.ctx), fn(s.H, 4), fn(s.Hmm, 4), String(s.kEff)]),
    [null, "r", "r", "r", "r"]
  );
  const dtTop = [...dt.dtValueHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  out(
    `  top e_dt values: ${dtTop.map(([v, c]) => `${v}:${pct(c / dt.nSamples, 3)}`).join(", ")}; ` +
      `distinct=${dt.kDistinct}`
  );
  out("");

  /* ---------------- 6) residual magnitude ---------------- */
  out("## 6. Residual magnitude: zigzag order m = floor(log2 u), tails, M_MAX");
  out("");
  result.magnitude = {};
  const magSources = [];
  if (opts.precisions.includes(1e6)) {
    const b = result.predictors[1e6][bestPredName].mag;
    magSources.push({ label: `lat@1e6 ${bestPredName}`, m: b.lat });
    magSources.push({ label: `lon@1e6 ${bestPredName}`, m: b.lon });
  }
  if (opts.precisions.includes(1e7)) {
    const b = result.predictors[1e7][bestPredName].mag;
    magSources.push({ label: `lat@1e7 ${bestPredName}`, m: b.lat });
    magSources.push({ label: `lon@1e7 ${bestPredName}`, m: b.lon });
  }
  magSources.push({ label: "alt 0.1m d1", m: result.alt[opts.precisions[0]]["1|0"].mag });
  magSources.push({ label: "dt", m: dt.mag });

  let maxMSeen = 0;
  for (const src of magSources) for (let m = 0; m < 48; m++) if (src.m.mHist[m]) maxMSeen = Math.max(maxMSeen, m);
  const mRows = [];
  for (let m = 0; m <= maxMSeen; m++) {
    const cells = [String(m)];
    let any = false;
    for (const src of magSources) {
      const tot = src.m.n || 1;
      const c = src.m.mHist[m] || 0;
      if (c) any = true;
      cells.push(c === 0 ? "0" : pct(c / tot, 3));
    }
    if (any) mRows.push(cells);
  }
  mdTable(["m", ...magSources.map((s) => s.label)], mRows, ["r", ...magSources.map(() => "r")]);
  out("");
  for (const src of magSources) result.magnitude[src.label] = src.m;
  mdTable(
    ["channel", "n", "e==0", "max|e|", ">=2^12", ">=2^16", ">=2^18", ">=2^20", ">=2^21", ">=2^22", ">=2^24"],
    magSources.map((src) => [
      src.label,
      String(src.m.n),
      pct(src.m.zeroFrac, 2),
      String(src.m.maxAbs),
      pct(src.m.ge2p12, 4),
      pct(src.m.ge2p16, 5),
      pct(src.m.ge2p18, 5),
      pct(src.m.ge2p20, 5),
      pct(src.m.ge2p21, 5),
      pct(src.m.ge2p22, 5),
      pct(src.m.ge2p24, 5),
    ]),
    [null, "r", "r", "r", "r", "r", "r", "r", "r", "r", "r"]
  );
  out("");
  const c6 = result.predictors[opts.precisions.includes(1e6) ? 1e6 : opts.precisions[0]][bestPredName];
  const cdfOf = (mag, lim) => {
    const n = mag.n || 1;
    let s = mag.zeroFrac;
    for (let m = 0; m <= lim; m++) s += mag.mHist[m] / n;
    return s;
  };
  const lat6 = c6.mag.lat;
  const lon6 = c6.mag.lon;
  result.magnitude.cdf = {
    tier: opts.precisions.includes(1e6) ? 1e6 : opts.precisions[0],
    latLe12: cdfOf(lat6, 12),
    latLe19: cdfOf(lat6, 19),
    latLe20: cdfOf(lat6, 20),
    latLe21: cdfOf(lat6, 21),
    latLe22: cdfOf(lat6, 22),
    latLe23: cdfOf(lat6, 23),
    lonLe20: cdfOf(lon6, 20),
    lonLe21: cdfOf(lon6, 21),
    lonLe22: cdfOf(lon6, 22),
  };
  out(
    `  Tier-1 lat: m<=12 ${pct(cdfOf(lat6, 12), 3)} | m<=19 ${pct(cdfOf(lat6, 19), 3)} | m<=20 ` +
      `${pct(cdfOf(lat6, 20), 4)} | m<=21 ${pct(cdfOf(lat6, 21), 4)} | m<=22 ${pct(cdfOf(lat6, 22), 5)}`
  );
  out(
    `  Tier-1 lon: m<=20 ${pct(cdfOf(lon6, 20), 4)} | m<=21 ${pct(cdfOf(lon6, 21), 4)} | m<=22 ` +
      `${pct(cdfOf(lon6, 22), 5)}`
  );
  out(
    "  M_MAX=22 covers m<=21 (|e|<=2^20) only; larger values need the escape path. So the decision is " +
      "'M_MAX=22 + escape' (529 mantissa slots/ctx) vs 'M_MAX=23/24 + no escape' (approx 1.3x table)."
  );
  out("");

  /* ---------------- 6b) mantissa coding structure ---------------- */
  const mtree = analyzeMantissaTree(tracks, opts.precisions.includes(1e6) ? 1e6 : opts.precisions[0], bestPred);
  result.mantissaTree = mtree;
  out("## 6b. Mantissa coding structure: flat per-bit vs low-first binary tree");
  out("");
  out(
    `  ideal binarised cost (no learning cost) vs the true H(e): H(e) = ${fn(mtree.He, 3)} bits/axis ` +
      `(${fn(mtree.He * 2, 3)} bits/pt for lat+lon), e==0 ${pct(mtree.zfrac, 2)}, ${mtree.escapes} escapes at M_MAX=23`
  );
  out("");
  mdTable(
    ["mantissa model", "bits/pt lat+lon", "vs H(e)", "N_SLOT/ctx", "table @1020 ctx"],
    mtree.rows.map((r) => [
      r.q === 0 ? "flat, per-bit independent (design §3.3)" : `low ${r.q}-bit tree + flat higher bits`,
      fn(r.bitsPerPoint, 3),
      "+" + fn(r.bitsPerPoint - mtree.He * 2, 3),
      String(r.nSlot),
      (r.tableKBat1020 / 1024).toFixed(2) + " MB",
    ]),
    [null, "r", "r", "r", "r"]
  );
  out("");
  out(
    "  The flat layout is the single largest inefficiency found: it pays " +
      `+${fn(mtree.rows[0].bitsPerPoint - mtree.He * 2, 2)} bits/pt over H(e) because the mantissa bits are strongly ` +
      "dependent (a coordinate lattice makes them deterministic functions of the sign). Conditioning each mantissa bit " +
      "on the prefix of the already-coded low bits recovers almost all of it for a fraction of the table."
  );
  out("");

  /* ---------------- 7) budget summary ---------------- */
  out("## 7. Per-point budget (entropy only; container/index/seed excluded)");
  out("");
  result.summary = {};
  const summaryRows = [];
  for (const prec of opts.precisions) {
    const p = result.ctxAblation[prec].schemes;
    const coord = p[COORD_PICK].Hsum;
    const coordMm = p[COORD_PICK].HsumMm;
    let altBest = null;
    for (const [k, e] of Object.entries(result.alt[prec])) {
      const s = e.schemes["FULL"] || e.schemes[ALT_PICK];
      if (!s) continue;
      if (!altBest || s.H < altBest.H) altBest = { key: k, H: s.H, Hmm: s.Hmm, quant: e.altQuantM, pred: e.predictor };
    }
    const dtH = dt.schemes["FULL"].H;
    const dtHmm = dt.schemes["FULL"].Hmm;
    const total = coord + altBest.H + dtH;
    const totalMm = coordMm + altBest.Hmm + dtHmm;
    const h0total = p["ctx=0"].Hsum + result.alt[prec][altBest.key].H0 + dt.H0;
    summaryRows.push([
      String(prec),
      fn(coord, 3),
      fn(altBest.H, 3),
      fn(dtH, 3),
      fn(total, 3),
      fn(totalMm, 3),
      fn(bitsToMB(total, N_ALL), 2),
      fn(bitsToMB(totalMm, N_ALL), 2),
      fn(bitsToMB(h0total, N_ALL), 2),
      fn(gpzBitsPerPt / total, 2) + "x",
    ]);
    result.summary[prec] = {
      predictor: bestPredName,
      coordScheme: COORD_PICK,
      coordBitsPerPt: coord,
      coordBitsPerPtMm: coordMm,
      altBitsPerPt: altBest.H,
      altBitsPerPtMm: altBest.Hmm,
      altConfig: altBest.key,
      altQuantM: altBest.quant,
      altPredictor: altBest.pred,
      dtBitsPerPt: dtH,
      totalBitsPerPt: total,
      totalBitsPerPtMm: totalMm,
      totalBitsPerPtH0: h0total,
      totalMB: bitsToMB(total, N_ALL),
      totalMBmm: bitsToMB(totalMm, N_ALL),
      totalMBh0: bitsToMB(h0total, N_ALL),
      vsGpz: gpzBitsPerPt / total,
    };
  }
  mdTable(
    ["prec", "coord", "alt", "dt", "total oracle", "total +MM", "MB oracle", "MB +MM", "MB at H0", "vs GPZ"],
    summaryRows,
    [null, "r", "r", "r", "r", "r", "r", "r", "r", "r"]
  );
  out("");
  out(
    `  GPZ V2 reference: ${fn(gpzBitsPerPt, 2)} bits/pt = ${fn(bitsToMB(gpzBitsPerPt, N_ALL), 2)} MB. ` +
      `"oracle" = plugin H1, NOT reachable; "+MM" = Miller-Madow corrected oracle.`
  );
  out(
    `  container cost NOT included: block index 24 B/4096 pt = 0.047 bits/pt + block seed 28 B/4096 pt = ` +
      `0.055 bits/pt => +0.10 bits/pt (${fn(bitsToMB(0.1, N_ALL), 2)} MB) at block=4096.`
  );
  out("");

  /* ---------------- 7b) tier reference: what does a lower tier buy? ---------------- */
  if (opts.precisions.includes(1e6)) {
    const ref = getCoord(1e5, bestPred);
    const refCoord = ref.schemes[COORD_PICK].Hsum;
    const base = result.summary[1e6];
    result.tierReference = {
      prec: 1e5,
      coordBitsPerPt: refCoord,
      delta1e6: base.coordBitsPerPt - refCoord,
      totalBitsPerPt: refCoord + base.altBitsPerPt + base.dtBitsPerPt,
    };
    out("## 7b. Tier reference: 1e5 (~1.1 m) is the corpus' own native precision");
    out("");
    mdTable(
      ["coord tier", "coord bits/pt", "alt+dt", "total bits/pt", "total MB", "note"],
      [
        ["1e5 (1.11 m)", fn(refCoord, 3), fn(base.altBitsPerPt + base.dtBitsPerPt, 3), fn(result.tierReference.totalBitsPerPt, 3), fn(bitsToMB(result.tierReference.totalBitsPerPt, N_ALL), 2), "lossless for 98% of points"],
        ...opts.precisions.map((p) => [
          `${p === 1e6 ? "1e6 (11 cm)" : "1e7 (1.1 cm)"}`,
          fn(result.summary[p].coordBitsPerPt, 3),
          fn(result.summary[p].altBitsPerPt + result.summary[p].dtBitsPerPt, 3),
          fn(result.summary[p].totalBitsPerPt, 3),
          fn(result.summary[p].totalMB, 2),
          p === 1e6 ? "lossless for 98%, Tier-1 default" : "lossless everywhere, Tier-0",
        ]),
      ],
      [null, "r", "r", "r", "r", null]
    );
    out("");
    out(
      `  going 1e6 -> 1e5 saves only ${fn(result.tierReference.delta1e6, 3)} bits/pt on this corpus, because 98% of the ` +
        "points are already on that lattice. The design doc's ~3.3 bits/axis 'thermal noise' saving is NOT visible " +
        "here - it will only show up on data recorded by the current 1e7 firmware."
    );
    out("");
  }

  /* ---------------- 8) per-track ---------------- */
  out("## 8. Per-track distribution (LOSO two-part code length, warm-started prior)");
  out("");
  const pt = perTrackAnalysis(tracks, 1e6, bestPred, COORD_PICK, 10, "d1");
  result.perTrack = {
    prec: pt.prec,
    predictor: pt.predictor,
    coordScheme: pt.coordScheme,
    altQuantM: pt.altQuantM,
    altPredictor: pt.altPredictor,
    nTracksScored: pt.nTracksScored,
    nTracksZeroSample: pt.nTracksZeroSample,
    nScored: pt.nScored,
    pooledBitsPerPt: pt.pooledBitsPerPt,
    perTrackDist: pt.perTrackDist,
    classes: pt.classes,
    top: pt.top,
    tailShare: pt.tailShare,
    note: "two-part model: zero flag + unary order + m raw mantissa bits, ctx backoff to corpus, track's own counts removed",
    tracks: pt.tracks,
  };
  out(
    `  config: prec=1e6, predictor=${pt.predictor}, coord ctx=${pt.coordScheme} (1020), alt 1.0 m d1 (54), dt FULL (10)`
  );
  out(
    `  scored ${pt.nScored.toLocaleString("en-US")} pts over ${pt.nTracksScored} tracks ` +
      `(${pt.nTracksZeroSample} track(s) too short to produce a residual)`
  );
  out(
    `  pooled ${fn(pt.pooledBitsPerPt, 3)} bits/pt; per-track: min ${fn(pt.perTrackDist.min, 2)} / ` +
      `p10 ${fn(pt.perTrackDist.p10, 2)} / median ${fn(pt.perTrackDist.median, 2)} / ` +
      `p90 ${fn(pt.perTrackDist.p90, 2)} / max ${fn(pt.perTrackDist.max, 2)}`
  );
  out(
    `  channel split of the pooled number: lat ${fn(pt.channelBitsPerPt.lat, 3)} + lon ` +
      `${fn(pt.channelBitsPerPt.lon, 3)} + alt ${fn(pt.channelBitsPerPt.alt, 3)} + dt ` +
      `${fn(pt.channelBitsPerPt.dt, 3)} = ${fn(pt.pooledBitsPerPt, 3)} bits/pt ` +
      `(the flat mantissa layout of §3.3 costs +~1.79 of these; see §6b)`
  );
  out("");
  mdTable(
    ["size class", "tracks", "scored pts", "pooled bits/pt", "median track bits/pt"],
    pt.classes.map((c) => [c.label, String(c.tracks), c.points.toLocaleString("en-US"), fn(c.bitsPerPt, 3), fn(c.medianTrackBitsPerPt, 3)]),
    [null, "r", "r", "r", "r"]
  );
  out("");
  mdTable(
    ["track", "points", "bits/pt", "share of bits", "max|e|"],
    pt.top.map((t) => [t.id, String(t.n), fn(t.bitsPerPt, 3), pct(t.share, 1), String(t.maxAbs)]),
    [null, "r", "r", "r", "r"]
  );
  out(`  the other ${Math.max(0, pt.nTracksScored - pt.top.length)} tracks hold ${pct(pt.tailShare, 1)} of all coded bits.`);
  out("");

  /* ---------------- 9) adaptive sim ---------------- */
  if (opts.adaptive) {
    out("## 9. Binarised range-coder simulation (KT slots, design doc §3.3 layout)");
    out("");
    result.adaptive = [];
    const sims = [
      { scheme: "ctx=0", mMax: 23, reset: false },
      { scheme: COORD_PICK, mMax: 23, reset: false },
      { scheme: COORD_PICK, mMax: 23, reset: true },
    ];
    for (const s of sims) {
      const r = adaptiveSim(tracks, 1e6, bestPred, s.scheme, s.mMax, s.reset);
      result.adaptive.push(r);
      out(
        `  scheme=${padEnd(r.scheme, 18)} ctx=${padStart(String(r.ctx), 4)} M_MAX=${r.mMax} N_SLOT=${r.nSlot} ` +
          `reset/track=${r.resetPerTrack ? "yes" : "no "} -> ${fn(r.bitsPerPt, 3)} bits/pt ` +
          `(coords only, ${r.elapsedMs} ms, ${r.escapes} escapes)`
      );
    }
    const warm = result.adaptive.filter((r) => !r.resetPerTrack);
    const cold = result.adaptive.find((r) => r.resetPerTrack);
    if (warm.length === 2) {
      const oracleGain =
        result.ctxAblation[1e6].schemes["ctx=0"].Hsum - result.ctxAblation[1e6].schemes[COORD_PICK].Hsum;
      const idealBinarised = mtree.rows[0].bitsPerPoint;
      out("");
      out(
        `  ctx=0 warm reaches ${fn(warm[0].bitsPerPt, 3)} bits/pt vs the *ideal* flat-mantissa binarisation ` +
          `${fn(idealBinarised, 3)} -> learning cost ${fn(warm[0].bitsPerPt - idealBinarised, 3)} bits/pt ` +
          `(so the +${fn(idealBinarised - result.ctxAblation[1e6].schemes["ctx=0"].Hsum, 2)} over H0 is representation, not learning)`
      );
      out(
        `  context gain on the real slot coder: ${fn(warm[0].bitsPerPt - warm[1].bitsPerPt, 3)} bits/pt ` +
          `vs oracle ${fn(oracleGain, 3)} bits/pt (the slot coder gains MORE because a flat mantissa is hurt worst ` +
          `by the ctx=0 mixture)`
      );
      if (cold) {
        out(
          `  per-track reset penalty at ctx=${cold.ctx}: ${fn(cold.bitsPerPt - warm[1].bitsPerPt, 3)} bits/pt ` +
            `(ECGL0 cold-start tax; warm start across blocks/tracks is mandatory at ctx>=100)`
        );
      }
    }
    out("");
  }

  /* ---------------- 10) recommendation roll-up ---------------- */
  out("## 10. Recommendation roll-up");
  out("");
  const P_REF = opts.precisions.includes(1e6) ? 1e6 : opts.precisions[0];
  const flatOver = mtree.rows[0].bitsPerPoint - mtree.He * 2;
  const treeRow = mtree.rows.find((r) => r.q === 3) || mtree.rows[0];
  const treeOver = treeRow.bitsPerPoint - mtree.He * 2;
  const treeCloses = 1 - treeOver / flatOver; // fraction of the representation gap removed
  const losoTree = pt.pooledBitsPerPt - (flatOver - treeOver);
  const altOracle = {
    "0.1 m": result.alt[P_REF]["1|0"].schemes["FULL"].H,
    "0.5 m": result.alt[P_REF]["5|0"].schemes["FULL"].H,
    "1.0 m": result.alt[P_REF]["10|0"].schemes["FULL"].H,
  };
  // Two independent routes to "what the design as written costs":
  //  (a) the real slot coder for coords (most faithful) + the LOSO alt/dt numbers
  //  (b) the full 4-channel LOSO two-part model (conservative: global flat mantissa)
  const warmCoord = result.adaptive && result.adaptive.find((r) => !r.resetPerTrack && r.scheme === COORD_PICK);
  const coordSlot = warmCoord ? warmCoord.bitsPerPt : result.ctxAblation[P_REF].schemes[COORD_PICK].Hsum + flatOver;
  const altLoso = pt.channelBitsPerPt.alt;
  const dtLoso = pt.channelBitsPerPt.dt;
  const routeA = coordSlot + altLoso + dtLoso;
  const routeB = pt.pooledBitsPerPt;
  const coordGapSlot = coordSlot - result.ctxAblation[P_REF].schemes[COORD_PICK].Hsum;
  const routeATree = coordSlot - coordGapSlot * treeCloses + altLoso + dtLoso;
  const rec = {
    predictor: bestPredName,
    coordContext: {
      cheap: { name: "spd6+q1+dchg", ctx: 204, bits: result.ctxAblation[P_REF].schemes["spd6+q1+dchg"].Hsum, tablesMB: tablesMB(204) },
      full: { name: COORD_PICK, ctx: 1020, bits: result.ctxAblation[P_REF].schemes[COORD_PICK].Hsum, tablesMB: tablesMB(1020) },
      max: { name: "FULL", ctx: 1360, bits: result.ctxAblation[P_REF].schemes["FULL"].Hsum, tablesMB: tablesMB(1360) },
    },
    slotLayout: {
      mMax: 23,
      mantissaTreeDepth: 3,
      nSlot: treeRow.nSlot,
      flatOverheadBitsPerPt: flatOver,
      treeOverheadBitsPerPt: treeOver,
      fractionOfGapClosed: treeCloses,
    },
    alt: { oracleBitsPerPt: altOracle, recommendation: "1.0 m unless elevation matters" },
    dt: { ctx: 10, bitsPerPt: dt.schemes["FULL"].H },
    estimates: {
      oracleBitsPerPt: result.summary[P_REF].totalBitsPerPt,
      oracleMB: result.summary[P_REF].totalMB,
      designAsWrittenSlotCoderBitsPerPt: routeA,
      designAsWrittenSlotCoderMB: bitsToMB(routeA, N_ALL),
      designAsWrittenLosoBitsPerPt: routeB,
      designAsWrittenLosoMB: bitsToMB(routeB, N_ALL),
      withMantissaTreeBitsPerPt: routeATree,
      withMantissaTreeMB: bitsToMB(routeATree, N_ALL),
      withMantissaTreeLosoBitsPerPt: losoTree,
      withMantissaTreeLosoMB: bitsToMB(losoTree, N_ALL),
      vsGpz: gpzBitsPerPt / routeATree,
    },
  };
  result.recommendation = rec;
  mdTable(
    ["item", "route", "bits/pt", "MB @2.02M pts", "notes"],
    [
      ["ORACLE lower bound (plugin H1)", "not reachable", fn(rec.estimates.oracleBitsPerPt, 3), fn(rec.estimates.oracleMB, 2), "coords+alt 1m+dt"],
      ["design as written", "(a) real slot coder for coords + LOSO alt/dt", fn(routeA, 3), fn(rec.estimates.designAsWrittenSlotCoderMB, 2), "most faithful"],
      ["design as written", "(b) 4-channel LOSO two-part model", fn(routeB, 3), fn(rec.estimates.designAsWrittenLosoMB, 2), "conservative"],
      ["+ low-3-bit mantissa tree", "(a) extrapolated", fn(routeATree, 3), fn(rec.estimates.withMantissaTreeMB, 2), `closes ${pct(treeCloses, 0)} of the gap`],
      ["+ low-3-bit mantissa tree", "(b) extrapolated", fn(losoTree, 3), fn(rec.estimates.withMantissaTreeLosoMB, 2), "conservative"],
    ],
    [null, null, "r", "r", null]
  );
  out("");
  out(`  predictor: **${rec.predictor}** (do NOT use time_normalised d2 as the default)`);
  out(
    `  coordinate ctx: 204 (${rec.coordContext.cheap.name}, ${rec.coordContext.cheap.tablesMB.toFixed(2)} MB tables, ` +
      `${fn(rec.coordContext.cheap.bits, 3)} bits/pt) or 1020 (${fn(rec.coordContext.full.bits, 3)} bits/pt, ` +
      `${rec.coordContext.full.tablesMB.toFixed(2)} MB); the extra 816 contexts buy ` +
      `${fn(rec.coordContext.cheap.bits - rec.coordContext.full.bits, 3)} bits/pt = ` +
      `${fn(bitsToMB(rec.coordContext.cheap.bits - rec.coordContext.full.bits, N_ALL) * 1024, 0)} KB of output for +2.1 MB of tables.`
  );
  out(
    `  alt: 0.1 m ${fn(altOracle["0.1 m"], 3)} / 0.5 m ${fn(altOracle["0.5 m"], 3)} / 1.0 m ${fn(altOracle["1.0 m"], 3)} bits/pt ` +
      `-> quantising alt to 1 m saves ${fn(altOracle["0.1 m"] - altOracle["1.0 m"], 3)} bits/pt ` +
      `(${fn(bitsToMB(altOracle["0.1 m"] - altOracle["1.0 m"], N_ALL), 2)} MB) for 1 m of elevation error.`
  );
  const extraTableMB = ((treeRow.nSlot - 553) * 2 * 1020 * 2) / (1024 * 1024);
  out(
    `  slot layout: M_MAX=23 + low-3-bit mantissa tree = ${treeRow.nSlot} slots/ctx (${(treeRow.slotBytes / 1024).toFixed(2)} KB/table); ` +
      `at ctx=1020 that is +${extraTableMB.toFixed(2)} MB of tables for -${fn(flatOver - treeOver, 2)} bits/pt.`
  );
  out(
    `  vs GPZ V2: ${fn(gpzBitsPerPt, 2)} -> ~${fn(routeATree, 2)} bits/pt = ~${fn(rec.estimates.vsGpz, 2)}x with the recommended layout ` +
      `(oracle ceiling would be ${fn(gpzBitsPerPt / rec.estimates.oracleBitsPerPt, 2)}x).`
  );
  out("");

  const elapsed = Date.now() - tStart;
  result.elapsedMs = elapsed;
  out(`total wall time ${elapsed} ms`);

  if (opts.write) {
    fs.mkdirSync(path.dirname(opts.jsonPath), { recursive: true });
    fs.writeFileSync(opts.jsonPath, JSON.stringify(result));
    console.log(`[write] ${opts.jsonPath} (${(fs.statSync(opts.jsonPath).size / 1024).toFixed(1)} KB)`);
  }
}

main();
