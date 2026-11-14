/**
 * Empirical entropy / distribution utilities for the GPSL0 Step-1 ablation.
 *
 * Design constraints:
 *  - Only integer arithmetic and IEEE-754 double add/mul/div/log2. No trig, no Date,
 *    no locale-dependent formatting => every helper here is bit-exact across JS / Rust / C.
 *  - Entropy helpers take plain `Map<value, count>` histograms. Values are integers
 *    (residuals, magnitudes) or small bucket ids (contexts).
 *  - Everything reported by these helpers is a **plugin (empirical) entropy**, i.e. an
 *    ORACLE lower bound. `mmCorrect()` adds the Miller-Madow bias correction back so the
 *    caller can see how much of a gap a real adaptive coder can never close.
 */

export const LN2 = Math.LN2;

/* ------------------------------------------------------------------ *
 * Integer helpers
 * ------------------------------------------------------------------ */

/** Symmetric integer round-division: round(a / b), halves away from zero. b may be any sign. */
export function roundDiv(a, b) {
  if (b === 0) return 0;
  if (b < 0) {
    a = -a;
    b = -b;
  }
  if (a >= 0) return Math.trunc((a + (b >> 1)) / b);
  return -Math.trunc((-a + (b >> 1)) / b);
}

/** Standard zigzag: 0->0, -1->1, 1->2, -2->3, ... */
export function zigzag(e) {
  return e >= 0 ? e * 2 : -e * 2 - 1;
}

export function unzigzag(u) {
  return u % 2 === 1 ? -(u + 1) / 2 : u / 2;
}

/** floor(log2(u)) for u >= 1, exact for u up to 2^53. */
export function floorLog2(u) {
  if (u < 1) return -1;
  if (u <= 2147483647) return 31 - Math.clz32(u);
  let m = 0;
  let v = u;
  while (v > 2147483647) {
    v = Math.floor(v / 2);
    m += 1;
  }
  return m + (31 - Math.clz32(v));
}

/**
 * Signed magnitude bucket of a residual, `2 * maxExp + 1` buckets.
 *   bucket(0) = 0, bucket(+/-1) = +/-1, bucket(+/-2..3) = +/-2, ...
 *   magnitude exponent is clamped at `maxExp - 1`, so the largest bucket means ">= 2^(maxExp-1)".
 * signedBucket(e, 8) => 17 buckets {-8..8} (design doc §3.4 prev_q1)
 * signedBucket(e, 4) => 9 buckets, (alt prev_dalt)
 */
export function signedBucket(e, maxExp) {
  if (e === 0) return 0;
  const mag = e > 0 ? e : -e;
  const b = 1 + Math.min(maxExp - 1, floorLog2(mag));
  return e > 0 ? b : -b;
}

/** 5 dt buckets used by ctx_dt: 0s / 1s / 2s / 3-5s / >5s. */
export function bucketDt(dt) {
  if (dt <= 0) return 0;
  if (dt === 1) return 1;
  if (dt === 2) return 2;
  if (dt <= 5) return 3;
  return 4;
}

/* ------------------------------------------------------------------ *
 * Plain histograms
 * ------------------------------------------------------------------ */

export function hAdd(map, k) {
  map.set(k, (map.get(k) || 0) + 1);
}

export function hMerge(dst, src) {
  for (const [k, v] of src) dst.set(k, (dst.get(k) || 0) + v);
}

export function hCount(map) {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}

/** Plugin zero-order entropy (bits) of a histogram. */
export function hEntropy(map, n) {
  let h = 0;
  for (const c of map.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/* ------------------------------------------------------------------ *
 * Context -> value histograms
 * ------------------------------------------------------------------ */

/**
 * An array of per-context histograms, allocated lazily and clearable in O(touched).
 * Up to ~1e4 contexts and a few 1e5 distinct values is the intended scale.
 */
export class CtxHists {
  constructor(size) {
    this.size = size;
    this.hists = new Array(size);
    this.touched = [];
  }

  add(ctx, value) {
    let m = this.hists[ctx];
    if (m === undefined) {
      m = new Map();
      this.hists[ctx] = m;
      this.touched.push(ctx);
    }
    m.set(value, (m.get(value) || 0) + 1);
  }

  clear() {
    for (let i = 0; i < this.touched.length; i++) this.hists[this.touched[i]] = undefined;
    this.touched.length = 0;
  }

  mergeInto(dst) {
    for (let i = 0; i < this.touched.length; i++) {
      const c = this.touched[i];
      const src = this.hists[c];
      let m = dst.hists[c];
      if (m === undefined) {
        m = new Map();
        dst.hists[c] = m;
        dst.touched.push(c);
      }
      for (const [k, v] of src) m.set(k, (m.get(k) || 0) + v);
    }
  }

  /** Re-key every histogram through `keyFn(fineCtx) -> coarseCtx`. */
  marginalize(nCoarse, keyFn) {
    const out = new CtxHists(nCoarse);
    for (let i = 0; i < this.touched.length; i++) {
      const f = this.touched[i];
      const c = keyFn(f);
      const src = this.hists[f];
      let m = out.hists[c];
      if (m === undefined) {
        m = new Map();
        out.hists[c] = m;
        out.touched.push(c);
      }
      for (const [k, v] of src) m.set(k, (m.get(k) || 0) + v);
    }
    return out;
  }

  /** Sum of per-context sample counts. */
  total() {
    let n = 0;
    for (let i = 0; i < this.touched.length; i++) {
      for (const v of this.hists[this.touched[i]].values()) n += v;
    }
    return n;
  }

  /** Per-context sample counts, as a Map<ctx, n>. */
  counts() {
    const out = new Map();
    for (let i = 0; i < this.touched.length; i++) {
      const c = this.touched[i];
      let n = 0;
      for (const v of this.hists[c].values()) n += v;
      out.set(c, n);
    }
    return out;
  }
}

/**
 * H(e | ctx) of a CtxHists, in bits per sample.
 *
 * Returns `H` (the plugin/oracle value) plus the bookkeeping needed for the
 * Miller-Madow bias correction:
 *   kUsed = number of contexts that actually occurred
 *   kEff  = number of (ctx, value) pairs that occurred
 *   mmBits = (kEff - kUsed) / (2 * N * ln2)
 * `H + mmBits` is the first-order bias-corrected estimate; the plugin value is
 * always <= the truth by roughly this much, and the gap grows linearly in the
 * number of parameters you let the model spend.
 */
export function condEntropy(hists, nTotal) {
  let acc = 0; // sum over ctx of n_ctx * H_ctx
  let kUsed = 0;
  let kEff = 0;
  for (let i = 0; i < hists.touched.length; i++) {
    const m = hists.hists[hists.touched[i]];
    let n = 0;
    for (const v of m.values()) n += v;
    kUsed += 1;
    kEff += m.size;
    let hc = 0;
    for (const v of m.values()) {
      const p = v / n;
      hc -= p * Math.log2(p);
    }
    acc += n * hc;
  }
  const H = nTotal === 0 ? 0 : acc / nTotal;
  const mmBits = nTotal === 0 ? 0 : (kEff - kUsed) / (2 * nTotal * LN2);
  return { H, mmBits, Hmm: H + mmBits, kUsed, kEff, n: nTotal };
}

/* ------------------------------------------------------------------ *
 * Adaptive binary slot model (models the real ECGL0-style range coder)
 * ------------------------------------------------------------------ */

/**
 * Binary probability slots with the KT (Krichevsky-Trofimov) estimator,
 * i.e. every binary decision is charged -log2((n_bit + 0.5) / (n0 + n1 + 1)).
 * That is the exact asymptotic behaviour of an adaptive binary range coder
 * with a 0.5-biased initialisation, up to the 11-bit probability quantisation.
 */
export class SlotModel {
  constructor(nCtx, nSlot) {
    this.nSlot = nSlot;
    this.zero = new Uint32Array(nCtx * nSlot);
    this.one = new Uint32Array(nCtx * nSlot);
  }

  reset() {
    this.zero.fill(0);
    this.one.fill(0);
  }

  /** Charge one binary decision at `slot`; returns its cost in bits. */
  bit(slot, b) {
    const z = this.zero[slot];
    const o = this.one[slot];
    const den = z + o + 1;
    let cost;
    if (b === 1) {
      cost = -Math.log2((o + 0.5) / den);
      this.one[slot] = o + 1;
    } else {
      cost = -Math.log2((z + 0.5) / den);
      this.zero[slot] = z + 1;
    }
    return cost;
  }
}

/**
 * Slot layout used by GPSL0 (`N_SLOT = 1 + M_MAX + M_MAX*M_MAX + RAW_SLOTS`).
 *   slot 0                : zero flag (u != 0 ? 1 : 0)
 *   slot 1 .. M_MAX       : unary order m (k ones then one zero)
 *   slot 1+M_MAX + m*M_MAX + k : mantissa bit k of order m
 *   slot ESC_BASE ..      : raw bits of escaped values (context-free)
 */
export function slotLayout(mMax, rawSlots = 32) {
  const escBase = 1 + mMax + mMax * mMax;
  return { zero: 0, unary: 1, mant: 1 + mMax, escBase, nSlot: escBase + rawSlots, mMax };
}

/**
 * Charge the binarised cost of residual `e` under the slot layout.
 * `ctxSlotBase` is the first slot of the context this residual belongs to.
 * Returns the cost in bits; escapes are counted in `stats.escapes`.
 */
export function chargeResidual(model, layout, ctxSlotBase, e, stats) {
  const u = zigzag(e);
  let cost = model.bit(ctxSlotBase + layout.zero, u !== 0 ? 1 : 0);
  if (u === 0) return cost;

  const m = floorLog2(u);
  const mMax = layout.mMax;
  const unaryLimit = mMax - 1; // m >= unaryLimit is an escape
  if (m >= unaryLimit) {
    for (let k = 0; k < unaryLimit; k++) cost += model.bit(ctxSlotBase + layout.unary + k, 1);
    if (stats) stats.escapes += 1;
    // escape payload: m+1 raw bits, context-free, MSB first
    const nbits = m + 1;
    for (let k = nbits - 1; k >= 0; k--) {
      const b = Math.floor(u / 2 ** k) & 1;
      cost += model.bit(layout.escBase + k, b);
    }
    return cost;
  }

  for (let k = 0; k < m; k++) cost += model.bit(ctxSlotBase + layout.unary + k, 1);
  cost += model.bit(ctxSlotBase + layout.unary + m, 0);

  const mantBase = ctxSlotBase + layout.mant;
  for (let k = m - 1; k >= 0; k--) {
    const b = Math.floor(u / 2 ** k) & 1;
    cost += model.bit(mantBase + m * mMax + k, b);
  }
  return cost;
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

export function quantileSorted(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** min / p10 / p25 / median / p75 / p90 / max / mean of a plain number array. */
export function summarize(values) {
  const n = values.length;
  if (n === 0) return { n: 0 };
  const s = Array.from(values).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return {
    n,
    min: s[0],
    p10: quantileSorted(s, 0.1),
    p25: quantileSorted(s, 0.25),
    median: quantileSorted(s, 0.5),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    max: s[n - 1],
    mean: sum / n,
  };
}

/* ------------------------------------------------------------------ *
 * Reporting helpers
 * ------------------------------------------------------------------ */

export function padEnd(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function padStart(s, w) {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Left-aligned row join with per-column widths. */
export function row(cells, widths, align = []) {
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const w = widths[i] ?? String(cells[i]).length;
    out.push(align[i] === "r" ? padStart(cells[i], w) : padEnd(cells[i], w));
  }
  return out.join(" ").replace(/\s+$/, "");
}

export function fn(v, digits = 3) {
  if (v === undefined || v === null || Number.isNaN(v)) return "-";
  return Number(v).toFixed(digits);
}

export function pct(v, digits = 2) {
  if (v === undefined || v === null || Number.isNaN(v)) return "-";
  return (v * 100).toFixed(digits) + "%";
}

export function bytesToMB(b) {
  return b / (1024 * 1024);
}

export function bitsToMB(bits, nPoints) {
  return (bits * nPoints) / 8 / 1024 / 1024;
}
