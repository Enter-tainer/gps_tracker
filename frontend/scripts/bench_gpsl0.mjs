// GPSL0 benchmark: encodes every track in frontend/local-data/r2/tracks/*.gpz
// with the GPSL0 codec and reports total size, bits/point, ratio vs GPZ and
// the per-track spread. Decisions are made on real bytes, never on entropy
// estimates.
//
// Usage:
//   node frontend/scripts/bench_gpsl0.mjs [options]
//
//   --quantum=auto|1|10|100   coord quantum (default auto = lossless at the
//                             data's natural grid); 1 = 1e-7 deg (lossless),
//                             10 = 1e-6 deg (11 cm), 100 = 1e-5 deg (1.1 m)
//   --altQuantum=auto|1|2|5|10  altitude quantum in 0.1 m units (default auto)
//   --model=N                 model_id (default = DEFAULT_MODEL_ID)
//   --blockPoints=N           block size (default 4096)
//   --syncBlocks=N            probability reset period in blocks (0 = never)
//   --altMode=1|2             altitude predictor
//   --predictor=naive|tn      coordinate predictor
//   --packed                  also encode all tracks as ONE file (reference)
//   --verify                  decode every file and check roundtrip
//   --json[=path]             write machine-readable results
//   --limit=N                 only the N largest tracks

import { loadDataset, loadGpzSizes, totalPoints } from "./lib/dataset.mjs";
import {
  encodeGpsl0,
  decodeGpsl0,
  MODEL_STATS,
  DEFAULT_MODEL_ID,
  getLayout,
} from "../src/services/gpsl0/index.ts";
import { bitsPerPoint, formatBytes, markdownTable } from "./lib/metrics.mjs";

function parseArgs(argv) {
  const opts = {
    quantum: "auto",
    altQuantum: 10,
    modelId: DEFAULT_MODEL_ID,
    blockPoints: 16384,
    syncBlocks: 0,
    altMode: 1,
    predictor: "tn-clamped",
    packed: false,
    verify: false,
    json: null,
    limit: 0,
    stats: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--packed") opts.packed = true;
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--stats") opts.stats = true;
    else if (arg === "--json") opts.json = "frontend/scripts/.cache/bench_gpsl0.json";
    else if (arg.startsWith("--json=")) opts.json = arg.slice(7);
    else if (arg.startsWith("--quantum=")) {
      const v = arg.slice(10);
      opts.quantum = v === "auto" ? "auto" : Number(v);
    } else if (arg.startsWith("--altQuantum=")) {
      const v = arg.slice(13);
      opts.altQuantum = v === "auto" ? "auto" : Number(v);
    } else if (arg.startsWith("--model=")) opts.modelId = Number(arg.slice(8));
    else if (arg.startsWith("--blockPoints=")) opts.blockPoints = Number(arg.slice(14));
    else if (arg.startsWith("--syncBlocks=")) opts.syncBlocks = Number(arg.slice(13));
    else if (arg.startsWith("--altMode=")) opts.altMode = Number(arg.slice(10));
    else if (arg.startsWith("--predictor=")) opts.predictor = arg.slice(12);
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice(8));
    else if (arg === "--help" || arg === "-h") {
      console.log("see header of frontend/scripts/bench_gpsl0.mjs");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function maxDeviation(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

const opts = parseArgs(process.argv);
const encodeOpts = {
  quantum: opts.quantum,
  altQuantum: opts.altQuantum,
  modelId: opts.modelId,
  blockPoints: opts.blockPoints,
  syncBlocks: opts.syncBlocks,
  altMode: opts.altMode,
  coordPredictor: opts.predictor,
};

let tracks = loadDataset({ verbose: true });
const gpzSizes = loadGpzSizes();
if (opts.limit > 0) {
  tracks = [...tracks].sort((a, b) => b.n - a.n).slice(0, opts.limit);
}
const nPoints = totalPoints(tracks);
const layout = getLayout(opts.modelId);

const rows = [];
let totalBytes = 0;
let totalGpz = 0;
let totalEncMs = 0;
let totalDecMs = 0;
let maxDev = 0;
let verified = 0;
let exactTracks = 0;
const quantumHist = new Map();
const started = Date.now();
let statsSnapshot = null;

for (const tr of tracks) {
  const t0 = Date.now();
  const bytes = encodeGpsl0(tr, { ...encodeOpts, stats: opts.stats });
  const encMs = Date.now() - t0;
  totalEncMs += encMs;
  totalBytes += bytes.length;
  const gpz = gpzSizes.get(tr.id);
  totalGpz += gpz;
  let decMs = 0;
  if (opts.verify) {
    const t1 = Date.now();
    const dec = decodeGpsl0(bytes);
    decMs = Date.now() - t1;
    totalDecMs += decMs;
    const dev = Math.max(
      maxDeviation(dec.t, tr.t),
      maxDeviation(dec.lat, tr.lat),
      maxDeviation(dec.lon, tr.lon),
      maxDeviation(dec.alt, tr.alt)
    );
    if (dev > maxDev) maxDev = dev;
    if (dev === 0) exactTracks++;
    verified++;
    const q = dec.meta.coordQuantum;
    quantumHist.set(q, (quantumHist.get(q) || 0) + 1);
  }
  rows.push({
    id: tr.id,
    n: tr.n,
    gpz,
    bytes: bytes.length,
    bitsPerPoint: bitsPerPoint(bytes.length, tr.n),
    gpzBitsPerPoint: bitsPerPoint(gpz, tr.n),
    ratio: gpz / bytes.length,
    encMs,
    decMs,
  });
}

if (opts.stats) {
  statsSnapshot = {
    total: { ...MODEL_STATS.total },
    dt: { ...MODEL_STATS.dt },
    lat: { ...MODEL_STATS.lat },
    lon: { ...MODEL_STATS.lon },
    alt: { ...MODEL_STATS.alt },
    overheadBytes: MODEL_STATS.overheadBytes,
  };
}

let packed = null;
if (opts.packed) {
  const cat = {
    t: new Int32Array(nPoints),
    lat: new Int32Array(nPoints),
    lon: new Int32Array(nPoints),
    alt: new Int32Array(nPoints),
  };
  let off = 0;
  for (const tr of tracks) {
    cat.t.set(tr.t, off);
    cat.lat.set(tr.lat, off);
    cat.lon.set(tr.lon, off);
    cat.alt.set(tr.alt, off);
    off += tr.n;
  }
  const t0 = Date.now();
  const packedBytes = encodeGpsl0(cat, { ...encodeOpts, blockPoints: 16384 });
  const encMs = Date.now() - t0;
  packed = {
    bytes: packedBytes.length,
    bitsPerPoint: bitsPerPoint(packedBytes.length, nPoints),
    encMs,
  };
}

const totals = {
  tracks: tracks.length,
  points: nPoints,
  gpzBytes: totalGpz,
  bytes: totalBytes,
  bitsPerPoint: bitsPerPoint(totalBytes, nPoints),
  gpzBitsPerPoint: bitsPerPoint(totalGpz, nPoints),
  ratio: totalGpz / totalBytes,
  verifyMaxDeviation: opts.verify ? maxDev : null,
  exactTracks,
  verifiedTracks: verified,
  quantumHistogram: Object.fromEntries(quantumHist),
  encodeMs: totalEncMs,
  decodeMs: opts.verify ? totalDecMs : null,
  elapsedMs: Date.now() - started,
};

const sorted = [...rows].sort((a, b) => b.bitsPerPoint - a.bitsPerPoint);
const worst5 = sorted.slice(0, 5);
const best5 = sorted.slice(-5).reverse();

console.log(
  `\nGPSL0 bench | model_id=${opts.modelId} ctx=${layout.nCtx} slots=${layout.nSlot} | ` +
    `quantum=${opts.quantum} altQ=${opts.altQuantum} block=${opts.blockPoints}` +
    ` sync=${opts.syncBlocks} altMode=${opts.altMode} pred=${opts.predictor}`
);
console.log(
  `tracks=${totals.tracks} points=${totals.points.toLocaleString()} | ` +
    `GPSL0 ${formatBytes(totals.bytes)} (${totals.bitsPerPoint.toFixed(2)} b/pt) vs ` +
    `GPZ ${formatBytes(totals.gpzBytes)} (${totals.gpzBitsPerPoint.toFixed(2)} b/pt) => ` +
    `${totals.ratio.toFixed(2)}x | enc ${totalEncMs} ms` +
    (opts.verify
      ? ` | dec ${totalDecMs} ms | maxDev ${maxDev} | exact ${exactTracks}/${verified}` +
        ` | quantum ${JSON.stringify(totals.quantumHistogram)}`
      : "") +
    (packed
      ? ` | PACKED ${formatBytes(packed.bytes)} (${packed.bitsPerPoint.toFixed(2)} b/pt, ` +
        `${(totalGpz / packed.bytes).toFixed(2)}x)`
      : "")
);

if (statsSnapshot) {
  const p = statsSnapshot;
  const b = (s) => (s.bits / nPoints).toFixed(3);
  console.log(
    `channel b/pt: dt ${b(p.dt)} lat ${b(p.lat)} lon ${b(p.lon)} alt ${b(p.alt)} ` +
      `| container ${((p.overheadBytes * 8) / nPoints).toFixed(3)}`
  );
}

console.log("\nworst tracks (bits/pt):");
console.log(
  markdownTable(
    ["track", "points", "gpz B", "gpsl0 B", "b/pt", "ratio"],
    worst5.map((r) => [
      r.id,
      r.n,
      r.gpz,
      r.bytes,
      r.bitsPerPoint.toFixed(2),
      r.ratio.toFixed(2) + "x",
    ])
  )
);
console.log("\nbest tracks (bits/pt):");
console.log(
  markdownTable(
    ["track", "points", "gpz B", "gpsl0 B", "b/pt", "ratio"],
    best5.map((r) => [
      r.id,
      r.n,
      r.gpz,
      r.bytes,
      r.bitsPerPoint.toFixed(2),
      r.ratio.toFixed(2) + "x",
    ])
  )
);

const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
console.log(
  `\nper-track ratio: min ${ratios[0].toFixed(2)}x ` +
    `median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}x ` +
    `max ${ratios[ratios.length - 1].toFixed(2)}x`
);

if (opts.json) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(path.dirname(opts.json), { recursive: true });
  fs.writeFileSync(
    opts.json,
    JSON.stringify(
      { options: opts, layout: { nCtx: layout.nCtx, nSlot: layout.nSlot }, totals, packed, stats: statsSnapshot, perTrack: rows, worst5, best5 },
      null,
      2
    )
  );
  console.log(`json -> ${opts.json}`);
}
