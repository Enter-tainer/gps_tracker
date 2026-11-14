// Lead self-test for GPSL0: range coder roundtrip + codec roundtrip on real tracks.
import { loadDataset, loadGpzSizes } from "./lib/dataset.mjs";
import {
  encodeGpsl0,
  decodeGpsl0,
  decodeGpsl0Window,
  inspectGpsl0Header,
  DEFAULT_MODEL_ID,
  getLayout,
} from "../src/services/gpsl0/index.ts";
import { RangeEncoder, RangeDecoder } from "../src/services/gpsl0/rangecoder.ts";

function testRangeCoder() {
  const enc = new RangeEncoder();
  const probsE = new Uint16Array(16 * 4);
  probsE.fill(1024);
  const bits = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300000; i++) {
    const ctx = i & 15;
    const p = rnd();
    const bit = p < 0.2 + 0.05 * ctx ? 0 : 1;
    bits.push(bit);
    enc.encodeBit(probsE, ctx * 4 + (i & 3), bit);
  }
  const out = enc.finish();
  const dec = new RangeDecoder(out);
  const probsD = new Uint16Array(16 * 4);
  probsD.fill(1024);
  let ok = true;
  for (let i = 0; i < bits.length; i++) {
    const ctx = i & 15;
    if (dec.decodeBit(probsD, ctx * 4 + (i & 3)) !== bits[i]) {
      ok = false;
      break;
    }
  }
  console.log(`range coder: ${ok ? "PASS" : "FAIL"} (300000 bits, ${out.length} B)`);
  return ok;
}

function testDirectBits() {
  const enc = new RangeEncoder();
  const bits = [];
  let seed = 999;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 100000; i++) {
    const b = rnd() < 0.5 ? 0 : 1;
    bits.push(b);
    enc.encodeDirect(b);
  }
  const out = enc.finish();
  const dec = new RangeDecoder(out);
  let ok = true;
  for (let i = 0; i < bits.length; i++) {
    if (dec.decodeDirect() !== bits[i]) {
      ok = false;
      break;
    }
  }
  console.log(`range coder direct: ${ok ? "PASS" : "FAIL"} (${out.length} B)`);
  return ok;
}

function maxDeviation(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

const rcOk = testRangeCoder() && testDirectBits();

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

  const gpz = sizes.get(tr.id);
  const meta = inspectGpsl0Header(encExact);
  const bitsPerPt = (encExact.length * 8) / tr.n;
  if (!exact || !lossyOk || !winOk) failures++;
  console.log(
    `${tr.id.padEnd(18)} n=${String(tr.n).padStart(6)} gpz=${gpz} B ` +
      `auto=${encExact.length} B (q=${meta.coordQuantum}, ${bitsPerPt.toFixed(2)} b/pt, ` +
      `${((gpz * 8) / tr.n / bitsPerPt).toFixed(2)}x) exact=${exact ? "Y" : "N"} ` +
      `lossy=${encLossy.length} B dev=${devLat}/${devLon}/${devAlt} ` +
      `win=${winOk ? "Y" : "N"} blocks=${meta.nBlocks}`
  );
}

console.log(
  `model_id=${DEFAULT_MODEL_ID} ctx=${layout.nCtx} slots=${layout.nSlot} ` +
    `rc=${rcOk ? "ok" : "BROKEN"} failures=${failures}`
);
