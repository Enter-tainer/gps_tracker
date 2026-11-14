#!/usr/bin/env node
// GPSL0 Step-0 baseline matrix + dataset QC.
//
//   node frontend/scripts/bench_baseline.mjs            # standard run (~60-90 s)
//   node frontend/scripts/bench_baseline.mjs --fast     # skip the slowest brotli-11 runs (~15 s)
//   node frontend/scripts/bench_baseline.mjs --full     # same as standard (kept for symmetry)
//
// What it measures (all on the 123 real tracks in frontend/local-data/r2/tracks):
//
//   1. GPZ V2 raw file sizes                -> today's R2 line-up (per-object view)
//   2. GPZ + gzip-9 / brotli-11 / zstd-3 / zstd-19
//   3. Bare binary stream [i32 t, i32 lat(1e7), i32 lon(1e7), i32 alt] (16 B/pt)
//      raw / gzip-9 / brotli-11 / zstd-3 / zstd-19
//   4. (extra) first-order delta of that same i32 stream, gzip-9 / brotli-11 / zstd-19
//      — a generic compressor applied to a physically-motivated residual stream,
//        i.e. the fairest "can off-the-shelf compression beat a custom format?" test.
//
// Two views are reported for every row (see lib/metrics.mjs header):
//   perObject   compress each track separately, sum the sizes  == the real R2 line-up
//   concat      join all tracks into one buffer, compress once == reference only
//   (the concatenated numbers are an upper bound on what a shared-dictionary /
//    warm-start design could reach; a concatenated GPZ blob is not decodable.)
//
// QC (task item 1) is computed in the same pass:
//   * decoded point count per track vs index.json `tracks[].point_count`
//   * decoded total vs index.json `stats.totalPoints`
//   * dt histogram, duplicate timestamps (dt == 0), non-monotonic timestamps (dt < 0)
//   * duration / distance sums vs index.json totals (decode cross-check)
//   * lat/lon/alt ranges
//
// Output: markdown tables on stdout + JSON at frontend/scripts/.cache/baseline.json
// (schema version in `schema`; numbers are deterministic, only `generatedAt`,
// `nodeVersion` and the `ms*` timings vary between runs).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadDataset,
  totalPoints,
  loadGpzSizes,
  listTrackFiles,
  TRACKS_DIR,
  FRONTEND_ROOT,
} from "./lib/dataset.mjs";
import {
  bitsPerPoint,
  bytesPerPoint,
  formatBytes,
  percentile,
  aggregate,
  markdownTable,
  printTable,
} from "./lib/metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".cache");
const OUT_JSON = path.join(CACHE_DIR, "baseline.json");
const INDEX_JSON = path.join(FRONTEND_ROOT, "local-data", "index.json");

const argv = process.argv.slice(2);
const FAST = argv.includes("--fast");
const FULL = argv.includes("--full");
const CONCURRENCY = 4; // libuv default threadpool size; async zlib runs on it
const SCRIPT_T0 = performance.now();

// ---------------------------------------------------------------------------
// compressors (async so the libuv threadpool parallelises brotli-11)
// ---------------------------------------------------------------------------
const C = zlib.constants;
const HAS_ZSTD = typeof zlib.zstdCompress === "function";

const gzip9 = (buf) =>
  new Promise((res, rej) =>
    zlib.gzip(buf, { level: 9 }, (e, r) => (e ? rej(e) : res(r)))
  );

const brotli11 = (buf) =>
  new Promise((res, rej) =>
    zlib.brotliCompress(
      buf,
      {
        params: {
          [C.BROTLI_PARAM_QUALITY]: 11,
          // Give the encoder the real input length (same as the brotli CLI does).
          [C.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      },
      (e, r) => (e ? rej(e) : res(r))
    )
  );

const zstd = (buf, level) => {
  if (!HAS_ZSTD) return Promise.resolve(null);
  return new Promise((res, rej) =>
    zlib.zstdCompress(
      buf,
      { params: { [C.ZSTD_c_compressionLevel]: level } },
      (e, r) => (e ? rej(e) : res(r))
    )
  );
};

// xz is optional: only used if the binary happens to exist (never installed here).
function hasXz() {
  try {
    const r = spawnSync("xz", ["--version"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
const HAS_XZ = hasXz();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function timedAsync(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
const tLoad = await timedAsync(async () => {
  const tracks = loadDataset({ verbose: true });
  return tracks;
});
const tracks = tLoad.result;
const sizes = loadGpzSizes();
const N_TOTAL = totalPoints(tracks);
const gpzTotalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);

const index = JSON.parse(fs.readFileSync(INDEX_JSON, "utf8"));
const indexById = new Map(index.tracks.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// QC pass: dt histogram, monotonicity, duplicate timestamps, distance
// ---------------------------------------------------------------------------
function haversineM(lat1e7, lon1e7, lat2e7, lon2e7) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const la1 = (lat1e7 / 1e7) * toRad;
  const la2 = (lat2e7 / 1e7) * toRad;
  const dla = la2 - la1;
  const dlo = ((lon2e7 - lon1e7) / 1e7) * toRad;
  const h =
    Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const dtHist = new Map();
let dupTs = 0;
let dupTsSamePos = 0;
let dupTsMoved = 0;
let nonMono = 0;
let hugeDtSteps = 0;
let dtMax = -Infinity;
let fastSteps = 0; // haversine speed > 100 m/s  (aircraft / bad fixes)
let fastStepsDt1 = 0;
let durationSumS = 0;
let distanceSumM = 0;
let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
let altMin = Infinity, altMax = -Infinity;
const qcPerTrack = [];
let bboxMismatches = 0;
const bboxMismatchIds = [];

for (const tr of tracks) {
  const { n, t, lat, lon, alt } = tr;
  let dup = 0;
  let neg = 0;
  let dist = 0;
  let fast = 0;
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    dtHist.set(dt, (dtHist.get(dt) || 0) + 1);
    if (dt === 0) {
      dup++;
      if (lat[i] === lat[i - 1] && lon[i] === lon[i - 1]) dupTsSamePos++;
      else dupTsMoved++;
    }
    if (dt < 0) neg++;
    if (dt > 3600) hugeDtSteps++;
    if (dt > dtMax) dtMax = dt;
    const d = haversineM(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    dist += d;
    if (dt > 0 && d / dt > 100) {
      fast++;
      if (dt === 1) fastStepsDt1++;
    }
  }
  let mnla = Infinity, mxla = -Infinity, mnlo = Infinity, mxlo = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lat[i] < latMin) latMin = lat[i];
    if (lat[i] > latMax) latMax = lat[i];
    if (lon[i] < lonMin) lonMin = lon[i];
    if (lon[i] > lonMax) lonMax = lon[i];
    if (alt[i] < altMin) altMin = alt[i];
    if (alt[i] > altMax) altMax = alt[i];
    if (lat[i] < mnla) mnla = lat[i];
    if (lat[i] > mxla) mxla = lat[i];
    if (lon[i] < mnlo) mnlo = lon[i];
    if (lon[i] > mxlo) mxlo = lon[i];
  }
  dupTs += dup;
  nonMono += neg;
  fastSteps += fast;
  durationSumS += n > 1 ? t[n - 1] - t[0] : 0;
  distanceSumM += dist;
  const idx = indexById.get(tr.id);
  // Decode-integrity check: the decoded extent must equal index.json's cached
  // bounding box (the index was built from the same GPZ/GPX pipeline).
  let bboxOk = true;
  if (idx) {
    bboxOk =
      +(mnla / 1e7).toFixed(5) === +idx.min_lat.toFixed(5) &&
      +(mxla / 1e7).toFixed(5) === +idx.max_lat.toFixed(5) &&
      +(mnlo / 1e7).toFixed(5) === +idx.min_lon.toFixed(5) &&
      +(mxlo / 1e7).toFixed(5) === +idx.max_lon.toFixed(5);
  }
  if (!bboxOk) {
    bboxMismatches++;
    bboxMismatchIds.push(tr.id);
  }
  qcPerTrack.push({
    id: tr.id,
    n,
    indexPointCount: idx ? idx.point_count : null,
    pointCountDelta: idx ? n - idx.point_count : null,
    bboxMatchesIndex: bboxOk,
    tStart: n ? t[0] : 0,
    tEnd: n ? t[n - 1] : 0,
    durationS: n > 1 ? t[n - 1] - t[0] : 0,
    dupTimestamps: dup,
    nonMonotonic: neg,
    fastSteps: fast,
    distanceM: dist,
  });
}

const dtRows = [...dtHist.entries()]
  .sort((a, b) => b[1] - a[1] || a[0] - b[0])
  .map(([dt, count]) => ({ dt, count }));

const qc = {
  tracks: tracks.length,
  points: N_TOTAL,
  indexStatsTotalPoints: index.stats.totalPoints,
  indexPointCountSum: index.tracks.reduce((a, t) => a + t.point_count, 0),
  pointCountMatch: N_TOTAL === index.stats.totalPoints,
  trackPointCountMismatches: qcPerTrack.filter((r) => r.pointCountDelta !== 0).length,
  missingInIndex: qcPerTrack.filter((r) => r.indexPointCount === null).map((r) => r.id),
  dtHistogram: dtRows,
  dtDistinct: dtRows.length,
  dtMax,
  hugeDtSteps,
  duplicateTimestamps: dupTs,
  duplicateTimestampsSamePosition: dupTsSamePos,
  duplicateTimestampsMoved: dupTsMoved,
  nonMonotonicSteps: nonMono,
  fastSteps, // steps implying > 100 m/s ground speed
  fastStepsDt1,
  tracksWithDupTimestamps: qcPerTrack.filter((r) => r.dupTimestamps > 0).length,
  tracksWithNonMonotonic: qcPerTrack.filter((r) => r.nonMonotonic > 0).length,
  tracksWithFastSteps: qcPerTrack.filter((r) => r.fastSteps > 0).length,
  bboxMismatches,
  bboxMismatchIds,
  durationSumS,
  indexTotalDurationS: index.stats.totalDurationS,
  durationSumMinusIndexS: durationSumS - index.stats.totalDurationS,
  distanceSumM,
  indexTotalDistanceM: index.stats.totalDistanceM,
  altRangeM: { min: altMin / 10, max: altMax / 10 },
  latRange: { min: latMin / 1e7, max: latMax / 1e7 },
  lonRange: { min: lonMin / 1e7, max: lonMax / 1e7 },
  perTrack: qcPerTrack,
};

// ---------------------------------------------------------------------------
// buffers
// ---------------------------------------------------------------------------
function rawI32(tr) {
  const b = Buffer.allocUnsafe(tr.n * 16);
  for (let i = 0; i < tr.n; i++) {
    b.writeInt32LE(tr.t[i], i * 16);
    b.writeInt32LE(tr.lat[i], i * 16 + 4);
    b.writeInt32LE(tr.lon[i], i * 16 + 8);
    b.writeInt32LE(tr.alt[i], i * 16 + 12);
  }
  return b;
}

// First-order delta of the same interleaved layout, i32 arithmetic.
// Index 0 holds the absolute value (so the buffer is self-contained).
function deltaI32(tr) {
  const b = Buffer.allocUnsafe(tr.n * 16);
  const cols = [tr.t, tr.lat, tr.lon, tr.alt];
  for (let c = 0; c < 4; c++) {
    const a = cols[c];
    let prev = 0;
    for (let i = 0; i < tr.n; i++) {
      const v = a[i];
      b.writeInt32LE(i === 0 ? v : (v - prev) | 0, i * 16 + c * 4);
      prev = v;
    }
  }
  return b;
}

const gpzBuffers = tracks.map((tr) => fs.readFileSync(path.join(TRACKS_DIR, `${tr.id}.gpz`)));
const rawBuffers = tracks.map(rawI32);
const deltaBuffers = tracks.map(deltaI32);

// ---------------------------------------------------------------------------
// per-object (R2) matrix — compress every track separately
// ---------------------------------------------------------------------------
const tPerObject = performance.now();
const perTrackRaw = await mapLimit(tracks, CONCURRENCY, async (tr, i) => {
  const gpz = gpzBuffers[i];
  const raw = rawBuffers[i];
  const del = deltaBuffers[i];
  const rec = {
    id: tr.id,
    n: tr.n,
    gpzBytes: gpz.length,
    gzip9: null,
    brotli11: null,
    zstd3: null,
    zstd19: null,
    rawBytes: raw.length,
    rawGzip9: null,
    rawBrotli11: null,
    rawZstd3: null,
    rawZstd19: null,
    deltaBytes: del.length,
    deltaGzip9: null,
    deltaBrotli11: null,
    deltaZstd19: null,
    ms: {},
  };
  const ops = [
    ["gzip9", () => gzip9(gpz)],
    ["brotli11", () => brotli11(gpz)],
    ["zstd3", () => zstd(gpz, 3)],
    ["rawGzip9", () => gzip9(raw)],
    ["rawBrotli11", () => brotli11(raw)],
    ["rawZstd3", () => zstd(raw, 3)],
    ["deltaGzip9", () => gzip9(del)],
  ];
  if (!FAST) {
    // level 19 is the strongest off-the-shelf challenger; expose it on every stream
    ops.push(["zstd19", () => zstd(gpz, 19)]);
    ops.push(["rawZstd19", () => zstd(raw, 19)]);
    ops.push(["deltaBrotli11", () => brotli11(del)]);
    ops.push(["deltaZstd19", () => zstd(del, 19)]);
  }
  for (const [key, fn] of ops) {
    const { result, ms } = await timedAsync(fn);
    rec[key] = result ? result.length : null;
    rec.ms[key] = ms;
  }
  return rec;
});
const perObjectWallMs = performance.now() - tPerObject;

function threadMs(key) {
  return perTrackRaw.reduce((a, r) => a + (r.ms?.[key] || 0), 0);
}

// ---------------------------------------------------------------------------
// concatenated reference matrix
// ---------------------------------------------------------------------------
const gpzConcat = Buffer.concat(gpzBuffers);
const rawConcat = Buffer.concat(rawBuffers);
const deltaConcat = Buffer.concat(deltaBuffers);

async function concatRow(label, buf, fn, key) {
  const { result, ms } = await timedAsync(fn);
  return {
    key,
    label,
    mode: "concat",
    bytes: result ? result.length : null,
    msWall: ms,
  };
}

const tConcat = performance.now();
const concatSpecs = [
  ["gpz", gpzConcat, null],
  ["gpz+gzip9", gpzConcat, () => gzip9(gpzConcat)],
  ["gpz+brotli11", gpzConcat, () => brotli11(gpzConcat)],
  ["gpz+zstd3", gpzConcat, () => zstd(gpzConcat, 3)],
  ["gpz+zstd19", gpzConcat, () => zstd(gpzConcat, 19)],
  ["raw", rawConcat, null],
  ["raw+gzip9", rawConcat, () => gzip9(rawConcat)],
  ["raw+zstd19", rawConcat, () => zstd(rawConcat, 19)],
  ["delta", deltaConcat, null],
  ["delta+gzip9", deltaConcat, () => gzip9(deltaConcat)],
  ["delta+zstd19", deltaConcat, () => zstd(deltaConcat, 19)],
];
if (FULL) {
  // 32 MB single-call brotli q11 takes ~1-2 min each; only on explicit request.
  concatSpecs.push(["raw+brotli11", rawConcat, () => brotli11(rawConcat)]);
  concatSpecs.push(["delta+brotli11", deltaConcat, () => brotli11(deltaConcat)]);
}const concatRows = await mapLimit(concatSpecs, 2, async ([label, buf, fn]) => {
  if (!fn) return { key: label, label, mode: "concat", bytes: buf.length, msWall: 0 };
  return concatRow(label, buf, fn, label);
});
const concatWallMs = performance.now() - tConcat;
const concatByKey = new Map(concatRows.map((r) => [r.key, r]));

// xz -9 on the delta stream (only if the binary exists; N/A here by design).
let xzRow = {
  key: "delta+xz-9",
  label: "delta+xz -9",
  mode: "concat",
  available: false,
  bytes: null,
  note: "N/A — `xz` not found on PATH and installation is out of scope for this task",
};
if (HAS_XZ) {
  const { result, ms } = await timedAsync(async () => {
    const r = spawnSync("xz", ["-9", "-c", "-T1"], { input: deltaConcat, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`xz failed: ${r.stderr?.toString?.() || r.status}`);
    return r.stdout;
  }).catch((e) => ({ result: null, ms: 0, error: e }));
  if (result) xzRow = { key: "delta+xz-9", label: "delta+xz -9", mode: "concat", available: true, bytes: result.length, msWall: ms };
}

// ---------------------------------------------------------------------------
// assemble baseline rows
// ---------------------------------------------------------------------------
function row({ key, label, mode, bytes, ms, note, available = true, extra } = {}) {
  return {
    key,
    label,
    mode,
    available: available && bytes !== null && bytes !== undefined,
    bytes: available ? bytes : null,
    bitsPerPoint: available ? bitsPerPoint(bytes, N_TOTAL) : null,
    bytesPerPoint: available ? bytesPerPoint(bytes, N_TOTAL) : null,
    ms: ms ?? null,
    ...(note ? { note } : {}),
    ...(extra || {}),
  };
}

function objRow(key, label, srcKey, opts = {}) {
  const { available = true, note, ratioToGpz = false, mode = "perObject" } = opts;
  const bytes = available ? perTrackRaw.reduce((a, r) => a + (r[srcKey] || 0), 0) : null;
  return row({
    key,
    label,
    mode,
    bytes,
    ms: available ? threadMs(srcKey) : null,
    available,
    note,
    extra: ratioToGpz && bytes !== null ? { compressionRatioVsGpz: bytes / gpzTotalBytes } : {},
  });
}

const zstdNote = HAS_ZSTD ? undefined : "N/A — node:zlib has no zstd in this Node build";
const fastNote = "skipped in --fast mode";
const sumOf = (k) => perTrackRaw.reduce((a, r) => a + (r[k] || 0), 0);

const gpzRows = [
  row({
    key: "gpz",
    label: "GPZ V2 raw (today's R2 objects)",
    mode: "perObject",
    bytes: gpzTotalBytes,
    ms: null,
    extra: { compressionRatioVsGpz: 1 },
  }),
  objRow("gpz+gzip9", "GPZ + gzip -9", "gzip9", { ratioToGpz: true }),
  objRow("gpz+brotli11", "GPZ + brotli q11", "brotli11", { ratioToGpz: true }),
  objRow("gpz+zstd3", "GPZ + zstd -3", "zstd3", { available: HAS_ZSTD, note: zstdNote, ratioToGpz: true }),
  objRow("gpz+zstd19", "GPZ + zstd -19", "zstd19", {
    available: HAS_ZSTD && !FAST,
    note: HAS_ZSTD && FAST ? fastNote : zstdNote,
    ratioToGpz: true,
  }),
];

const rawTotalBytes = sumOf("rawBytes");
const deltaTotalBytes = sumOf("deltaBytes");

const rawRows = [
  row({ key: "raw", label: "bare i32 x4 interleaved (16 B/pt)", mode: "perObject", bytes: rawTotalBytes, ms: null }),
  objRow("raw+gzip9", "bare i32 + gzip -9", "rawGzip9"),
  objRow("raw+brotli11", "bare i32 + brotli q11", "rawBrotli11"),
  objRow("raw+zstd3", "bare i32 + zstd -3", "rawZstd3", { available: HAS_ZSTD, note: zstdNote }),
  objRow("raw+zstd19", "bare i32 + zstd -19", "rawZstd19", {
    available: HAS_ZSTD && !FAST,
    note: HAS_ZSTD && FAST ? fastNote : zstdNote,
  }),
];

const deltaRows = [
  row({ key: "delta", label: "delta i32 x4 interleaved (extra)", mode: "perObject", bytes: deltaTotalBytes, ms: null }),
  objRow("delta+gzip9", "delta i32 + gzip -9 (extra)", "deltaGzip9"),
  objRow("delta+brotli11", "delta i32 + brotli q11 (extra)", "deltaBrotli11", {
    available: !FAST,
    note: FAST ? fastNote : undefined,
  }),
  objRow("delta+zstd19", "delta i32 + zstd -19 (extra)", "deltaZstd19", {
    available: HAS_ZSTD && !FAST,
    note: HAS_ZSTD && FAST ? fastNote : zstdNote,
  }),
];

function concatOut(keys) {
  const out = [];
  for (const k of keys) {
    const r = concatByKey.get(k);
    if (!r) continue;
    out.push(row({ key: `${k}@concat`, label: r.label, mode: "concat", bytes: r.bytes, ms: r.msWall }));
  }
  return out;
}

const concatOutRows = [
  ...concatOut(["gpz", "gpz+gzip9", "gpz+brotli11", "gpz+zstd3", "gpz+zstd19"]),
  ...concatOut(["raw", "raw+gzip9", "raw+zstd19", "raw+brotli11"]),
  ...concatOut(["delta", "delta+gzip9", "delta+zstd19", "delta+brotli11"]),
  row({
    key: xzRow.key,
    label: xzRow.label,
    mode: "concat",
    bytes: xzRow.bytes,
    ms: xzRow.msWall,
    available: xzRow.available,
    note: xzRow.note,
  }),
];


// ---------------------------------------------------------------------------
// per-track stats: best / worst GPZ track, and GPZ compression gains
// ---------------------------------------------------------------------------
const bppOrNull = (bytes, n) => (bytes === null || bytes === undefined ? null : bitsPerPoint(bytes, n));
const perTrackWithBpp = perTrackRaw.map((r) => ({
  ...r,
  gpzBytesPerPoint: bytesPerPoint(r.gpzBytes, r.n),
  gpzBitsPerPoint: bitsPerPoint(r.gpzBytes, r.n),
  gzip9BitsPerPoint: bppOrNull(r.gzip9, r.n),
  brotli11BitsPerPoint: bppOrNull(r.brotli11, r.n),
  rawBitsPerPoint: bitsPerPoint(r.rawBytes, r.n),
  deltaBitsPerPoint: bitsPerPoint(r.deltaBytes, r.n),
}));

const byBpp = [...perTrackWithBpp].sort((a, b) => a.gpzBitsPerPoint - b.gpzBitsPerPoint);
const gpzAgg = aggregate(perTrackWithBpp);
const best = byBpp[0];
const worst = byBpp[byBpp.length - 1];
// Tiny tracks (a handful of points, e.g. a 4-point stub) are dominated by fixed
// container overhead and make useless "worst case" headlines; also report the
// worst track among tracks with at least 1,000 points.
const MEANINGFUL_N = 1000;
const meaningful = perTrackWithBpp.filter((r) => r.n >= MEANINGFUL_N);
const worstMeaningful = meaningful.length
  ? [...meaningful].sort((a, b) => b.gpzBitsPerPoint - a.gpzBitsPerPoint)[0]
  : worst;

const totals = {
  tracks: tracks.length,
  points: N_TOTAL,
  gpzBytes: gpzTotalBytes,
  gpzBytesPerPoint: bytesPerPoint(gpzTotalBytes, N_TOTAL),
  gpzBitsPerPoint: bitsPerPoint(gpzTotalBytes, N_TOTAL),
  gpzPerTrackStats: {
    minBitsPerPoint: gpzAgg.minBitsPerPoint,
    maxBitsPerPoint: gpzAgg.maxBitsPerPoint,
    p50BitsPerPoint: gpzAgg.p50BitsPerPoint,
    p95BitsPerPoint: gpzAgg.p95BitsPerPoint,
    p99BitsPerPoint: gpzAgg.p99BitsPerPoint,
    bestTrack: { id: best.id, n: best.n, gpzBytes: best.gpzBytes, bitsPerPoint: best.gpzBitsPerPoint },
    worstTrack: { id: worst.id, n: worst.n, gpzBytes: worst.gpzBytes, bitsPerPoint: worst.gpzBitsPerPoint },
    worstTrackN1000: {
      id: worstMeaningful.id,
      n: worstMeaningful.n,
      gpzBytes: worstMeaningful.gpzBytes,
      bitsPerPoint: worstMeaningful.gpzBitsPerPoint,
    },
  },
  rawI32Bytes: rawTotalBytes,
  rawI32BitsPerPoint: bitsPerPoint(rawTotalBytes, N_TOTAL),
  deltaI32Bytes: deltaTotalBytes,
  deltaI32BitsPerPoint: bitsPerPoint(deltaTotalBytes, N_TOTAL),
};

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------
const out = {
  schema: "gpsl0-baseline/1",
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  zstdAvailable: HAS_ZSTD,
  xzAvailable: HAS_XZ,
  mode: FAST ? "fast" : FULL ? "full" : "standard",
  concurrency: CONCURRENCY,
  cpuCount: os.cpus().length,
  timings: {
    datasetLoadMs: tLoad.ms,
    perObjectPhaseWallMs: perObjectWallMs,
    concatPhaseWallMs: concatWallMs,
    totalWallMs: null, // filled below
  },
  dataset: {
    tracks: tracks.length,
    points: N_TOTAL,
    gpzBytes: gpzTotalBytes,
    gpzBytesPerPoint: totals.gpzBytesPerPoint,
    gpzBitsPerPoint: totals.gpzBitsPerPoint,
    files: listTrackFiles().length,
  },
  qc,
  totals,
  baselines: {
    perObject: { gpz: gpzRows, rawI32: rawRows, deltaI32: deltaRows },
    concatenated: concatOutRows,
  },
  perTrack: perTrackWithBpp,
  notes: {
    views:
      "perObject = compress each track separately and sum (real R2 line-up). concat = join all tracks then compress once (reference only; a concatenated GPZ blob is not decodable).",
    gpz:
      "GPZ V2 file sizes as stored today; bitsPerPoint is over decoded points, so container header costs are included.",
    brotli: "brotli q11 with BROTLI_PARAM_SIZE_HINT = input length.",
    zstd: HAS_ZSTD
      ? "node:zlib zstdCompressSync/zstdCompress available (Node >= 23.8); levels 3 and 19."
      : "node:zlib has no zstd in this Node build -> rows marked N/A (no dependency installed).",
    xz: xzRow.note || "xz -9 on the concatenated delta stream.",
    delta:
      "Extra row (not required by the task): first-order delta of the interleaved i32 stream, index 0 = absolute value. It is the fairest generic-compression yardstick because GPZ's own win comes from delta coding.",
    timing:
      "perObject ms are thread-time sums (jobs run on the libuv threadpool with concurrency 4); concat ms are wall time of a single call.",
  },
};

fs.mkdirSync(CACHE_DIR, { recursive: true });
const t0 = performance.now();

// ---------------------------------------------------------------------------
// stdout report
// ---------------------------------------------------------------------------
const fmtBpp = (v) => (v === null || v === undefined ? "N/A" : v.toFixed(2));
const fmtB = (v) => (v === null || v === undefined ? "N/A" : formatBytes(v));

console.log("");
console.log("================ GPSL0 Step-0 baseline ================");
console.log(
  `tracks=${tracks.length}  points=${N_TOTAL.toLocaleString()}  GPZ=${gpzTotalBytes.toLocaleString()} B ` +
    `(${formatBytes(gpzTotalBytes)} / ${formatBytes(gpzTotalBytes, { binary: true })})  ` +
    `=${totals.gpzBitsPerPoint.toFixed(2)} bits/pt`
);
console.log(
  `node ${process.version}  zstd=${HAS_ZSTD ? "available" : "N/A"}  xz=${HAS_XZ ? "available" : "N/A"}  mode=${out.mode}`
);

console.log("\n--- QC: point counts vs index.json ---");
printTable(
  ["check", "decoded", "index.json", "match"],
  [
    ["track count", tracks.length, index.stats.trackCount, tracks.length === index.stats.trackCount ? "yes" : "NO"],
    ["total points", N_TOTAL, index.stats.totalPoints, qc.pointCountMatch ? "yes" : "NO"],
    ["sum per-track point_count", N_TOTAL, qc.indexPointCountSum, qc.indexPointCountSum === N_TOTAL ? "yes" : "NO"],
    ["tracks with point_count mismatch", qc.trackPointCountMismatches, 0, qc.trackPointCountMismatches === 0 ? "yes" : "NO"],
    ["tracks missing from index.json", qc.missingInIndex.length, 0, qc.missingInIndex.length === 0 ? "yes" : "NO"],
    ["decoded bbox != index bbox", qc.bboxMismatches, 0, qc.bboxMismatches === 0 ? "yes" : "NO"],
  ]
);

console.log("\n--- QC: timestamps ---");
printTable(
  ["metric", "value"],
  [
    ["distinct dt values", qc.dtDistinct],
    ["dt max (s)", qc.dtMax],
    ["steps with dt > 1 h", qc.hugeDtSteps],
    ["duplicate timestamps (dt=0)", qc.duplicateTimestamps],
    ["  of which position unchanged", qc.duplicateTimestampsSamePosition],
    ["  of which position moved", qc.duplicateTimestampsMoved],
    ["tracks with duplicate timestamps", qc.tracksWithDupTimestamps],
    ["non-monotonic steps (dt<0)", qc.nonMonotonicSteps],
    ["steps implying > 100 m/s ground speed", qc.fastSteps],
    ["  of which dt=1 s", qc.fastStepsDt1],
    ["tracks with such steps", qc.tracksWithFastSteps],
    ["duration sum (h)", (qc.durationSumS / 3600).toFixed(2)],
    ["index.json totalDurationS", qc.indexTotalDurationS],
    ["duration sum - index (s)", qc.durationSumMinusIndexS],
    ["distance sum, raw haversine (km)", (qc.distanceSumM / 1000).toFixed(1)],
    ["index.json totalDistanceM (jump-filtered)", qc.indexTotalDistanceM],
    ["lat range (deg)", `${qc.latRange.min.toFixed(5)} .. ${qc.latRange.max.toFixed(5)}`],
    ["lon range (deg)", `${qc.lonRange.min.toFixed(5)} .. ${qc.lonRange.max.toFixed(5)}`],
    ["alt range (m)", `${qc.altRangeM.min} .. ${qc.altRangeM.max}`],
  ]
);

console.log("\n--- QC: dt histogram (top 12) ---");
printTable(
  ["dt (s)", "count", "share"],
  qc.dtHistogram.slice(0, 12).map((r) => [r.dt, r.count, `${((r.count / (N_TOTAL - tracks.length)) * 100).toFixed(3)}%`])
);

console.log("\n--- per-object view (each R2 object compressed separately; = R2 line-up) ---");
printTable(
  ["baseline", "bytes", "B/pt", "bits/pt", "vs GPZ"],
  gpzRows.map((r) => [
    r.label,
    r.available ? r.bytes.toLocaleString() : "N/A",
    r.available ? r.bytesPerPoint.toFixed(3) : "N/A",
    fmtBpp(r.bitsPerPoint),
    r.available && r.key !== "gpz" ? `${(r.bytes / gpzTotalBytes).toFixed(3)}x` : r.key === "gpz" ? "1.000x" : "N/A",
  ])
);

console.log("\n--- bare / delta i32 streams (per-object) ---");
printTable(
  ["baseline", "bytes", "B/pt", "bits/pt"],
  [...rawRows, ...deltaRows].map((r) => [
    r.label,
    r.available ? r.bytes.toLocaleString() : "N/A",
    r.available ? r.bytesPerPoint.toFixed(3) : "N/A",
    fmtBpp(r.bitsPerPoint),
  ])
);

console.log("\n--- concatenated reference (all tracks joined, compressed once) ---");
printTable(
  ["baseline", "bytes", "B/pt", "bits/pt", "ms"],
  concatOutRows.map((r) => [
    r.label,
    r.available ? r.bytes.toLocaleString() : "N/A",
    r.available ? r.bytesPerPoint.toFixed(3) : "N/A",
    fmtBpp(r.bitsPerPoint),
    r.ms ? Math.round(r.ms) : "-",
  ])
);

console.log("\n--- GPZ per-track spread (bits/pt) ---");
printTable(
  ["stat", "bits/pt", "B/pt"],
  [
    ["min (best track)", gpzAgg.minBitsPerPoint.toFixed(2), (gpzAgg.minBitsPerPoint / 8).toFixed(3)],
    ["p50", gpzAgg.p50BitsPerPoint.toFixed(2), (gpzAgg.p50BitsPerPoint / 8).toFixed(3)],
    ["p95", gpzAgg.p95BitsPerPoint.toFixed(2), (gpzAgg.p95BitsPerPoint / 8).toFixed(3)],
    ["p99", gpzAgg.p99BitsPerPoint.toFixed(2), (gpzAgg.p99BitsPerPoint / 8).toFixed(3)],
    ["max (worst track)", gpzAgg.maxBitsPerPoint.toFixed(2), (gpzAgg.maxBitsPerPoint / 8).toFixed(3)],
    ["aggregate", totals.gpzBitsPerPoint.toFixed(2), totals.gpzBytesPerPoint.toFixed(3)],
  ]
);
printTable(
  ["role", "track id", "points", "gpz bytes", "bits/pt"],
  [
    ["best", best.id, best.n, best.gpzBytes, best.gpzBitsPerPoint.toFixed(2)],
    ["worst", worst.id, worst.n, worst.gpzBytes, worst.gpzBitsPerPoint.toFixed(2)],
  ]
);

out.timings.totalWallMs = performance.now() - SCRIPT_T0;
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + "\n");
console.log(`\n[baseline] wrote ${OUT_JSON} (${formatBytes(fs.statSync(OUT_JSON).size)})`);

// Markdown summary for pasting into a report/PR.
const md = [
  "### GPSL0 Step-0 baseline (123 tracks / " + N_TOTAL.toLocaleString() + " points)",
  "",
  markdownTable(
    ["baseline", "view", "bytes", "B/pt", "bits/pt"],
    [
      ...gpzRows.map((r) => [r.label, "per-object", r.available ? r.bytes.toLocaleString() : "N/A", r.available ? r.bytesPerPoint.toFixed(3) : "N/A", fmtBpp(r.bitsPerPoint)]),
      ...rawRows.map((r) => [r.label, "per-object", r.available ? r.bytes.toLocaleString() : "N/A", r.available ? r.bytesPerPoint.toFixed(3) : "N/A", fmtBpp(r.bitsPerPoint)]),
      ...deltaRows.map((r) => [r.label, "per-object", r.available ? r.bytes.toLocaleString() : "N/A", r.available ? r.bytesPerPoint.toFixed(3) : "N/A", fmtBpp(r.bitsPerPoint)]),
      ...concatOutRows.map((r) => [r.label, "concat", r.available ? r.bytes.toLocaleString() : "N/A", r.available ? r.bytesPerPoint.toFixed(3) : "N/A", fmtBpp(r.bitsPerPoint)]),
    ],
    { align: ["left", "left", "right", "right", "right"] }
  ),
].join("\n");
fs.writeFileSync(path.join(CACHE_DIR, "baseline.md"), md + "\n", "utf8");
console.log(`[baseline] wrote ${path.join(CACHE_DIR, "baseline.md")}`);
