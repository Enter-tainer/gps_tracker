// GPSL0 v3 / v1 WASM codec public API.
//
// Backed by Rust `gpsl0-core` compiled to `gpsl0_wasm.wasm`.
// Default writes GPSL0 v3 (version = 2, model_id = 22) and decodes both
// v1 (`version = 1`) and v3 (`version = 2, model_id = 22`) streams.
// Passing `version: 1` (or `modelId` in 1..10) encodes the frozen v1 bitstream.

import { getGpsl0WasmSync, initGpsl0Wasm, type Gpsl0WasmExports } from "./wasmLoader.ts";

export { initGpsl0Wasm };

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
  version?: 1 | 2;
  quantum?: "auto" | number;
  altQuantum?: "auto" | number;
  blockPoints?: number;
  syncBlocks?: number;
  altMode?: 1 | 2;
  coordPredictor?: "naive" | "tn" | "tn-clamped" | "d1";
  modelId?: number;
  stats?: boolean;
};

export type Gpsl0BlockEntry = {
  startTs: number;
  endTs: number;
  pointCount: number;
  byteOffset: number;
  byteLength: number;
  crc32: number;
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
  indexCrc32: number;
  blockIndex: Gpsl0BlockEntry[];
  byteLength: number;
  precisionDeg: number;
};

export type DecodedGpsl0 = {
  t: Int32Array;
  lat: Int32Array;
  lon: Int32Array;
  alt: Int32Array;
  meta: Gpsl0Meta;
};

export const DEFAULT_VERSION = 2;
export const DEFAULT_MODEL_ID = 22;

export type ModelSpec = {
  id: number;
  unarySlots: number;
  mantTreeBits: number;
  speedThresholds: number[];
  qLevels: number;
  altLevels: number;
  lonUsesLatResidual: boolean;
  dtLevels: number;
  coordDtChanged?: boolean;
};

export type ModelLayout = {
  spec: ModelSpec;
  nSlot: number;
  nCtx: number;
};

export const MODELS: Record<number, ModelSpec> = {
  1: { id: 1, unarySlots: 24, mantTreeBits: 0, speedThresholds: [300, 2200, 5500, 12000, 30000], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5 },
  2: { id: 2, unarySlots: 24, mantTreeBits: 3, speedThresholds: [300, 2200], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5 },
  3: { id: 3, unarySlots: 24, mantTreeBits: 4, speedThresholds: [300, 2200], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5 },
  4: { id: 4, unarySlots: 24, mantTreeBits: 5, speedThresholds: [300, 2200], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5 },
  5: { id: 5, unarySlots: 24, mantTreeBits: 4, speedThresholds: [300, 2200, 5500, 12000, 30000], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5 },
  6: { id: 6, unarySlots: 24, mantTreeBits: 4, speedThresholds: [], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5, coordDtChanged: false },
  7: { id: 7, unarySlots: 24, mantTreeBits: 4, speedThresholds: [], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5, coordDtChanged: true },
  8: { id: 8, unarySlots: 24, mantTreeBits: 4, speedThresholds: [300, 2200], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5, coordDtChanged: true },
  9: { id: 9, unarySlots: 24, mantTreeBits: 4, speedThresholds: [], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 6, coordDtChanged: true },
  10: { id: 10, unarySlots: 24, mantTreeBits: 0, speedThresholds: [], qLevels: 8, altLevels: 4, lonUsesLatResidual: false, dtLevels: 5, coordDtChanged: true },
  22: { id: 22, unarySlots: 24, mantTreeBits: 4, speedThresholds: [], qLevels: 6, altLevels: 3, lonUsesLatResidual: true, dtLevels: 5, coordDtChanged: true },
};

export function getLayout(modelId: number): ModelLayout {
  const spec = MODELS[modelId];
  if (!spec) {
    throw new Error(
      `GPSL0: unsupported model_id ${modelId} (known: ${Object.keys(MODELS).join(", ")})`
    );
  }
  if (modelId === 22) {
    // v3 grid layout (coord_quantum > 10): 16 allZero3 + 988 zero + 496*59 mag + 537 sign = 30,805 slots
    // (tracks with coord_quantum <= 10 automatically use the 3,219-slot layout)
    return { spec, nSlot: 59, nCtx: 496 };
  }
  const treeNodes = spec.mantTreeBits === 0 ? 0 : (1 << spec.mantTreeBits) - 1;
  const flatSlots = Math.max(0, spec.unarySlots - 1 - spec.mantTreeBits);
  const nSlot = 1 + spec.unarySlots + treeNodes + flatSlots;
  const nQ1 = 2 * spec.qLevels + 1;
  const nAltQ = 2 * spec.altLevels + 1;
  const nSpeed = spec.speedThresholds.length + 1;
  const dchg = spec.coordDtChanged ? 2 : 1;
  const nCtx =
    spec.dtLevels * 2 +
    nSpeed * nQ1 * dchg +
    (spec.lonUsesLatResidual ? nSpeed * nQ1 * dchg * nQ1 : nSpeed * nQ1 * dchg) +
    nSpeed * nAltQ;
  return { spec, nSlot, nCtx };
}

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

const textDecoder = new TextDecoder();

function readResultError(wasm: Gpsl0WasmExports, resPtr: number): Error {
  const view = new DataView(wasm.memory.buffer);
  const msgLen = view.getUint32(resPtr + 8, true);
  const msgBytes = new Uint8Array(wasm.memory.buffer, resPtr + 12, msgLen);
  return new Error(textDecoder.decode(msgBytes));
}

function parseMetaAndArrays(
  wasm: Gpsl0WasmExports,
  resPtr: number,
  withArrays: boolean
): { meta: Gpsl0Meta; t: Int32Array; lat: Int32Array; lon: Int32Array; alt: Int32Array } {
  const buf = wasm.memory.buffer;
  const view = new DataView(buf);
  const status = view.getUint32(resPtr + 4, true);
  if (status !== 0) {
    throw readResultError(wasm, resPtr);
  }
  const version = view.getUint32(resPtr + 8, true);
  const flagsMode = view.getUint32(resPtr + 12, true);
  const coordQuantum = view.getUint32(resPtr + 16, true);
  const altQuantum = view.getUint32(resPtr + 20, true);
  const nPoints = view.getUint32(resPtr + 24, true);
  const blockPoints = view.getUint32(resPtr + 28, true);
  const syncBlocks = view.getUint32(resPtr + 32, true);
  const nBlocks = view.getUint32(resPtr + 36, true);
  const modelId = view.getUint32(resPtr + 40, true);
  const headerCrc32 = view.getUint32(resPtr + 44, true);
  const indexCrc32 = view.getUint32(resPtr + 48, true);
  const byteLength = view.getUint32(resPtr + 52, true);
  const outPoints = view.getUint32(resPtr + 56, true);

  const blockIndex: Gpsl0BlockEntry[] = new Array(nBlocks);
  let off = resPtr + 60;
  for (let i = 0; i < nBlocks; i++) {
    blockIndex[i] = {
      startTs: view.getUint32(off, true),
      endTs: view.getUint32(off + 4, true),
      pointCount: view.getUint32(off + 8, true),
      byteOffset: view.getUint32(off + 12, true),
      byteLength: view.getUint32(off + 16, true),
      crc32: view.getUint32(off + 20, true),
    };
    off += 24;
  }

  let t: Int32Array;
  let lat: Int32Array;
  let lon: Int32Array;
  let alt: Int32Array;
  if (withArrays && outPoints > 0) {
    t = new Int32Array(buf, off, outPoints).slice();
    off += outPoints * 4;
    lat = new Int32Array(buf, off, outPoints).slice();
    off += outPoints * 4;
    lon = new Int32Array(buf, off, outPoints).slice();
    off += outPoints * 4;
    alt = new Int32Array(buf, off, outPoints).slice();
  } else {
    t = new Int32Array(0);
    lat = new Int32Array(0);
    lon = new Int32Array(0);
    alt = new Int32Array(0);
  }

  const meta: Gpsl0Meta = {
    version,
    tier0: (flagsMode & 1) !== 0,
    hasAlt: (flagsMode & 2) !== 0,
    altDamped: (flagsMode & 4) !== 0,
    coordMode: (flagsMode >>> 8) & 0xff,
    coordQuantum,
    altQuantum,
    nPoints,
    blockPoints,
    syncBlocks,
    nBlocks,
    modelId,
    headerCrc32,
    indexCrc32,
    blockIndex,
    byteLength,
    precisionDeg: coordQuantum / 1e7,
  };
  return { meta, t, lat, lon, alt };
}

function resolveCoordModeCode(mode: string | undefined): number {
  if (mode === undefined) return 255;
  switch (mode) {
    case "tn":
      return 0;
    case "naive":
      return 1;
    case "tn-clamped":
      return 2;
    case "d1":
      return 3;
    default:
      throw new Error(`GPSL0: unknown coordPredictor ${mode}`);
  }
}

export function encodeGpsl0(
  track: Gpsl0Track,
  opts: Gpsl0EncodeOptions = {}
): Uint8Array {
  const n = track.t.length;
  if (track.lat.length !== n || track.lon.length !== n || track.alt.length !== n) {
    throw new Error("GPSL0: t/lat/lon/alt arrays must have equal length");
  }
  for (let i = 0; i < n; i++) {
    const ts = track.t[i];
    if (!Number.isFinite(ts) || ts < 0 || ts > 0xffffffff) {
      throw new Error(`GPSL0: timestamp out of u32 range at point ${i}`);
    }
  }

  let version = opts.version ?? 0;
  if (version === 0 && opts.modelId !== undefined && opts.modelId >= 1 && opts.modelId <= 10) {
    version = 1;
  }
  if (version !== 0 && version !== 1 && version !== 2) {
    throw new Error(`GPSL0: unsupported version ${version}`);
  }
  const modelId = opts.modelId ?? 0;
  if (!Number.isInteger(modelId) || modelId < 0) {
    throw new Error(`GPSL0: bad modelId ${opts.modelId}`);
  }

  let coordQuantum = 0;
  if (opts.quantum !== undefined && opts.quantum !== "auto") {
    coordQuantum = opts.quantum;
    if (
      !Number.isInteger(coordQuantum) ||
      coordQuantum < 1 ||
      coordQuantum > 1e7 ||
      1e7 % coordQuantum !== 0
    ) {
      throw new Error(`GPSL0: bad coord quantum ${coordQuantum}`);
    }
  }

  let altQuantum = 10;
  if (opts.altQuantum === "auto") {
    altQuantum = 0;
  } else if (opts.altQuantum !== undefined) {
    altQuantum = opts.altQuantum;
    if (!Number.isInteger(altQuantum) || altQuantum < 1 || 10 % altQuantum !== 0) {
      throw new Error(`GPSL0: bad alt quantum ${altQuantum}`);
    }
  }

  let blockPoints = 0;
  if (opts.blockPoints !== undefined) {
    blockPoints = opts.blockPoints;
    if (!Number.isInteger(blockPoints) || blockPoints < 2 || blockPoints > 1 << 20) {
      throw new Error(`GPSL0: bad blockPoints ${blockPoints}`);
    }
  }

  const syncBlocks = opts.syncBlocks ?? 0;
  if (!Number.isInteger(syncBlocks) || syncBlocks < 0) {
    throw new Error(`GPSL0: bad syncBlocks ${syncBlocks}`);
  }

  let altMode = 0;
  if (opts.altMode !== undefined) {
    if (opts.altMode !== 1 && opts.altMode !== 2) {
      throw new Error(`GPSL0: bad altMode ${opts.altMode}`);
    }
    altMode = opts.altMode;
  }
  const coordMode = resolveCoordModeCode(opts.coordPredictor);

  const wasm = getGpsl0WasmSync();
  const inputByteLen = n * 16;
  const inPtr = inputByteLen > 0 ? wasm.gpsl0_alloc(inputByteLen) : 0;
  let resPtr = 0;
  try {
    if (n > 0) {
      const mem = wasm.memory.buffer;
      const tBuf = new Int32Array(mem, inPtr, n);
      const latBuf = new Int32Array(mem, inPtr + n * 4, n);
      const lonBuf = new Int32Array(mem, inPtr + n * 8, n);
      const altBuf = new Int32Array(mem, inPtr + n * 12, n);
      if (track.t instanceof Int32Array) {
        tBuf.set(track.t);
      } else {
        for (let i = 0; i < n; i++) tBuf[i] = track.t[i] | 0;
      }
      if (track.lat instanceof Int32Array) {
        latBuf.set(track.lat);
      } else {
        for (let i = 0; i < n; i++) latBuf[i] = track.lat[i] | 0;
      }
      if (track.lon instanceof Int32Array) {
        lonBuf.set(track.lon);
      } else {
        for (let i = 0; i < n; i++) lonBuf[i] = track.lon[i] | 0;
      }
      if (track.alt instanceof Int32Array) {
        altBuf.set(track.alt);
      } else {
        for (let i = 0; i < n; i++) altBuf[i] = track.alt[i] | 0;
      }
    }

    resPtr = wasm.gpsl0_encode(
      inPtr,
      inPtr + n * 4,
      inPtr + n * 8,
      inPtr + n * 12,
      n >>> 0,
      version >>> 0,
      modelId >>> 0,
      coordQuantum >>> 0,
      altQuantum >>> 0,
      blockPoints >>> 0,
      syncBlocks >>> 0,
      altMode >>> 0,
      coordMode >>> 0
    );
    const view = new DataView(wasm.memory.buffer);
    const status = view.getUint32(resPtr + 4, true);
    if (status !== 0) {
      throw readResultError(wasm, resPtr);
    }
    const outLen = view.getUint32(resPtr + 8, true);
    return new Uint8Array(wasm.memory.buffer, resPtr + 12, outLen).slice();
  } finally {
    if (resPtr !== 0) wasm.gpsl0_free_result(resPtr);
    if (inPtr !== 0) wasm.gpsl0_dealloc(inPtr, inputByteLen);
  }
}

export function decodeGpsl0(bytes: Uint8Array): DecodedGpsl0 {
  const wasm = getGpsl0WasmSync();
  const len = bytes.length;
  const inPtr = len > 0 ? wasm.gpsl0_alloc(len) : 0;
  let resPtr = 0;
  try {
    if (len > 0) {
      new Uint8Array(wasm.memory.buffer, inPtr, len).set(bytes);
    }
    resPtr = wasm.gpsl0_decode(inPtr, len >>> 0);
    return parseMetaAndArrays(wasm, resPtr, true);
  } finally {
    if (resPtr !== 0) wasm.gpsl0_free_result(resPtr);
    if (inPtr !== 0) wasm.gpsl0_dealloc(inPtr, len);
  }
}

export function decodeGpsl0Window(
  bytes: Uint8Array,
  startPoint: number,
  len: number
): DecodedGpsl0 {
  if (!Number.isInteger(startPoint) || !Number.isInteger(len) || startPoint < 0 || len < 1) {
    throw new Error("GPSL0: bad window arguments");
  }
  const wasm = getGpsl0WasmSync();
  const byteLen = bytes.length;
  const inPtr = byteLen > 0 ? wasm.gpsl0_alloc(byteLen) : 0;
  let resPtr = 0;
  try {
    if (byteLen > 0) {
      new Uint8Array(wasm.memory.buffer, inPtr, byteLen).set(bytes);
    }
    resPtr = wasm.gpsl0_decode_window(inPtr, byteLen >>> 0, startPoint >>> 0, len >>> 0);
    return parseMetaAndArrays(wasm, resPtr, true);
  } finally {
    if (resPtr !== 0) wasm.gpsl0_free_result(resPtr);
    if (inPtr !== 0) wasm.gpsl0_dealloc(inPtr, byteLen);
  }
}

export function inspectGpsl0Header(bytes: Uint8Array): Gpsl0Meta {
  const wasm = getGpsl0WasmSync();
  const len = bytes.length;
  const inPtr = len > 0 ? wasm.gpsl0_alloc(len) : 0;
  let resPtr = 0;
  try {
    if (len > 0) {
      new Uint8Array(wasm.memory.buffer, inPtr, len).set(bytes);
    }
    resPtr = wasm.gpsl0_inspect_header(inPtr, len >>> 0);
    return parseMetaAndArrays(wasm, resPtr, false).meta;
  } finally {
    if (resPtr !== 0) wasm.gpsl0_free_result(resPtr);
    if (inPtr !== 0) wasm.gpsl0_dealloc(inPtr, len);
  }
}

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
    if (!Number.isFinite(p.timestamp) || p.timestamp < 0 || p.timestamp > 0xffffffff) {
      throw new Error(`GPSL0: timestamp out of u32 range at point ${i}`);
    }
    t[i] = p.timestamp | 0;
    lat[i] = p.latitude_scaled_1e7;
    lon[i] = p.longitude_scaled_1e7;
    alt[i] = p.altitude_m_scaled_1e1;
  }
  return encodeGpsl0({ t, lat, lon, alt }, opts);
}

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
