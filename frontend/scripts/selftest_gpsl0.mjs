// Lead self-test for GPSL0: WASM v2 default + v1 backwards-compat codec roundtrip and window slicing.
import { loadDataset, loadGpzSizes } from "./lib/dataset.mjs";
import {
  encodeGpsl0,
  decodeGpsl0,
  decodeGpsl0Window,
  inspectGpsl0Header,
  DEFAULT_VERSION,
  DEFAULT_MODEL_ID,
  getLayout,
} from "../src/services/gpsl0/index.ts";

function maxDeviation(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

const tracks = loadDataset({ verbose: true });
const sizes = loadGpzSizes();
const track = (id) => {
  const t = tracks.find((x) => x.id === id);
  if (!t) throw new Error(`no track ${id}`);
  return t;
};

const byN = [...tracks].sort((a, b) => b.n - a.n);
const picks = [byN[0], byN[1], track("20250509"), track("20250508")];
const layout = getLayout(DEFAULT_MODEL_ID);
let failures = 0;

for (const tr of picks) {
  // Lossless at the data's natural quantum: must be bit-exact.
  const encExact = encodeGpsl0(tr, { quantum: "auto", altQuantum: 1 });
  const decExact = decodeGpsl0(encExact);
  const exact =
    maxDeviation(decExact.lat, tr.lat) === 0 &&
    maxDeviation(decExact.lon, tr.lon) === 0 &&
    maxDeviation(decExact.alt, tr.alt) === 0 &&
    maxDeviation(decExact.t, tr.t) === 0;

  // Lossy 11 cm / 1 m mode: bounded deviation instead.
  const encLossy = encodeGpsl0(tr, { quantum: 10, altQuantum: 10 });
  const decLossy = decodeGpsl0(encLossy);
  const devLat = maxDeviation(decLossy.lat, tr.lat);
  const devLon = maxDeviation(decLossy.lon, tr.lon);
  const devAlt = maxDeviation(decLossy.alt, tr.alt);
  const lossyOk = devLat <= 5 && devLon <= 5 && devAlt <= 5;

  // Window decode must equal the full decode slice.
  let winOk = true;
  for (const [s, len] of [
    [0, 1],
    [Math.floor(tr.n / 2), Math.min(100, tr.n - Math.floor(tr.n / 2))],
    [Math.max(0, tr.n - 3), Math.min(3, tr.n)],
  ]) {
    if (len <= 0) continue;
    const w = decodeGpsl0Window(encExact, s, len);
    for (let i = 0; i < len; i++) {
      if (
        w.t[i] !== decExact.t[s + i] ||
        w.lat[i] !== decExact.lat[s + i] ||
        w.lon[i] !== decExact.lon[s + i] ||
        w.alt[i] !== decExact.alt[s + i]
      ) {
        winOk = false;
        break;
      }
    }
    if (!winOk) {
      console.log(`  window mismatch track=${tr.id} start=${s} len=${len}`);
      break;
    }
  }

  // v1 compatibility: explicit version=1, modelId=7 lossless roundtrip.
  const encV1 = encodeGpsl0(tr, { version: 1, modelId: 7, quantum: "auto", altQuantum: 1 });
  const metaV1 = inspectGpsl0Header(encV1);
  const decV1 = decodeGpsl0(encV1);
  const exactV1 =
    metaV1.version === 1 &&
    metaV1.modelId === 7 &&
    maxDeviation(decV1.lat, tr.lat) === 0 &&
    maxDeviation(decV1.lon, tr.lon) === 0 &&
    maxDeviation(decV1.alt, tr.alt) === 0 &&
    maxDeviation(decV1.t, tr.t) === 0;

  const gpz = sizes.get(tr.id);
  const meta = inspectGpsl0Header(encExact);
  const hdrOk = meta.version === DEFAULT_VERSION && meta.modelId === DEFAULT_MODEL_ID;
  const bitsPerPt = (encExact.length * 8) / tr.n;
  if (!exact || !lossyOk || !winOk || !exactV1 || !hdrOk) failures++;
  console.log(
    `${tr.id.padEnd(18)} n=${String(tr.n).padStart(6)} gpz=${gpz} B ` +
      `auto=${encExact.length} B (v${meta.version}/m${meta.modelId}, q=${meta.coordQuantum}, ${bitsPerPt.toFixed(2)} b/pt, ` +
      `${((gpz * 8) / tr.n / bitsPerPt).toFixed(2)}x) exact=${exact ? "Y" : "N"} ` +
      `v1=${encV1.length} B (${exactV1 ? "Y" : "N"}) ` +
      `lossy=${encLossy.length} B dev=${devLat}/${devLon}/${devAlt} ` +
      `win=${winOk ? "Y" : "N"} blocks=${meta.nBlocks}`
  );
}

console.log(
  `version=${DEFAULT_VERSION} model_id=${DEFAULT_MODEL_ID} ctx=${layout.nCtx} slots=${layout.nSlot} ` +
    `failures=${failures}`
);
if (failures > 0) process.exitCode = 1;
