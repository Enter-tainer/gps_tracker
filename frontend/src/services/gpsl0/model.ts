// GPSL0 model: predictors, kinematic context derivation and residual
// binarization (zigzag + unary order + low-bit-first mantissa tree).
//
// Every model variant is identified by `model_id` and pins *all* of its
// constants here. The encoder writes the id it used; the decoder looks the
// spec up and rejects unknown ids (never "best effort" — a wrong constant
// silently decodes garbage without ever raising an error).
//
// Everything is pure integer arithmetic on already-decoded state, so encoder
// and decoder derive identical contexts without any side channel. All
// intermediate values stay well below 2^53, hence IEEE-754 doubles are exact
// and the bitstream is engine-independent.

import type { RangeDecoder, RangeEncoder } from "./rangecoder.ts";

// ---------------------------------------------------------------------------
// Slot layout of one context
//   0                       zero flag
//   1 .. unarySlots         unary order (m ones, then a zero)
//   treeBase ..             2^mantTreeBits - 1 nodes, low bits first
//   flatBase ..             remaining higher mantissa bits, one slot per position
// ---------------------------------------------------------------------------
export const ZERO_SLOT = 0;
export const UNARY_SLOT0 = 1;

export type ModelSpec = {
  id: number;
  /** m = 0..unarySlots-1 stay in the adaptive path; m >= unarySlots escapes. */
  unarySlots: number;
  /** Mantissa bits coded low-bit-first through a binary tree (0 = disabled). */
  mantTreeBits: number;
  /** Speed regime thresholds in mm/s (length k => k+1 regimes). */
  speedThresholds: number[];
  /** log2 bucket count for coordinate residuals: 2*qLevels+1 contexts. */
  qLevels: number;
  /** log2 bucket count for altitude residual buckets: 2*altLevels+1 contexts. */
  altLevels: number;
  /** Condition the lon context on the just-decoded lat residual bucket. */
  lonUsesLatResidual: boolean;
  /** Number of dt buckets (>= 4). */
  dtLevels: number;
  /** Add a "dt changed since the previous point" flag to the coord contexts. */
  coordDtChanged?: boolean;
};

export const MODELS: Record<number, ModelSpec> = {
  // v1: flat per-position mantissa (kept for A/B comparison with the doc's
  // original scheme; NOT the default).
  1: {
    id: 1,
    unarySlots: 24,
    mantTreeBits: 0,
    speedThresholds: [300, 2200, 5500, 12000, 30000],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
  },
  // v2: 3-bit low-first tree (the measured sweet spot).
  2: {
    id: 2,
    unarySlots: 24,
    mantTreeBits: 3,
    speedThresholds: [300, 2200],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
  },
  // v3: 4-bit tree.
  3: {
    id: 3,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [300, 2200],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
  },
  // v4: 5-bit tree.
  4: {
    id: 4,
    unarySlots: 24,
    mantTreeBits: 5,
    speedThresholds: [300, 2200],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
  },
  // v5: 4-bit tree with the finer 6-regime speed split.
  5: {
    id: 5,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [300, 2200, 5500, 12000, 30000],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
  },
  // v6: 4-bit tree, no speed split.
  6: {
    id: 6,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
    coordDtChanged: false,
  },
  // v7: tree4, 1 speed regime, + dt-changed flag in the coord context.
  7: {
    id: 7,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
    coordDtChanged: true,
  },
  // v8: tree4, 2 speed regimes, + dt-changed flag.
  8: {
    id: 8,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [300, 2200],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
    coordDtChanged: true,
  },
  // v10: clean A/B for the mantissa tree -- identical to v7 but flat (no tree).
  10: {
    id: 10,
    unarySlots: 24,
    mantTreeBits: 0,
    speedThresholds: [],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 5,
    coordDtChanged: true,
  },
  // v9: tree4, 1 speed regime, dt-changed flag, 6 dt buckets.
  9: {
    id: 9,
    unarySlots: 24,
    mantTreeBits: 4,
    speedThresholds: [],
    qLevels: 8,
    altLevels: 4,
    lonUsesLatResidual: false,
    dtLevels: 6,
    coordDtChanged: true,
  },
};

/** Default model written by the encoder. */
export const DEFAULT_MODEL_ID = 7;

export type ModelLayout = {
  spec: ModelSpec;
  nSlot: number;
  treeBase: number;
  treeNodes: number;
  flatBase: number;
  nQ1: number;
  nAltQ: number;
  nSpeed: number;
  dtCtx0: number;
  latCtx0: number;
  lonCtx0: number;
  altCtx0: number;
  nCtx: number;
  /** 2 when the coord context carries a dt-changed flag, else 1. */
  coordDtChanged: number;
};

export function layoutOf(spec: ModelSpec): ModelLayout {
  const treeNodes = spec.mantTreeBits === 0 ? 0 : (1 << spec.mantTreeBits) - 1;
  const treeBase = 1 + spec.unarySlots;
  const flatBase = treeBase + treeNodes;
  const flatSlots = Math.max(0, spec.unarySlots - 1 - spec.mantTreeBits);
  const nSlot = flatBase + flatSlots;
  const nQ1 = 2 * spec.qLevels + 1;
  const nAltQ = 2 * spec.altLevels + 1;
  const nSpeed = spec.speedThresholds.length + 1;
  const dchg = spec.coordDtChanged ? 2 : 1;
  const dtCount = spec.dtLevels * 2;
  const dtCtx0 = 0;
  const latCtx0 = dtCtx0 + dtCount;
  const latCount = nSpeed * nQ1 * dchg;
  const lonCtx0 = latCtx0 + latCount;
  const lonCount = spec.lonUsesLatResidual
    ? nSpeed * nQ1 * dchg * nQ1
    : nSpeed * nQ1 * dchg;
  const altCtx0 = lonCtx0 + lonCount;
  const altCount = nSpeed * nAltQ;
  return {
    spec,
    nSlot,
    treeBase,
    treeNodes,
    flatBase,
    nQ1,
    nAltQ,
    nSpeed,
    dtCtx0,
    latCtx0,
    lonCtx0,
    altCtx0,
    nCtx: altCtx0 + altCount,
    coordDtChanged: dchg,
  };
}

const LAYOUT_CACHE = new Map<number, ModelLayout>();

export function getLayout(modelId: number): ModelLayout {
  const spec = MODELS[modelId];
  if (!spec) {
    throw new Error(
      `GPSL0: unsupported model_id ${modelId} (known: ${Object.keys(MODELS).join(", ")})`
    );
  }
  let layout = LAYOUT_CACHE.get(modelId);
  if (!layout) {
    layout = layoutOf(spec);
    LAYOUT_CACHE.set(modelId, layout);
  }
  return layout;
}

export function createProbTable(layout: ModelLayout): Uint16Array {
  const probs = new Uint16Array(layout.nCtx * layout.nSlot);
  probs.fill(1024);
  return probs;
}

// ---------------------------------------------------------------------------
// Diagnostics (encoder side only; never affects the bitstream)
// ---------------------------------------------------------------------------
export type ChannelStats = { bits: number; points: number };

function mkStats(): ChannelStats {
  return { bits: 0, points: 0 };
}

export const MODEL_STATS = {
  enabled: false,
  total: mkStats(),
  dt: mkStats(),
  lat: mkStats(),
  lon: mkStats(),
  alt: mkStats(),
  overheadBytes: 0,
  reset(): void {
    for (const key of ["total", "dt", "lat", "lon", "alt"] as const) {
      this[key].bits = 0;
      this[key].points = 0;
    }
    this.overheadBytes = 0;
  },
};

function emit(
  enc: RangeEncoder,
  probs: Uint16Array,
  index: number,
  bit: number,
  stats?: ChannelStats
): void {
  if (stats !== undefined) {
    const p0 = probs[index] / 2048;
    stats.bits += bit === 0 ? -Math.log2(p0) : -Math.log2(1 - p0);
  }
  enc.encodeBit(probs, index, bit);
}

function emitDirect(
  enc: RangeEncoder,
  bit: number,
  stats?: ChannelStats
): void {
  if (stats !== undefined) stats.bits += 1;
  enc.encodeDirect(bit);
}

// ---------------------------------------------------------------------------
// Binarization
// ---------------------------------------------------------------------------
export function zigzag(e: number): number {
  return ((e << 1) ^ (e >> 31)) >>> 0;
}

export function unzigzag(u: number): number {
  return ((u >>> 1) ^ -(u & 1)) | 0;
}

export function encodeResidual(
  enc: RangeEncoder,
  probs: Uint16Array,
  layout: ModelLayout,
  ctx: number,
  e: number,
  stats?: ChannelStats
): void {
  const spec = layout.spec;
  const base = ctx * layout.nSlot;
  const u = zigzag(e);
  if (u === 0) {
    emit(enc, probs, base + ZERO_SLOT, 0, stats);
    return;
  }
  emit(enc, probs, base + ZERO_SLOT, 1, stats);
  const m = 31 - Math.clz32(u);
  if (m >= spec.unarySlots) {
    for (let t = 0; t < spec.unarySlots; t++) {
      emit(enc, probs, base + UNARY_SLOT0 + t, 1, stats);
    }
    for (let k = 31; k >= 0; k--) emitDirect(enc, (u >>> k) & 1, stats);
    return;
  }
  for (let t = 0; t < m; t++) {
    emit(enc, probs, base + UNARY_SLOT0 + t, 1, stats);
  }
  emit(enc, probs, base + UNARY_SLOT0 + m, 0, stats);
  // Mantissa, lowest bit first. Bits below `mantTreeBits` go through the tree
  // node selected by the already-coded low bits (bit 0 is the sign).
  const treeBits = spec.mantTreeBits;
  for (let k = 0; k < m; k++) {
    const bit = (u >>> k) & 1;
    if (k < treeBits) {
      const node = layout.treeBase + ((1 << k) - 1) + (u & ((1 << k) - 1));
      emit(enc, probs, base + node, bit, stats);
    } else {
      emit(enc, probs, base + layout.flatBase + (k - treeBits), bit, stats);
    }
  }
}

export function decodeResidual(
  dec: RangeDecoder,
  probs: Uint16Array,
  layout: ModelLayout,
  ctx: number
): number {
  const spec = layout.spec;
  const base = ctx * layout.nSlot;
  if (dec.decodeBit(probs, base + ZERO_SLOT) === 0) return 0;
  let m = 0;
  while (m < spec.unarySlots) {
    const bit = dec.decodeBit(probs, base + UNARY_SLOT0 + m);
    if (bit === 0) break;
    m++;
  }
  if (m === spec.unarySlots) {
    let u = 0;
    for (let k = 0; k < 32; k++) u = ((u << 1) | dec.decodeDirect()) >>> 0;
    return unzigzag(u);
  }
  let u = 0;
  const treeBits = spec.mantTreeBits;
  for (let k = 0; k < m; k++) {
    let bit: number;
    if (k < treeBits) {
      const node = layout.treeBase + ((1 << k) - 1) + u;
      bit = dec.decodeBit(probs, base + node);
    } else {
      bit = dec.decodeBit(probs, base + layout.flatBase + (k - treeBits));
    }
    u |= bit << k;
  }
  u |= 1 << m;
  return unzigzag(u >>> 0);
}

// ---------------------------------------------------------------------------
// Context derivation
// ---------------------------------------------------------------------------
export function dtBucket(dt: number, levels: number): number {
  if (dt <= 0) return 0;
  if (dt === 1) return 1;
  if (levels <= 2) return 2;
  if (dt === 2) return 2;
  if (levels <= 3) return 2;
  if (dt <= 5) return 3;
  if (levels <= 4) return 3;
  if (dt <= 15) return 4;
  return levels - 1;
}

/**
 * Speed regime from the previous integer velocity vector and dt.
 * Speed is approximated as |vlat| + |vlon| in stored units/s and converted to
 * mm/s with 111 mm per 1e-6 deg of latitude; bucketing is only a context
 * selector, so the approximation is harmless.
 */
export function speedRegime(
  vlat: number,
  vlon: number,
  dtPrev: number,
  thresholds: number[]
): number {
  const sum = Math.abs(vlat) + Math.abs(vlon);
  const dt = dtPrev > 0 ? dtPrev : 1;
  const mmps = Math.floor((sum * 111) / dt);
  for (let i = 0; i < thresholds.length; i++) {
    if (mmps < thresholds[i]) return i;
  }
  return thresholds.length;
}

/** Signed log2 bucket 0..2*levels, 0 = exact zero, then +1/-1 alternating. */
export function q1(e: number, levels: number): number {
  if (e === 0) return 0;
  const a = e < 0 ? -e : e;
  let b = 31 - Math.clz32(a);
  if (b > levels - 1) b = levels - 1;
  return 1 + 2 * b + (e < 0 ? 1 : 0);
}

/** Altitude uses the same bucket shape, just fewer levels. */
export function altQ(e: number, levels: number): number {
  return q1(e, levels);
}

// ---------------------------------------------------------------------------
// Predictors
// ---------------------------------------------------------------------------
/** Signed integer rounding division, b > 0 (design doc §3.2). */
export function roundDiv(a: number, b: number): number {
  if (a >= 0) return Math.trunc((a + (b >> 1)) / b);
  return -Math.trunc((-a + (b >> 1)) / b);
}

/**
 * Coordinate predictor.
 * napiveD2  = true:  `2*x[i-1] - x[i-2]` regardless of dt (measured better on
 *                    this corpus: dt changes are mostly 1s<->2s jitter, and
 *                    proportional extrapolation over a long gap over-shoots).
 * naiveD2  = false: time-normalized constant-velocity extrapolation.
 */
export const COORD_NAIVE = 1;
export const COORD_TN = 0;
export const COORD_TN_CLAMPED = 2;
/** Longest extrapolation ratio used by COORD_TN_CLAMPED. */
export const TN_CLAMP = 2;

export function predictCoord(
  xPrev2: number,
  xPrev: number,
  dtPrev: number,
  dtCur: number,
  coordMode: number
): number {
  if (coordMode === COORD_NAIVE) return 2 * xPrev - xPrev2;
  if (dtPrev > 0 && dtCur > 0) {
    const d = coordMode === COORD_TN_CLAMPED ? Math.min(dtCur, dtPrev * TN_CLAMP) : dtCur;
    return xPrev + roundDiv((xPrev - xPrev2) * d, dtPrev);
  }
  return xPrev;
}

export const ALT_MODE_D1 = 1;
export const ALT_MODE_DAMPED = 2;

export function predictAlt(xPrev2: number, xPrev: number, mode: number): number {
  if (mode === ALT_MODE_DAMPED) return xPrev + ((xPrev - xPrev2) >> 1);
  return xPrev;
}

// ---------------------------------------------------------------------------
// Block seeds and carried state
// ---------------------------------------------------------------------------
export const SEED_BYTES = 32;

export type BlockSeed = {
  t0: number;
  lat0: number;
  lon0: number;
  alt0: number;
  dt0: number;
  vlat0: number;
  vlon0: number;
  valt0: number;
};

export function writeSeed(out: Uint8Array, s: BlockSeed): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setInt32(0, s.t0 | 0, true);
  view.setInt32(4, s.lat0 | 0, true);
  view.setInt32(8, s.lon0 | 0, true);
  view.setInt32(12, s.alt0 | 0, true);
  view.setInt32(16, s.dt0 | 0, true);
  view.setInt32(20, s.vlat0 | 0, true);
  view.setInt32(24, s.vlon0 | 0, true);
  view.setInt32(28, s.valt0 | 0, true);
}

export function readSeed(bytes: Uint8Array, offset: number): BlockSeed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    t0: view.getInt32(offset + 0, true),
    lat0: view.getInt32(offset + 4, true),
    lon0: view.getInt32(offset + 8, true),
    alt0: view.getInt32(offset + 12, true),
    dt0: view.getInt32(offset + 16, true),
    vlat0: view.getInt32(offset + 20, true),
    vlon0: view.getInt32(offset + 24, true),
    valt0: view.getInt32(offset + 28, true),
  };
}

export type BlockState = {
  tPrev2: number;
  tPrev: number;
  dtPrev: number;
  latPrev2: number;
  latPrev: number;
  lonPrev2: number;
  lonPrev: number;
  altPrev2: number;
  altPrev: number;
  eDtPrev: number;
  eLatPrev: number;
  eLonPrev: number;
  eAltPrev: number;
};

type PointsView = {
  t: ArrayLike<number>;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  alt: ArrayLike<number>;
  start: number;
  count: number;
};

export function makeSeed(p: PointsView): BlockSeed {
  const { t, lat, lon, alt, start, count } = p;
  return {
    t0: t[start] | 0,
    lat0: lat[start] | 0,
    lon0: lon[start] | 0,
    alt0: alt[start] | 0,
    dt0: count >= 2 ? (t[start + 1] - t[start]) | 0 : 0,
    vlat0: count >= 2 ? (lat[start + 1] - lat[start]) | 0 : 0,
    vlon0: count >= 2 ? (lon[start + 1] - lon[start]) | 0 : 0,
    valt0: count >= 2 ? (alt[start + 1] - alt[start]) | 0 : 0,
  };
}

export function initState(seed: BlockSeed): BlockState {
  return {
    tPrev2: seed.t0,
    tPrev: seed.t0 + seed.dt0,
    dtPrev: seed.dt0,
    latPrev2: seed.lat0,
    latPrev: seed.lat0 + seed.vlat0,
    lonPrev2: seed.lon0,
    lonPrev: seed.lon0 + seed.vlon0,
    altPrev2: seed.alt0,
    altPrev: seed.alt0 + seed.valt0,
    eDtPrev: 0,
    eLatPrev: 0,
    eLonPrev: 0,
    eAltPrev: 0,
  };
}

// ---------------------------------------------------------------------------
// Block encode / decode
// ---------------------------------------------------------------------------
export type BlockEncodeParams = PointsView & {
  altMode: number;
  coordMode: number;
  layout: ModelLayout;
  seedOut: Uint8Array | null;
  carried: BlockState | null;
  stats?: boolean;
};

/**
 * Encodes one block. `seedOut !== null` opens a new sync window: the absolute
 * seed is written and encoding starts at `start + 2`. Otherwise the block
 * continues from `carried` and every point of the block is encoded.
 */
export function encodeBlock(
  enc: RangeEncoder,
  probs: Uint16Array,
  p: BlockEncodeParams,
  layout: ModelLayout
): BlockState {
  const { t, lat, lon, alt, start, count, altMode, coordMode } = p;
  const spec = layout.spec;
  let st: BlockState;
  let iStart: number;
  if (p.seedOut !== null) {
    const seed = makeSeed(p);
    writeSeed(p.seedOut, seed);
    st = initState(seed);
    iStart = start + 2;
  } else {
    if (p.carried === null) {
      throw new Error("GPSL0: continuation block without carried state");
    }
    st = p.carried;
    iStart = start;
  }
  const dStats = p.stats ? MODEL_STATS.dt : undefined;
  const latStats = p.stats ? MODEL_STATS.lat : undefined;
  const lonStats = p.stats ? MODEL_STATS.lon : undefined;
  const altStats = p.stats ? MODEL_STATS.alt : undefined;

  for (let i = iStart; i < start + count; i++) {
    const latPrev2 = st.latPrev2;
    const latPrev = st.latPrev;
    const lonPrev2 = st.lonPrev2;
    const lonPrev = st.lonPrev;
    const altPrev2 = st.altPrev2;
    const altPrev = st.altPrev;
    const dtPrev = st.dtPrev;

    const tCur = t[i];
    const dtCur = tCur - st.tPrev;
    const eDt = dtCur - dtPrev;
    const ctxDt =
      layout.dtCtx0 +
      dtBucket(dtPrev, spec.dtLevels) * 2 +
      (st.eDtPrev === 0 ? 0 : 1);
    encodeResidual(enc, probs, layout, ctxDt, eDt, dStats);

    const spd = speedRegime(
      latPrev - latPrev2,
      lonPrev - lonPrev2,
      dtPrev,
      spec.speedThresholds
    );
    // A dt change widens the prediction error; separating it keeps the
    // common "steady 1 Hz" distribution clean.
    const dchg = layout.coordDtChanged === 2 ? (eDt !== 0 ? 1 : 0) : 0;
    const coordCtxBase =
      (spd * layout.nQ1 + q1(st.eLatPrev, spec.qLevels)) * layout.coordDtChanged;

    const eLat =
      lat[i] - predictCoord(latPrev2, latPrev, dtPrev, dtCur, coordMode);
    const ctxLat = layout.latCtx0 + coordCtxBase + dchg;
    encodeResidual(enc, probs, layout, ctxLat, eLat, latStats);

    const eLon =
      lon[i] - predictCoord(lonPrev2, lonPrev, dtPrev, dtCur, coordMode);
    const lonCtxBase =
      (spd * layout.nQ1 + q1(st.eLonPrev, spec.qLevels)) * layout.coordDtChanged;
    const ctxLon = spec.lonUsesLatResidual
      ? layout.lonCtx0 + lonCtxBase * layout.nQ1 + q1(eLat, spec.qLevels)
      : layout.lonCtx0 + lonCtxBase + dchg;
    encodeResidual(enc, probs, layout, ctxLon, eLon, lonStats);

    const eAlt = alt[i] - predictAlt(altPrev2, altPrev, altMode);
    const ctxAlt =
      layout.altCtx0 +
      spd * layout.nAltQ +
      altQ(st.eAltPrev, spec.altLevels);
    encodeResidual(enc, probs, layout, ctxAlt, eAlt, altStats);

    st.tPrev2 = st.tPrev;
    st.tPrev = tCur;
    st.dtPrev = dtCur;
    st.latPrev2 = latPrev;
    st.latPrev = lat[i];
    st.lonPrev2 = lonPrev;
    st.lonPrev = lon[i];
    st.altPrev2 = altPrev;
    st.altPrev = alt[i];
    st.eDtPrev = eDt;
    st.eLatPrev = eLat;
    st.eLonPrev = eLon;
    st.eAltPrev = eAlt;
  }
  return st;
}

export type BlockDecodeParams = {
  dec: RangeDecoder;
  seed: BlockSeed | null;
  carried: BlockState | null;
  count: number;
  altMode: number;
  coordMode: number;
  layout: ModelLayout;
  probs: Uint16Array;
  outT: Int32Array;
  outLat: Int32Array;
  outLon: Int32Array;
  outAlt: Int32Array;
  outOffset: number;
};

export function decodeBlock(p: BlockDecodeParams): BlockState {
  const { dec, seed, count, altMode, coordMode, probs, outT, outLat, outLon, outAlt } =
    p;
  const layout = p.layout;
  const spec = layout.spec;
  const o = p.outOffset;
  let st: BlockState;
  let jStart: number;

  if (seed !== null) {
    outT[o] = seed.t0;
    outLat[o] = seed.lat0;
    outLon[o] = seed.lon0;
    outAlt[o] = seed.alt0;
    st = initState(seed);
    if (count >= 2) {
      outT[o + 1] = st.tPrev;
      outLat[o + 1] = st.latPrev;
      outLon[o + 1] = st.lonPrev;
      outAlt[o + 1] = st.altPrev;
    }
    jStart = 2;
  } else {
    if (p.carried === null) {
      throw new Error("GPSL0: continuation block without carried state");
    }
    st = p.carried;
    jStart = 0;
  }

  for (let j = jStart; j < count; j++) {
    const latPrev2 = st.latPrev2;
    const latPrev = st.latPrev;
    const lonPrev2 = st.lonPrev2;
    const lonPrev = st.lonPrev;
    const altPrev2 = st.altPrev2;
    const altPrev = st.altPrev;
    const dtPrev = st.dtPrev;

    const ctxDt =
      layout.dtCtx0 +
      dtBucket(dtPrev, spec.dtLevels) * 2 +
      (st.eDtPrev === 0 ? 0 : 1);
    const eDt = decodeResidual(dec, probs, layout, ctxDt);
    const dtCur = dtPrev + eDt;
    const tCur = st.tPrev + dtCur;

    const spd = speedRegime(
      latPrev - latPrev2,
      lonPrev - lonPrev2,
      dtPrev,
      spec.speedThresholds
    );
    const dchg = layout.coordDtChanged === 2 ? (eDt !== 0 ? 1 : 0) : 0;
    const coordCtxBase =
      (spd * layout.nQ1 + q1(st.eLatPrev, spec.qLevels)) * layout.coordDtChanged;

    const ctxLat = layout.latCtx0 + coordCtxBase + dchg;
    const eLat = decodeResidual(dec, probs, layout, ctxLat);
    const latCur = predictCoord(latPrev2, latPrev, dtPrev, dtCur, coordMode) + eLat;

    const lonCtxBase =
      (spd * layout.nQ1 + q1(st.eLonPrev, spec.qLevels)) * layout.coordDtChanged;
    const ctxLon = spec.lonUsesLatResidual
      ? layout.lonCtx0 + lonCtxBase * layout.nQ1 + q1(eLat, spec.qLevels)
      : layout.lonCtx0 + lonCtxBase + dchg;
    const eLon = decodeResidual(dec, probs, layout, ctxLon);
    const lonCur = predictCoord(lonPrev2, lonPrev, dtPrev, dtCur, coordMode) + eLon;

    const ctxAlt =
      layout.altCtx0 +
      spd * layout.nAltQ +
      altQ(st.eAltPrev, spec.altLevels);
    const eAlt = decodeResidual(dec, probs, layout, ctxAlt);
    const altCur = predictAlt(altPrev2, altPrev, altMode) + eAlt;

    outT[o + j] = tCur;
    outLat[o + j] = latCur;
    outLon[o + j] = lonCur;
    outAlt[o + j] = altCur;

    st.tPrev2 = st.tPrev;
    st.tPrev = tCur;
    st.dtPrev = dtCur;
    st.latPrev2 = latPrev;
    st.latPrev = latCur;
    st.lonPrev2 = lonPrev;
    st.lonPrev = lonCur;
    st.altPrev2 = altPrev;
    st.altPrev = altCur;
    st.eDtPrev = eDt;
    st.eLatPrev = eLat;
    st.eLonPrev = eLon;
    st.eAltPrev = eAlt;
  }
  return st;
}
