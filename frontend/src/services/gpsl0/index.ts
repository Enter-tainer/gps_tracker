// GPSL0 v1 container + codec public API.
//
// A GPSL0 file holds exactly one track (point sequence):
//
//   header        48 B   (see container.ts)
//   block index   nBlocks * 24 B
//   block payloads (variable length, range-coded)
//
// Sync windows: block 0 and every `syncBlocks`-th block start a fresh
// probability table and carry an absolute 32 B seed; blocks in between are
// continuations (warm start) holding only the range-coded stream.
// `syncBlocks = 0` means "one sync window per file" (best compression, random
// access replays from the start).
//
// Quantization: the encoder stores integers at a `quantum` of 1e-7 degree
// (coord) and 0.1 m (alt). `quantum = "auto"` (default) picks the coarsest
// quantum that still reproduces every input value exactly, which is
// **lossless at the data's natural grid** — the GPZ V1 tracks in this corpus
// are all multiples of 100 units (1.1 m), so they round-trip bit-exactly while
// coding 1/100 the dynamic range. Decoded values are always returned in
// GPZ units (lat/lon *1e-7 deg, alt *0.1 m).
//
// Spec: docs/gpsl0_format.md

import {
  crc32,
  HEADER_SIZE,
  INDEX_ENTRY_SIZE,
  readBlockIndex,
  readHeader,
  writeHeader,
  type Gpsl0BlockEntry,
  type Gpsl0Header,
} from "./container.ts";
import {
  createProbTable,
  decodeBlock,
  DEFAULT_MODEL_ID,
  encodeBlock,
  getLayout,
  MODEL_STATS,
  readSeed,
  SEED_BYTES,
  type BlockState,
  type ModelLayout,
} from "./model.ts";
import { RangeDecoder, RangeEncoder } from "./rangecoder.ts";
import { COORD_NAIVE, COORD_TN, COORD_TN_CLAMPED } from "./model.ts";

/** Structural equivalent of the frontend `GpsPoint` (kept local so the codec
 *  has no dependency on app-level type modules). */
export type GpsPointLike = {
  timestamp: number;
  latitude_scaled_1e7: number;
  longitude_scaled_1e7: number;
  altitude_m_scaled_1e1: number;
};

export type Gpsl0Track = {
  t: ArrayLike<number>;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  alt: ArrayLike<number>;
};

export type Gpsl0EncodeOptions = {
  /**
   * Coordinate quantum in units of 1e-7 degree (stored = round(value / quantum)).
   * `"auto"` (default) = gcd of all lat/lon values => always lossless.
   * Common explicit values: 1 (1e7 lossless), 10 (1e6 = 11 cm), 100 (1e5 = 1.1 m).
   */
  quantum?: "auto" | number;
  /**
   * Altitude quantum in units of 0.1 m. `"auto"` (default) = gcd of altitudes
   * capped at 10 (1 m). Common explicit values: 1 (0.1 m), 10 (1 m).
   */
  altQuantum?: "auto" | number;
  /** Points per seek block (default 4096). */
  blockPoints?: number;
  /** Reset probability tables every N blocks; 0 = never (default). */
  syncBlocks?: number;
  /** Altitude predictor: 1 = first difference (default), 2 = damped second difference. */
  altMode?: 1 | 2;
  /**
   * Coordinate predictor: "tn" = time-normalized d2, "naive" = 2x[i-1]-x[i-2],
   * "tn-clamped" = time-normalized with the extrapolation ratio capped at 2x.
   * Default is "tn-clamped" (measured best on the real corpus).
   */
  coordPredictor?: "naive" | "tn" | "tn-clamped";
  /** Model variant to encode with (default = DEFAULT_MODEL_ID). */
  modelId?: number;
  /** Collect per-channel self-information into MODEL_STATS (bench only). */
  stats?: boolean;
};

export type Gpsl0Meta = {
  version: number;
  tier0: boolean;
  hasAlt: boolean;
  altDamped: boolean;
  coordMode: number;
  coordQuantum: number;
  altQuantum: number;
  nPoints: number;
  blockPoints: number;
  syncBlocks: number;
  nBlocks: number;
  modelId: number;
  headerCrc32: number;
  /** CRC-32 over the whole block index (in header bytes 44..47). */
  indexCrc32: number;
  blockIndex: Gpsl0BlockEntry[];
  /** Derived: total file size in bytes. */
  byteLength: number;
  /** Derived: stored coordinate precision in degrees (coordQuantum / 1e7). */
  precisionDeg: number;
};

export type DecodedGpsl0 = {
  /** Timestamps, exact. */
  t: Int32Array;
  /** Latitude in 1e-7 degree units (exact w.r.t. the source when quantum="auto"). */
  lat: Int32Array;
  lon: Int32Array;
  /** Altitude in 0.1 m units. */
  alt: Int32Array;
  meta: Gpsl0Meta;
};

function metaFromHeader(
  header: Gpsl0Header,
  blockIndex: Gpsl0BlockEntry[],
  byteLength: number
): Gpsl0Meta {
  return {
    version: header.version,
    tier0: header.flags.tier0,
    hasAlt: header.flags.hasAlt,
    altDamped: header.flags.altDamped,
    coordMode: header.flags.coordMode,
    coordQuantum: header.coordQuantum,
    altQuantum: header.altQuantum,
    nPoints: header.nPoints,
    blockPoints: header.blockPoints,
    syncBlocks: header.syncBlocks,
    nBlocks: header.nBlocks,
    modelId: header.modelId,
    headerCrc32: header.headerCrc32,
    indexCrc32: header.indexCrc32,
    blockIndex,
    byteLength,
    precisionDeg: header.coordQuantum / 1e7,
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Largest quantum (dividing `cap`) that is a divisor of every value.
 * Values of 0 contribute nothing, so an all-zero array returns `cap`.
 */
export function inferQuantum(
  values: ArrayLike<number>,
  cap: number,
  length = values.length
): number {
  let g = 0;
  for (let i = 0; i < length; i++) {
    g = gcd(g, values[i]);
    if (g === 1) return 1;
  }
  if (g === 0) return cap;
  return gcd(g, cap) || 1;
}

function quantizeExact(
  src: ArrayLike<number>,
  length: number,
  quantum: number
): Int32Array {
  const out = new Int32Array(length);
  if (quantum === 1) {
    for (let i = 0; i < length; i++) out[i] = src[i] | 0;
    return out;
  }
  for (let i = 0; i < length; i++) {
    const q = src[i] / quantum;
    const r = Math.round(q);
    if (r * quantum !== src[i]) {
      throw new Error(
        `GPSL0: value ${src[i]} is not a multiple of quantum ${quantum}`
      );
    }
    out[i] = r | 0;
  }
  return out;
}

function quantizeLossy(
  src: ArrayLike<number>,
  length: number,
  quantum: number
): Int32Array {
  const out = new Int32Array(length);
  if (quantum === 1) {
    for (let i = 0; i < length; i++) out[i] = src[i] | 0;
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.round(src[i] / quantum) | 0;
  return out;
}

export function isSyncBlock(b: number, syncBlocks: number): boolean {
  return b === 0 || (syncBlocks > 0 && b % syncBlocks === 0);
}

function resolveCoordMode(mode: string): number {
  switch (mode) {
    case "naive":
      return COORD_NAIVE;
    case "tn":
      return COORD_TN;
    case "tn-clamped":
      return COORD_TN_CLAMPED;
    default:
      throw new Error(`GPSL0: unknown coordPredictor ${mode}`);
  }
}

export function encodeGpsl0(
  track: Gpsl0Track,
  opts: Gpsl0EncodeOptions = {}
): Uint8Array {
  const n = track.t.length;
  if (
    track.lat.length !== n ||
    track.lon.length !== n ||
    track.alt.length !== n
  ) {
    throw new Error("GPSL0: t/lat/lon/alt arrays must have equal length");
  }
  for (let i = 0; i < n; i++) {
    const ts = track.t[i];
    if (!Number.isFinite(ts) || ts < 0 || ts > 0xffffffff) {
      throw new Error(`GPSL0: timestamp out of u32 range at point ${i}`);
    }
  }

  // ---- quantization -----------------------------------------------------
  // Coordinates: `"auto"` is exact (gcd divides every value, so it is
  // lossless). An explicit quantum means "store at this precision" and rounds.
  const autoQuant = opts.quantum === undefined || opts.quantum === "auto";
  let coordQuantum: number;
  if (autoQuant) {
    coordQuantum = Math.max(
      1,
      gcd(inferQuantum(track.lat, 1e7), inferQuantum(track.lon, 1e7))
    );
  } else {
    coordQuantum = opts.quantum as number;
  }
  if (
    !Number.isInteger(coordQuantum) ||
    coordQuantum < 1 ||
    coordQuantum > 1e7 ||
    1e7 % coordQuantum !== 0
  ) {
    throw new Error(`GPSL0: bad coord quantum ${coordQuantum}`);
  }
  // Altitude defaults to a 1 m grid: GNSS vertical error is metres, so this is
  // far below the noise floor and saves ~1.8 bits/pt over 0.1 m. Pass
  // `altQuantum: "auto"` (or 1) for an exact round-trip.
  const autoAlt = opts.altQuantum === "auto";
  let altQuantum: number;
  if (autoAlt) {
    altQuantum = Math.max(1, inferQuantum(track.alt, 10));
  } else {
    altQuantum = (opts.altQuantum as number | undefined) ?? 10;
  }
  if (!Number.isInteger(altQuantum) || altQuantum < 1 || 10 % altQuantum !== 0) {
    throw new Error(`GPSL0: bad alt quantum ${altQuantum}`);
  }

  const blockPoints = opts.blockPoints ?? 16384;
  if (
    !Number.isInteger(blockPoints) ||
    blockPoints < 2 ||
    blockPoints > 1 << 20
  ) {
    throw new Error(`GPSL0: bad blockPoints ${blockPoints}`);
  }
  const altMode = opts.altMode ?? 1;
  const coordMode = resolveCoordMode(opts.coordPredictor ?? "tn-clamped");
  const layout = getLayout(opts.modelId ?? DEFAULT_MODEL_ID);

  const latQ = autoQuant
    ? quantizeExact(track.lat, n, coordQuantum)
    : quantizeLossy(track.lat, n, coordQuantum);
  const lonQ = autoQuant
    ? quantizeExact(track.lon, n, coordQuantum)
    : quantizeLossy(track.lon, n, coordQuantum);
  const altQ = autoAlt
    ? quantizeExact(track.alt, n, altQuantum)
    : quantizeLossy(track.alt, n, altQuantum);
  const tQ = quantizeExact(track.t, n, 1);

  const nBlocks = n === 0 ? 0 : Math.ceil(n / blockPoints);
  let syncBlocks = opts.syncBlocks ?? 0;
  if (!Number.isInteger(syncBlocks) || syncBlocks < 0) {
    throw new Error(`GPSL0: bad syncBlocks ${syncBlocks}`);
  }
  if (syncBlocks > 0 && nBlocks > 0 && syncBlocks > nBlocks) {
    syncBlocks = nBlocks; // one sync window per file: identical bytes, honest header
  }

  const payloads: Uint8Array[] = [];
  const entries: Gpsl0BlockEntry[] = [];
  let probs = createProbTable(layout);
  let state: BlockState | null = null;
  if (opts.stats) {
    MODEL_STATS.enabled = true;
    MODEL_STATS.total.points += n;
  }

  for (let b = 0; b < nBlocks; b++) {
    const start = b * blockPoints;
    const count = Math.min(blockPoints, n - start);
    const sync = isSyncBlock(b, syncBlocks);
    if (sync) {
      if (b > 0) probs = createProbTable(layout);
      state = null;
    }
    const seed = sync ? new Uint8Array(SEED_BYTES) : null;
    const enc = new RangeEncoder();
    state = encodeBlock(
      enc,
      probs,
      {
        t: tQ,
        lat: latQ,
        lon: lonQ,
        alt: altQ,
        start,
        count,
        altMode,
        coordMode,
        layout,
        seedOut: seed,
        carried: state,
        stats: opts.stats === true,
      },
      layout
    );
    const coded = enc.finish();
    const seedLen = seed === null ? 0 : SEED_BYTES;
    const payload = new Uint8Array(seedLen + coded.length);
    if (seed !== null) payload.set(seed, 0);
    payload.set(coded, seedLen);
    payloads.push(payload);
    entries.push({
      startTs: tQ[start],
      endTs: tQ[start + count - 1],
      pointCount: count,
      byteOffset: 0,
      byteLength: payload.length,
      crc32: crc32(payload),
    });
  }

  let size = HEADER_SIZE + entries.length * INDEX_ENTRY_SIZE;
  for (const p of payloads) size += p.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  let off = HEADER_SIZE + entries.length * INDEX_ENTRY_SIZE;
  for (let i = 0; i < entries.length; i++) {
    entries[i].byteOffset = off;
    off += payloads[i].length;
  }

  writeHeader(out, {
    version: 1,
    flags: {
      tier0: coordQuantum === 1,
      hasAlt: true,
      altDamped: altMode === 2,
      coordMode,
    },
    coordQuantum,
    altQuantum,
    nPoints: n,
    blockPoints,
    syncBlocks,
    nBlocks,
    modelId: layout.spec.id,
    headerCrc32: 0,
    indexCrc32: 0,
  });

  let indexOff = HEADER_SIZE;
  for (const e of entries) {
    view.setUint32(indexOff, e.startTs >>> 0, true);
    view.setUint32(indexOff + 4, e.endTs >>> 0, true);
    view.setUint32(indexOff + 8, e.pointCount, true);
    view.setUint32(indexOff + 12, e.byteOffset, true);
    view.setUint32(indexOff + 16, e.byteLength, true);
    view.setUint32(indexOff + 20, e.crc32, true);
    indexOff += INDEX_ENTRY_SIZE;
  }
  for (let i = 0; i < payloads.length; i++) {
    out.set(payloads[i], entries[i].byteOffset);
  }
  // The block index gets its own CRC (stored in header bytes 44..47) so that
  // tampering with start_ts/end_ts/offsets is detected instead of silently
  // yielding wrong data.
  view.setUint32(
    44,
    crc32(out, HEADER_SIZE, HEADER_SIZE + entries.length * INDEX_ENTRY_SIZE),
    true
  );
  if (opts.stats) {
    MODEL_STATS.overheadBytes += HEADER_SIZE + entries.length * INDEX_ENTRY_SIZE;
  }
  return out;
}

type DecodeTarget = {
  t: Int32Array;
  lat: Int32Array;
  lon: Int32Array;
  alt: Int32Array;
  offset: number;
};

function decodeOneBlock(
  payload: Uint8Array,
  pointCount: number,
  altMode: number,
  coordMode: number,
  layout: ModelLayout,
  probs: Uint16Array,
  out: DecodeTarget,
  sync: boolean,
  carried: BlockState | null
): BlockState {
  let seed = null;
  let rcOff = 0;
  if (sync) {
    if (payload.length < SEED_BYTES + 5) {
      throw new Error(`GPSL0: sync block payload too short (${payload.length} B)`);
    }
    seed = readSeed(payload, 0);
    rcOff = SEED_BYTES;
  } else if (payload.length < 5) {
    throw new Error(`GPSL0: block payload too short (${payload.length} B)`);
  }
  const dec = new RangeDecoder(payload.subarray(rcOff));
  return decodeBlock({
    dec,
    seed,
    carried,
    count: pointCount,
    altMode,
    coordMode,
    layout,
    probs,
    outT: out.t,
    outLat: out.lat,
    outLon: out.lon,
    outAlt: out.alt,
    outOffset: out.offset,
  });
}

function dequantizeInPlace(arr: Int32Array, quantum: number): void {
  if (quantum === 1) return;
  for (let i = 0; i < arr.length; i++) arr[i] *= quantum;
}

/** Decode an entire GPSL0 file. */
export function decodeGpsl0(bytes: Uint8Array): DecodedGpsl0 {
  const header = readHeader(bytes);
  const layout = getLayout(header.modelId);
  const blockIndex = readBlockIndex(bytes, header);
  const n = header.nPoints;
  const t = new Int32Array(n);
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  const alt = new Int32Array(n);
  const meta = metaFromHeader(header, blockIndex, bytes.length);
  if (n === 0) {
    return { t, lat, lon, alt, meta };
  }
  const altMode = header.flags.altDamped ? 2 : 1;
  const coordMode = header.flags.coordMode;
  let probs = createProbTable(layout);
  let state: BlockState | null = null;
  let pointOff = 0;
  for (let b = 0; b < blockIndex.length; b++) {
    const entry = blockIndex[b];
    const sync = isSyncBlock(b, header.syncBlocks);
    if (sync) {
      if (b > 0) probs = createProbTable(layout);
      state = null;
    }
    const payload = bytes.subarray(
      entry.byteOffset,
      entry.byteOffset + entry.byteLength
    );
    if (crc32(payload) !== entry.crc32) {
      throw new Error(`GPSL0: block ${b} payload crc mismatch`);
    }
    state = decodeOneBlock(
      payload,
      entry.pointCount,
      altMode,
      coordMode,
      layout,
      probs,
      { t, lat, lon, alt, offset: pointOff },
      sync,
      state
    );
    pointOff += entry.pointCount;
  }

  dequantizeInPlace(lat, header.coordQuantum);
  dequantizeInPlace(lon, header.coordQuantum);
  dequantizeInPlace(alt, header.altQuantum);
  return { t, lat, lon, alt, meta };
}

/**
 * Decode only `[startPoint, startPoint + len)` points of a file.
 * The stream is replayed from the nearest sync block (with `syncBlocks = 0`,
 * the whole file is one sync window).
 */
export function decodeGpsl0Window(
  bytes: Uint8Array,
  startPoint: number,
  len: number
): DecodedGpsl0 {
  const header = readHeader(bytes);
  const layout = getLayout(header.modelId);
  const blockIndex = readBlockIndex(bytes, header);
  if (!Number.isInteger(startPoint) || !Number.isInteger(len) || len < 1) {
    throw new Error("GPSL0: bad window arguments");
  }
  if (startPoint < 0 || startPoint + len > header.nPoints) {
    throw new Error(
      `GPSL0: window [${startPoint}, ${startPoint + len}) outside 0..${header.nPoints}`
    );
  }
  const n = header.nPoints;
  const tAll = new Int32Array(n);
  const latAll = new Int32Array(n);
  const lonAll = new Int32Array(n);
  const altAll = new Int32Array(n);
  const altMode = header.flags.altDamped ? 2 : 1;
  const coordMode = header.flags.coordMode;

  let firstBlock = 0;
  let acc = 0;
  while (
    firstBlock < blockIndex.length &&
    acc + blockIndex[firstBlock].pointCount <= startPoint
  ) {
    acc += blockIndex[firstBlock].pointCount;
    firstBlock++;
  }
  const syncStartBlock =
    header.syncBlocks > 0
      ? Math.floor(firstBlock / header.syncBlocks) * header.syncBlocks
      : 0;

  let probs = createProbTable(layout);
  let state: BlockState | null = null;
  let pointOff = 0;
  for (let b = 0; b < blockIndex.length; b++) {
    const entry = blockIndex[b];
    if (b < syncStartBlock) {
      pointOff += entry.pointCount;
      continue;
    }
    const sync = isSyncBlock(b, header.syncBlocks);
    if (sync) {
      // Replay origin or a later sync boundary: both restart the model.
      probs = createProbTable(layout);
      state = null;
    }
    const payload = bytes.subarray(
      entry.byteOffset,
      entry.byteOffset + entry.byteLength
    );
    if (crc32(payload) !== entry.crc32) {
      throw new Error(`GPSL0: block ${b} payload crc mismatch`);
    }
    state = decodeOneBlock(
      payload,
      entry.pointCount,
      altMode,
      coordMode,
      layout,
      probs,
      { t: tAll, lat: latAll, lon: lonAll, alt: altAll, offset: pointOff },
      sync,
      state
    );
    pointOff += entry.pointCount;
  }

  const t = tAll.slice(startPoint, startPoint + len);
  const lat = latAll.slice(startPoint, startPoint + len);
  const lon = lonAll.slice(startPoint, startPoint + len);
  const alt = altAll.slice(startPoint, startPoint + len);
  dequantizeInPlace(lat, header.coordQuantum);
  dequantizeInPlace(lon, header.coordQuantum);
  dequantizeInPlace(alt, header.altQuantum);
  return {
    t,
    lat,
    lon,
    alt,
    meta: metaFromHeader(header, blockIndex, bytes.length),
  };
}

/** Header/index only, no payload decoding. */
export function inspectGpsl0Header(bytes: Uint8Array): Gpsl0Meta {
  const header = readHeader(bytes);
  getLayout(header.modelId); // validate model_id
  return metaFromHeader(header, readBlockIndex(bytes, header), bytes.length);
}

/** Convenience wrapper: encode `GpsPoint[]` (as used across the frontend). */
export function encodeGpsl0Points(
  points: GpsPointLike[],
  opts: Gpsl0EncodeOptions = {}
): Uint8Array {
  const n = points.length;
  const t = new Int32Array(n);
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  const alt = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    t[i] = p.timestamp | 0;
    lat[i] = p.latitude_scaled_1e7;
    lon[i] = p.longitude_scaled_1e7;
    alt[i] = p.altitude_m_scaled_1e1;
  }
  return encodeGpsl0({ t, lat, lon, alt }, opts);
}

/** Convenience wrapper: decode into `GpsPoint[]`. */
export function decodeGpsl0ToPoints(bytes: Uint8Array): GpsPointLike[] {
  const d = decodeGpsl0(bytes);
  const out: GpsPointLike[] = new Array(d.t.length);
  for (let i = 0; i < d.t.length; i++) {
    out[i] = {
      timestamp: d.t[i] >>> 0,
      latitude_scaled_1e7: d.lat[i],
      longitude_scaled_1e7: d.lon[i],
      altitude_m_scaled_1e1: d.alt[i],
    };
  }
  return out;
}

export { DEFAULT_MODEL_ID, MODEL_STATS };
export { MODELS, getLayout } from "./model.ts";
