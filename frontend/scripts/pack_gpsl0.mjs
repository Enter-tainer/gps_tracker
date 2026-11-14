// Pack the local GPZ corpus into .gpsl0 objects, mirroring the R2 layout.
//
//   node frontend/scripts/pack_gpsl0.mjs                 # writes tracks-gpsl0/
//   node frontend/scripts/pack_gpsl0.mjs --out=DIR       # custom output dir
//   node frontend/scripts/pack_gpsl0.mjs --verify        # decode every object
//   node frontend/scripts/pack_gpsl0.mjs --lossless-alt  # altQuantum 1 (0.1 m)
//
// Output: <out>/<track-id>.gpsl0 plus <out>/index.gpsl0.json with per-object
// sizes so the Cloudflare upload step (scripts/sync_cloudflare.mjs) can diff
// against what is already in the bucket.

import fs from "node:fs";
import path from "node:path";
import { loadDataset, loadGpzSizes, listTrackFiles } from "./lib/dataset.mjs";
import { encodeGpsl0, decodeGpsl0, DEFAULT_MODEL_ID, getLayout } from "../src/services/gpsl0/index.ts";
import { FRONTEND_ROOT, REPO_ROOT } from "./lib/dataset.mjs";
import { bitsPerPoint, formatBytes } from "./lib/metrics.mjs";

function parseArgs(argv) {
  const opts = {
    out: path.join(FRONTEND_ROOT, "local-data", "r2", "tracks-gpsl0"),
    verify: false,
    losslessAlt: false,
    json: path.join(FRONTEND_ROOT, "scripts", ".cache", "pack_gpsl0.json"),
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) opts.out = path.resolve(arg.slice(6));
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--lossless-alt") opts.losslessAlt = true;
    else if (arg.startsWith("--json=")) opts.json = arg.slice(7);
    else if (arg === "--help" || arg === "-h") {
      console.log("see header of frontend/scripts/pack_gpsl0.mjs");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const opts = parseArgs(process.argv);
const tracks = loadDataset({ verbose: true });
const gpzSizes = loadGpzSizes();
const encodeOpts = {
  quantum: "auto",
  altQuantum: opts.losslessAlt ? 1 : 10,
};

fs.mkdirSync(opts.out, { recursive: true });

const layout = getLayout(DEFAULT_MODEL_ID);
const rows = [];
let totalBytes = 0;
let totalGpz = 0;
let totalPoints = 0;
let verifyFailures = 0;
const t0 = Date.now();

for (const tr of tracks) {
  const bytes = encodeGpsl0(tr, encodeOpts);
  const file = path.join(opts.out, `${tr.id}.gpsl0`);
  fs.writeFileSync(file, bytes);
  const gpz = gpzSizes.get(tr.id);
  totalBytes += bytes.length;
  totalGpz += gpz;
  totalPoints += tr.n;

  let verified = null;
  if (opts.verify) {
    const dec = decodeGpsl0(bytes);
    let latDev = 0;
    let lonDev = 0;
    let altDev = 0;
    for (let i = 0; i < tr.n; i++) {
      const dLat = Math.abs(dec.lat[i] - tr.lat[i]);
      const dLon = Math.abs(dec.lon[i] - tr.lon[i]);
      const dAlt = Math.abs(dec.alt[i] - tr.alt[i]);
      if (dLat > latDev) latDev = dLat;
      if (dLon > lonDev) lonDev = dLon;
      if (dAlt > altDev) altDev = dAlt;
      if (dec.t[i] !== tr.t[i]) throw new Error(`${tr.id}: timestamp mismatch @${i}`);
    }
    const limit = opts.losslessAlt ? 0 : 5;
    if (latDev > 0 || lonDev > 0 || altDev > limit) {
      verifyFailures++;
      console.log(
        `  VERIFY FAIL ${tr.id}: lat=${latDev} lon=${lonDev} alt=${altDev}`
      );
    }
    verified = { latDev, lonDev, altDev };
  }

  rows.push({
    id: tr.id,
    points: tr.n,
    gpzBytes: gpz,
    gpsl0Bytes: bytes.length,
    bitsPerPoint: bitsPerPoint(bytes.length, tr.n),
    ratio: gpz / bytes.length,
    verify: verified,
  });
}

const index = {
  generatedAt: new Date().toISOString(),
  codec: {
    format: "GPSL0",
    version: 1,
    modelId: DEFAULT_MODEL_ID,
    nCtx: layout.nCtx,
    nSlot: layout.nSlot,
    quantum: "auto",
    altQuantum: encodeOpts.altQuantum,
  },
  totals: {
    tracks: tracks.length,
    points: totalPoints,
    gpzBytes: totalGpz,
    gpsl0Bytes: totalBytes,
    bitsPerPoint: bitsPerPoint(totalBytes, totalPoints),
    ratio: totalGpz / totalBytes,
  },
  objects: rows,
};

fs.mkdirSync(path.dirname(opts.json), { recursive: true });
fs.writeFileSync(path.join(opts.out, "index.gpsl0.json"), JSON.stringify(index, null, 2));
fs.writeFileSync(opts.json, JSON.stringify(index, null, 2));

const elapsed = Date.now() - t0;
console.log(
  `\npacked ${rows.length} tracks -> ${opts.out}\n` +
    `  points ${totalPoints.toLocaleString()} | GPZ ${formatBytes(totalGpz)} -> ` +
    `GPSL0 ${formatBytes(totalBytes)} (${index.totals.bitsPerPoint.toFixed(2)} b/pt, ` +
    `${index.totals.ratio.toFixed(2)}x) in ${elapsed} ms`
);
if (opts.verify) {
  console.log(
    verifyFailures === 0
      ? `  verify: PASS (${rows.length}/${rows.length}, coords exact, alt<=${opts.losslessAlt ? 0 : 5})`
      : `  verify: ${verifyFailures} FAILED`
  );
}
console.log(`  index -> ${path.join(opts.out, "index.gpsl0.json")}`);

// Relative paths in the summary help copy/paste into the deployment docs.
const rel = path.relative(REPO_ROOT, opts.out);
console.log(`  (repo-relative: ${rel})`);

// Sizes of the largest objects, useful for sanity-checking an upload plan.
const top = [...rows].sort((a, b) => b.gpsl0Bytes - a.gpsl0Bytes).slice(0, 5);
console.log(
  "  largest objects: " +
    top.map((r) => `${r.id}=${formatBytes(r.gpsl0Bytes)}`).join(", ")
);
