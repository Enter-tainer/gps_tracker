// GPSL0 codec-level ablation: real codestream size + per-channel
// self-information over all 123 tracks.
//
//   node frontend/scripts/ablation_codec.mjs --matrix=core|model|quantum|alt|block
//   node frontend/scripts/ablation_codec.mjs --matrix=model --limit=20
//
// Model decisions are made here (real bytes), not from entropy estimates.

import { loadDataset, loadGpzSizes, totalPoints } from "./lib/dataset.mjs";
import {
  encodeGpsl0,
  MODEL_STATS,
  getLayout,
} from "../src/services/gpsl0/index.ts";
import { bitsPerPoint, formatBytes, markdownTable } from "./lib/metrics.mjs";

const args = process.argv.slice(2);
let matrixName = "core";
let limit = 0;
let jsonPath = null;
for (const a of args) {
  if (a.startsWith("--matrix=")) matrixName = a.slice(9);
  else if (a.startsWith("--limit=")) limit = Number(a.slice(8));
  else if (a.startsWith("--json=")) jsonPath = a.slice(7);
}

let tracks = loadDataset({ verbose: true });
const gpzSizes = loadGpzSizes();
if (limit > 0) tracks = [...tracks].sort((a, b) => b.n - a.n).slice(0, limit);
const nPoints = totalPoints(tracks);
let gpzBytes = 0;
for (const tr of tracks) gpzBytes += gpzSizes.get(tr.id);

const BASE = {
  quantum: "auto",
  altQuantum: 10,
  blockPoints: 16384,
  syncBlocks: 0,
  altMode: 1,
  coordPredictor: "tn-clamped",
};

const MATRICES = {
  core: [
    { label: "default (autoQ, alt1m, naiveD2, blk4096)", opts: {} },
    { label: "alt 0.1m (lossless)", opts: { altQuantum: 1 } },
    { label: "alt 0.5m", opts: { altQuantum: 5 } },
    { label: "predictor tn-clamped", opts: { coordPredictor: "tn-clamped" } },
    { label: "predictor tn", opts: { coordPredictor: "tn" } },
    { label: "predictor naive d2", opts: { coordPredictor: "naive" } },
    { label: "altMode 1 (d1)", opts: { altMode: 1 } },
    { label: "blk 16384", opts: { blockPoints: 16384 } },
    { label: "blk 8192", opts: { blockPoints: 8192 } },
    { label: "blk 1024", opts: { blockPoints: 1024 } },
    { label: "sync 8 blocks", opts: { syncBlocks: 8 } },
    { label: "sync 32 blocks", opts: { syncBlocks: 32 } },
    { label: "quantum 10 (11cm, lossy)", opts: { quantum: 10 } },
    { label: "quantum 100 (1.1m)", opts: { quantum: 100 } },
  ],
  model: [
    { label: "m1 flat mantissa, 6spd", opts: { modelId: 1 } },
    { label: "m2 tree3, 2spd", opts: { modelId: 2 } },
    { label: "m3 tree4, 2spd", opts: { modelId: 3 } },
    { label: "m4 tree5, 2spd", opts: { modelId: 4 } },
    { label: "m5 tree4, 6spd", opts: { modelId: 5 } },
    { label: "m6 tree4, 1spd", opts: { modelId: 6 } },
    { label: "m7 tree4, 1spd+dchg", opts: { modelId: 7 } },
    { label: "m8 tree4, 2spd+dchg", opts: { modelId: 8 } },
    { label: "m9 tree4, 1spd+dchg, dt6", opts: { modelId: 9 } },
    { label: "m10 flat (no tree), 1spd+dchg [tree A/B]", opts: { modelId: 10 } },
  ],
  quantum: [
    { label: "auto (lossless at natural grid)", opts: {} },
    { label: "quantum 1 (1e7 lossless)", opts: { quantum: 1 } },
    { label: "quantum 10 (1e6, 11cm)", opts: { quantum: 10 } },
    { label: "quantum 100 (1e5, 1.1m)", opts: { quantum: 100 } },
  ],
  alt: [
    { label: "alt 0.1 m (exact)", opts: { altQuantum: 1 } },
    { label: "alt 0.2 m", opts: { altQuantum: 5 } },
    { label: "alt 0.5 m", opts: { altQuantum: 2 } },
    { label: "alt 1 m (default)", opts: { altQuantum: 10 } },
  ],
  block: [
    { label: "blk 1024", opts: { blockPoints: 1024 } },
    { label: "blk 4096", opts: {} },
    { label: "blk 8192", opts: { blockPoints: 8192 } },
    { label: "blk 16384", opts: { blockPoints: 16384 } },
    { label: "blk 32768", opts: { blockPoints: 32768 } },
  ],
};

function run(opts) {
  MODEL_STATS.reset();
  MODEL_STATS.enabled = true;
  let bytes = 0;
  const merged = { ...BASE, ...opts };
  const t0 = Date.now();
  for (const tr of tracks) {
    bytes += encodeGpsl0(tr, { ...merged, stats: true }).length;
  }
  const ms = Date.now() - t0;
  const pts = MODEL_STATS.total.points || nPoints;
  return {
    bytes,
    bitsPerPoint: bitsPerPoint(bytes, pts),
    gpzRatio: gpzBytes / bytes,
    encMs: ms,
    dt: MODEL_STATS.dt.bits / pts,
    lat: MODEL_STATS.lat.bits / pts,
    lon: MODEL_STATS.lon.bits / pts,
    alt: MODEL_STATS.alt.bits / pts,
    modelBits:
      (MODEL_STATS.dt.bits +
        MODEL_STATS.lat.bits +
        MODEL_STATS.lon.bits +
        MODEL_STATS.alt.bits) /
      pts,
    overheadBitsPerPoint: (MODEL_STATS.overheadBytes * 8) / pts,
  };
}

const matrix = MATRICES[matrixName];
if (!matrix) throw new Error(`unknown matrix ${matrixName}`);
const results = [];
console.log(
  `\nmatrix=${matrixName} tracks=${tracks.length} points=${nPoints.toLocaleString()} ` +
    `GPZ=${formatBytes(gpzBytes)} (${bitsPerPoint(gpzBytes, nPoints).toFixed(2)} b/pt)`
);
for (const entry of matrix) {
  const r = run(entry.opts);
  results.push({ label: entry.label, ...entry.opts, ...r });
  console.log(
    `${entry.label.padEnd(44)} ${formatBytes(r.bytes).padStart(9)} ` +
      `${r.bitsPerPoint.toFixed(3).padStart(7)} b/pt ${r.gpzRatio.toFixed(2).padStart(6)}x | ` +
      `dt ${r.dt.toFixed(2).padStart(5)} lat ${r.lat.toFixed(2).padStart(5)} ` +
      `lon ${r.lon.toFixed(2).padStart(5)} alt ${r.alt.toFixed(2).padStart(5)} | ` +
      `hdr ${r.overheadBitsPerPoint.toFixed(3)} | ${String(r.encMs).padStart(4)}ms`
  );
}

console.log(
  "\n" +
    markdownTable(
      ["config", "bytes", "b/pt", "vs GPZ", "dt", "lat", "lon", "alt", "hdr", "enc"],
      results.map((r) => [
        r.label,
        formatBytes(r.bytes),
        r.bitsPerPoint.toFixed(3),
        r.gpzRatio.toFixed(2) + "x",
        r.dt.toFixed(2),
        r.lat.toFixed(2),
        r.lon.toFixed(2),
        r.alt.toFixed(2),
        r.overheadBitsPerPoint.toFixed(3),
        r.encMs + "ms",
      ])
    )
);

if (jsonPath) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ matrix: matrixName, points: nPoints, gpzBytes, results }, null, 2)
  );
  console.log(`json -> ${jsonPath}`);
}
