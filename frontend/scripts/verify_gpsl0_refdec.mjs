// GPSL0 v1 独立参考解码器（cross-implementation gate，ECGL0 §7.6 门槛）。
//
// **只依赖 `docs/gpsl0_format.md` v1 规范文本**，不 import、不阅读
// `frontend/src/services/gpsl0/**` 的任何实现代码；只解码、不编码。
// 输出与参考 codec 相同的 GPZ 单位：t = unix 秒（Int32），lat/lon = 1e-7 deg（Int32），
// alt = 0.1 m（Int32）。若两实现不一致，说明格式文档与实现存在偏差（或本文档误解）。
//
// 用法（由 verify_gpsl0.mjs --refdec 调用）：
//   import { decodeGpsl0Ref, decodeGpsl0WindowRef } from "./verify_gpsl0_refdec.mjs";
//   const { t, lat, lon, alt, meta } = decodeGpsl0Ref(bytes);
//
// 规范要点速查：
//  - Header 48B；Block Index 24B/块；payload = [sync seed 32B]? + range-coded stream。
//  - coord_quantum 单位 = 多少 1e-7 deg；alt_quantum 单位 = 多少 0.1 m。
//  - 预测器：dt 用上一拍 dt；lat/lon 默认 naive_d2（flags.bit3=1），否则时间归一化；
//    alt 默认衰减二阶（flags.bit2=1），否则一阶。
//  - 上下文 87 个、槽 59 个；mantissa 低位优先前缀树（bit0=符号）。
//  - Range coder：LZMA 风格 11-bit 概率、MOVE_BITS=5、TOP=1<<24，5 字节 flush。

export class Gpsl0RefError extends Error {
  constructor(code, message) {
    super(`GPSL0-ref: ${code}: ${message}`);
    this.name = "Gpsl0RefError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 常量（docs/gpsl0_format.md §7）
// ---------------------------------------------------------------------------
const HEADER_SIZE = 48;
const INDEX_ENTRY = 24;
const N_CTX = 87;
const N_SLOT = 59;
const UNARY_SLOTS = 24; // 槽 1..24
const TREE_SLOT0 = 25; // 低位树 15 个节点：25 + (2^k - 1) + prefix, k=0..3
const MANT_TREE_BITS = 4;
const FLAT_SLOT0 = 40; // 槽 40 + (k-4), k=4..m-1
const PROB_BITS = 11;
const PROB_SCALE = 1 << PROB_BITS; // 2048
const PROB_INIT = PROB_SCALE >> 1; // 1024
const MOVE_BITS = 5;
const TOP = 1 << 24;
const FLAG_TIER0 = 1 << 0;
const FLAG_HAS_ALT = 1 << 1;
const FLAG_ALT_DAMPED = 1 << 2;
const COORD_MODE_SHIFT = 3; // flags.bit3..4 = coord_mode（0=tn, 1=naive, 2=tn-clamped）
const COORD_MODE_MASK = 0x3 << COORD_MODE_SHIFT;
const FLAGS_DEFINED = 0x1f; // bit0..4 已定义，bit5..15 必须为 0
const SUPPORTED_MODELS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

// ---------------------------------------------------------------------------
// CRC-32/IEEE（多项式 0xEDB88320），表驱动
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Ref(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 整数工具（§2/§4）
// ---------------------------------------------------------------------------
function u16le(b, off) {
  return b[off] | (b[off + 1] << 8);
}
function u32le(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function i32le(b, off) {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24);
}

export function zigzagRef(e) {
  return e >= 0 ? e * 2 : -e * 2 - 1;
}
export function unzigzagRef(u) {
  return (u >>> 1) ^ -(u & 1);
}

/** roundDiv(a,b) = b>0 时带符号 half-away-from-zero 整数除法（§3.2）。 */
export function roundDivRef(a, b) {
  if (b <= 0) throw new Gpsl0RefError("BadArg", `roundDiv b=${b}`);
  return a >= 0 ? Math.trunc((a + (b >> 1)) / b) : -Math.trunc((-a + (b >> 1)) / b);
}

/** q1(e, levels=8)：17 个有符号桶（levels=4 时 9 个），§4。 */
export function q1Ref(e, levels = 8) {
  if (e === 0) return 0;
  const a = Math.abs(e);
  let b = 31 - Math.clz32(a); // floor(log2 a)
  if (b > levels - 1) b = levels - 1;
  return 1 + 2 * b + (e < 0 ? 1 : 0);
}

/** dtBucket(dt)，§4。 */
export function dtBucketRef(dt) {
  if (dt <= 0) return 0;
  if (dt === 1) return 1;
  if (dt === 2) return 2;
  if (dt <= 5) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Range Coder 解码器（§5.3 规范级镜像）
// ---------------------------------------------------------------------------
class RangeDecoder {
  /**
   * @param {Uint8Array} bytes 整个文件
   * @param {number} start payload 起始绝对偏移
   * @param {number} end payload 结束绝对偏移（不含）
   */
  constructor(bytes, start, end) {
    if (end - start < 5) throw new Gpsl0RefError("Truncated", `payload ${end - start}B < 5B`);
    this.bytes = bytes;
    this.pos = start + 5; // 跳过 5 字节初始化
    this.end = end;
    // 跳过第 1 字节（规范：恒 0x00），code = 后 4 字节大端
    this.code = ((bytes[start + 1] << 24) | (bytes[start + 2] << 16) | (bytes[start + 3] << 8) | bytes[start + 4]) >>> 0;
    this.range = 0xffffffff;
    this.probs = new Uint16Array(N_CTX * N_SLOT).fill(PROB_INIT);
  }

  nextByte() {
    if (this.pos >= this.end) throw new Gpsl0RefError("Truncated", "range coder read past payload end");
    return this.bytes[this.pos++];
  }

  renorm() {
    while (this.range < TOP) {
      this.code = ((this.code << 8) | this.nextByte()) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }

  /** 解码一个自适应 bit；probs 索引 = ctx*N_SLOT + slot。 */
  decodeBit(ctx, slot) {
    if (ctx < 0 || ctx >= N_CTX) throw new Gpsl0RefError("Corrupt", `ctx ${ctx}`);
    if (slot < 0 || slot >= N_SLOT) throw new Gpsl0RefError("Corrupt", `slot ${slot}`);
    const idx = ctx * N_SLOT + slot;
    const p = this.probs[idx];
    const bound = ((this.range >>> PROB_BITS) * p) >>> 0;
    let bit;
    if (this.code < bound) {
      this.range = bound;
      this.probs[idx] = p + ((PROB_SCALE - p) >> MOVE_BITS);
      bit = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      this.probs[idx] = p - (p >> MOVE_BITS);
      bit = 1;
    }
    this.renorm();
    return bit;
  }

  /** 直通位（escape 时用）。 */
  decodeDirect() {
    this.range = (this.range >>> 1) >>> 0;
    const bit = this.code >= this.range ? 1 : 0;
    if (bit) this.code = (this.code - this.range) >>> 0;
    this.renorm();
    return bit;
  }
}

/**
 * 解出一个通道残差 e（§5.2：zero flag → unary 阶数 → 低位优先 mantissa）。
 */
function decodeResidual(rd, ctx) {
  if (rd.decodeBit(ctx, 0) === 0) return 0; // u == 0
  let m = 0;
  while (m < UNARY_SLOTS) {
    if (rd.decodeBit(ctx, 1 + m) === 0) break;
    m++;
  }
  if (m >= UNARY_SLOTS) {
    // escape：24 个连续 1，随后 32 个直通位（MSB→LSB）
    let u = 0;
    for (let k = 0; k < 32; k++) u = ((u << 1) | rd.decodeDirect()) >>> 0;
    return unzigzagRef(u);
  }
  let u = (1 << m) >>> 0;
  for (let k = 0; k < m; k++) {
    let slot;
    if (k < MANT_TREE_BITS) {
      slot = TREE_SLOT0 + ((1 << k) - 1) + (u & ((1 << k) - 1));
    } else {
      slot = FLAT_SLOT0 + (k - MANT_TREE_BITS);
    }
    const bit = rd.decodeBit(ctx, slot);
    u = (u | (bit << k)) >>> 0;
  }
  return unzigzagRef(u);
}

// ---------------------------------------------------------------------------
// Header / Index 解析（§1、§8）
// ---------------------------------------------------------------------------
const MAGIC = new Uint8Array([0x47, 0x50, 0x53, 0x4c, 0x30, 0, 0, 0]); // "GPSL0\0\0\0"

export function parseHeaderRef(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Gpsl0RefError("BadInput", "expected Uint8Array");
  if (bytes.length < HEADER_SIZE) throw new Gpsl0RefError("BadMagic", `length ${bytes.length} < 48`);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Gpsl0RefError("BadMagic", `magic byte ${i}`);
  }
  const version = u16le(bytes, 8);
  if (version !== 1) throw new Gpsl0RefError("UnsupportedVersion", `version ${version}`);
  const flags = u16le(bytes, 10);
  if ((flags & ~FLAGS_DEFINED) !== 0) throw new Gpsl0RefError("Corrupt", `undefined flag bits 0x${flags.toString(16)}`);
  const coordMode = (flags & COORD_MODE_MASK) >> COORD_MODE_SHIFT;
  if (coordMode === 3) throw new Gpsl0RefError("Corrupt", `coord_mode 3 is reserved`);
  const altDamped = (flags & FLAG_ALT_DAMPED) !== 0;
  const coordQuantum = u32le(bytes, 12);
  if (coordQuantum < 1 || coordQuantum > 1e7 || 1e7 % coordQuantum !== 0) {
    throw new Gpsl0RefError("Corrupt", `coord_quantum ${coordQuantum}`);
  }
  const altQuantum = u32le(bytes, 16);
  if (![1, 2, 5, 10].includes(altQuantum)) throw new Gpsl0RefError("Corrupt", `alt_quantum ${altQuantum}`);
  const nPoints = u32le(bytes, 20);
  if (nPoints > 2 ** 30) throw new Gpsl0RefError("Corrupt", `n_points ${nPoints}`);
  const blockPoints = u32le(bytes, 24);
  if (blockPoints < 1 || blockPoints > 2 ** 20) throw new Gpsl0RefError("BadIndex", `block_points ${blockPoints}`);
  const syncBlocks = u32le(bytes, 28);
  const nBlocks = u32le(bytes, 32);
  const expectBlocks = nPoints === 0 ? 0 : Math.ceil(nPoints / blockPoints);
  if (nBlocks !== expectBlocks) throw new Gpsl0RefError("BadIndex", `n_blocks ${nBlocks} != ${expectBlocks}`);
  if (syncBlocks > nBlocks) throw new Gpsl0RefError("BadIndex", `sync_blocks ${syncBlocks} > n_blocks ${nBlocks}`);
  const modelId = u32le(bytes, 36);
  if (!SUPPORTED_MODELS.has(modelId)) throw new Gpsl0RefError("UnsupportedModel", `model_id ${modelId}`);
  const crcStored = u32le(bytes, 40);
  const crcActual = crc32Ref(bytes, 0, 40);
  if (crcStored !== crcActual) throw new Gpsl0RefError("CrcMismatch", `header crc ${crcStored} != ${crcActual}`);

  const indexEnd = HEADER_SIZE + nBlocks * INDEX_ENTRY;
  if (indexEnd > bytes.length) throw new Gpsl0RefError("BadIndex", `index truncated (${bytes.length}B)`);
  // header 44..47：整段 block index 的 crc32（v1 起索引也有校验和）
  const indexCrcStored = u32le(bytes, 44);
  const indexCrcActual = crc32Ref(bytes, HEADER_SIZE, indexEnd);
  if (indexCrcStored !== indexCrcActual) {
    throw new Gpsl0RefError("CrcMismatch", `index crc ${indexCrcStored} != ${indexCrcActual}`);
  }

  const blocks = [];
  let sum = 0;
  let prevEnd = indexEnd;
  for (let b = 0; b < nBlocks; b++) {
    const base = HEADER_SIZE + b * INDEX_ENTRY;
    const startTs = u32le(bytes, base + 0);
    const endTs = u32le(bytes, base + 4);
    const pointCount = u32le(bytes, base + 8);
    const byteOffset = u32le(bytes, base + 12);
    const byteLength = u32le(bytes, base + 16);
    const crcPayload = u32le(bytes, base + 20);
    if (pointCount === 0 || pointCount > blockPoints) {
      throw new Gpsl0RefError("BadIndex", `block ${b} point_count ${pointCount}`);
    }
    if (endTs < startTs) throw new Gpsl0RefError("BadIndex", `block ${b} end_ts < start_ts`);
    if (byteOffset < indexEnd) throw new Gpsl0RefError("BadIndex", `block ${b} payload overlaps header/index`);
    if (byteOffset + byteLength > bytes.length) throw new Gpsl0RefError("BadIndex", `block ${b} payload out of range`);
    if (byteOffset < prevEnd) throw new Gpsl0RefError("BadIndex", `block ${b} payload overlaps previous block`);
    const isSync = b === 0 || (syncBlocks > 0 && b % syncBlocks === 0);
    const minLen = (isSync ? 32 : 0) + 5;
    if (byteLength < minLen) throw new Gpsl0RefError("Truncated", `block ${b} payload ${byteLength}B < ${minLen}B`);
    const actual = crc32Ref(bytes, byteOffset, byteOffset + byteLength);
    if (actual !== crcPayload) throw new Gpsl0RefError("CrcMismatch", `block ${b} payload crc ${crcPayload} != ${actual}`);
    sum += pointCount;
    prevEnd = byteOffset + byteLength;
    blocks.push({ index: b, startTs, endTs, pointCount, byteOffset, byteLength, isSync });
  }
  if (sum !== nPoints) throw new Gpsl0RefError("BadIndex", `sum(point_count)=${sum} != n_points=${nPoints}`);
  if (nPoints === 0 && nBlocks !== 0) throw new Gpsl0RefError("BadIndex", "empty file with blocks");

  return {
    version,
    flags,
    tier0: (flags & FLAG_TIER0) !== 0,
    hasAlt: (flags & FLAG_HAS_ALT) !== 0,
    altDamped,
    coordMode,
    coordQuantum,
    altQuantum,
    nPoints,
    blockPoints,
    syncBlocks,
    nBlocks,
    modelId,
    headerCrc32: crcStored,
    indexCrc32: indexCrcStored,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// 逐点解码状态
// ---------------------------------------------------------------------------
function resetPredictorState() {
  return {
    tPrev: 0,
    tPrev2: 0,
    dtPrev: 0,
    dtCur: 0,
    latPrev: 0,
    latPrev2: 0,
    lonPrev: 0,
    lonPrev2: 0,
    altPrev: 0,
    altPrev2: 0,
    eDtPrev: 0,
    eLatPrev: 0,
    eLonPrev: 0,
    eAltPrev: 0,
  };
}

/**
 * 在 sync 块上从 32B seed 播种前两点（§1.3）。
 * 返回块内第一个待编码点的下标（2，或 1 点块时无）。
 */
function seedSyncBlock(rd, bytes, block, state) {
  const off = block.byteOffset;
  const t0 = i32le(bytes, off + 0) >>> 0;
  const lat0 = i32le(bytes, off + 4);
  const lon0 = i32le(bytes, off + 8);
  const alt0 = i32le(bytes, off + 12);
  const dt0 = i32le(bytes, off + 16) | 0;
  const vlat0 = i32le(bytes, off + 20);
  const vlon0 = i32le(bytes, off + 24);
  const valt0 = i32le(bytes, off + 28);

  state.tPrev = t0;
  state.latPrev = lat0;
  state.lonPrev = lon0;
  state.altPrev = alt0;
  if (block.pointCount >= 2) {
    const t1 = (t0 + dt0) >>> 0;
    state.tPrev2 = t0;
    state.tPrev = t1;
    state.dtPrev = dt0;
    state.latPrev2 = lat0;
    state.latPrev = lat0 + vlat0;
    state.lonPrev2 = lon0;
    state.lonPrev = lon0 + vlon0;
    state.altPrev2 = alt0;
    state.altPrev = alt0 + valt0;
  } else {
    // 1 点 sync 块：规格未定义"下一点的 d2 参考"，按退化处理（x[i-2]=x[i-1]）
    state.tPrev2 = t0;
    state.latPrev2 = lat0;
    state.lonPrev2 = lon0;
    state.altPrev2 = alt0;
  }
  state.eDtPrev = 0;
  state.eLatPrev = 0;
  state.eLonPrev = 0;
  state.eAltPrev = 0;
  return block.pointCount >= 2 ? 2 : block.pointCount;
}

/**
 * 解码从 fromBlock 到 toBlock（含）的连续块；返回解码出的四通道（quantum 单位）
 * 以及起始点之前的全局点索引。调用方负责只从 sync 块开始。
 */
function decodeBlocks(bytes, meta, fromBlock, toBlock) {
  // probs 必须跨续接块继承、sync 块重置，因此显式管理概率表。
  const firstBlock = meta.blocks[fromBlock];
  const firstStreamStart = firstBlock.byteOffset + (firstBlock.isSync ? 32 : 0);
  const rd = new RangeDecoder(bytes, firstStreamStart, firstBlock.byteOffset + firstBlock.byteLength);
  const state = resetPredictorState();
  const outT = [];
  const outLat = [];
  const outLon = [];
  const outAlt = [];

  for (let b = fromBlock; b <= toBlock; b++) {
    const block = meta.blocks[b];
    if (block.isSync) {
      rd.probs.fill(PROB_INIT);
      const startPayload = block.byteOffset; // seed 32B 之后才是 range stream
      rd.bytes = bytes;
      rd.pos = startPayload + 32 + 5;
      rd.end = block.byteOffset + block.byteLength;
      // 重新初始化 range decoder 的 code（seed 后的 5 字节）
      rd.code =
        ((bytes[startPayload + 32 + 1] << 24) |
          (bytes[startPayload + 32 + 2] << 16) |
          (bytes[startPayload + 32 + 3] << 8) |
          bytes[startPayload + 32 + 4]) >>>
        0;
      rd.range = 0xffffffff;
      const startIdx = seedSyncBlock(rd, bytes, block, state);
      // 前两点已在 seed 中，直接写入
      if (block.pointCount >= 1) {
        const off = block.byteOffset;
        outT.push(i32le(bytes, off + 0) >>> 0);
        outLat.push(i32le(bytes, off + 4));
        outLon.push(i32le(bytes, off + 8));
        outAlt.push(i32le(bytes, off + 12));
      }
      if (block.pointCount >= 2) {
        const off = block.byteOffset;
        const dt0 = i32le(bytes, off + 16) | 0;
        outT.push((i32le(bytes, off + 0) + dt0) >>> 0);
        outLat.push(i32le(bytes, off + 4) + i32le(bytes, off + 20));
        outLon.push(i32le(bytes, off + 8) + i32le(bytes, off + 24));
        outAlt.push(i32le(bytes, off + 12) + i32le(bytes, off + 28));
      }
      decodePoints(bytes, meta, block, startIdx, rd, state, outT, outLat, outLon, outAlt);
    } else {
      // 续接块：无 seed，range stream 紧接 payload 起始；prob 与状态继承
      rd.bytes = bytes;
      rd.pos = block.byteOffset + 5;
      rd.end = block.byteOffset + block.byteLength;
      rd.code =
        ((bytes[block.byteOffset + 1] << 24) |
          (bytes[block.byteOffset + 2] << 16) |
          (bytes[block.byteOffset + 3] << 8) |
          bytes[block.byteOffset + 4]) >>>
        0;
      rd.range = 0xffffffff;
      decodePoints(bytes, meta, block, 0, rd, state, outT, outLat, outLon, outAlt);
    }
  }
  return { t: outT, lat: outLat, lon: outLon, alt: outAlt };
}

/** 坐标预测（§3.2 三档：0=tn, 1=naive, 2=tn-clamped）。 */
function predictCoord(coordMode, xPrev, xPrev2, dtPrev, dtCur) {
  if (coordMode === 1) return 2 * xPrev - xPrev2; // naive d2
  if (dtPrev > 0 && dtCur > 0) {
    let d1 = dtCur;
    if (coordMode === 2 && d1 > 2 * dtPrev) d1 = 2 * dtPrev; // tn-clamped
    return xPrev + roundDivRef((xPrev - xPrev2) * d1, dtPrev);
  }
  return xPrev;
}

/** 解码 block 内下标 [startIdx, pointCount) 的点（§6 顺序：dt→lat→lon→alt）。 */
function decodePoints(bytes, meta, block, startIdx, rd, st, outT, outLat, outLon, outAlt) {
  const coordMode = meta.coordMode;
  const altDamped = meta.altDamped;
  for (let i = startIdx; i < block.pointCount; i++) {
    // ---- dt ----
    const ctxDt = dtBucketRef(st.dtPrev) * 2 + (st.eDtPrev !== 0 ? 1 : 0);
    const eDt = decodeResidual(rd, ctxDt);
    const dtCur = st.dtPrev + eDt;
    const tCur = (st.tPrev + dtCur) >>> 0;
    const dchg = eDt !== 0 ? 1 : 0;

    // ---- lat ----
    const ctxLat = 10 + (0 * 17 + q1Ref(st.eLatPrev)) * 2 + dchg;
    const predLat = predictCoord(coordMode, st.latPrev, st.latPrev2, st.dtPrev, dtCur);
    const eLat = decodeResidual(rd, ctxLat);
    const latCur = predLat + eLat;

    // ---- lon ----
    const ctxLon = 44 + (0 * 17 + q1Ref(st.eLonPrev)) * 2 + dchg;
    const predLon = predictCoord(coordMode, st.lonPrev, st.lonPrev2, st.dtPrev, dtCur);
    const eLon = decodeResidual(rd, ctxLon);
    const lonCur = predLon + eLon;

    // ---- alt ----
    const ctxAlt = 78 + q1Ref(st.eAltPrev, 4);
    const predAlt = altDamped ? st.altPrev + ((st.altPrev - st.altPrev2) >> 1) : st.altPrev;
    const eAlt = decodeResidual(rd, ctxAlt);
    const altCur = predAlt + eAlt;

    outT.push(tCur >>> 0);
    outLat.push(latCur | 0);
    outLon.push(lonCur | 0);
    outAlt.push(altCur | 0);

    // ---- 状态更新（§6） ----
    st.tPrev2 = st.tPrev;
    st.tPrev = tCur;
    st.dtPrev = dtCur;
    st.latPrev2 = st.latPrev;
    st.latPrev = latCur | 0;
    st.lonPrev2 = st.lonPrev;
    st.lonPrev = lonCur | 0;
    st.altPrev2 = st.altPrev;
    st.altPrev = altCur | 0;
    st.eDtPrev = eDt;
    st.eLatPrev = eLat;
    st.eLonPrev = eLon;
    st.eAltPrev = eAlt;
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------
function toMeta(meta) {
  const { blocks, ...rest } = meta;
  return {
    ...rest,
    precisionDeg: meta.coordQuantum / 1e7,
    blockCount: blocks.length,
    byteLength: undefined,
  };
}

function scaleToGpzUnits(decoded, meta) {
  const n = decoded.t.length;
  const t = new Int32Array(n);
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  const alt = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = decoded.t[i] | 0;
    lat[i] = decoded.lat[i] * meta.coordQuantum;
    lon[i] = decoded.lon[i] * meta.coordQuantum;
    alt[i] = decoded.alt[i] * meta.altQuantum;
  }
  return { t, lat, lon, alt };
}

/**
 * 全量解码。
 * @param {Uint8Array} bytes
 * @returns {{t:Int32Array,lat:Int32Array,lon:Int32Array,alt:Int32Array,meta:object}}
 */
export function decodeGpsl0Ref(bytes) {
  const meta = parseHeaderRef(bytes);
  if (meta.nPoints === 0) {
    return {
      t: new Int32Array(0),
      lat: new Int32Array(0),
      lon: new Int32Array(0),
      alt: new Int32Array(0),
      meta: { ...toMeta(meta), byteLength: bytes.length },
    };
  }
  const decoded = decodeBlocks(bytes, meta, 0, meta.nBlocks - 1);
  const out = scaleToGpzUnits(decoded, meta);
  out.meta = { ...toMeta(meta), byteLength: bytes.length };
  return out;
}

/**
 * 窗口解码（与参考 codec 同语义：syncBlocks=0 时从块 0 重放）。
 * @param {Uint8Array} bytes
 * @param {number} startPoint
 * @param {number} len
 */
export function decodeGpsl0WindowRef(bytes, startPoint, len) {
  const meta = parseHeaderRef(bytes);
  if (!Number.isInteger(startPoint) || !Number.isInteger(len)) {
    throw new Gpsl0RefError("BadWindow", "start/len must be integers");
  }
  if (meta.nPoints === 0) throw new Gpsl0RefError("BadWindow", "empty file has no window");
  if (startPoint < 0 || len < 1 || startPoint + len > meta.nPoints) {
    throw new Gpsl0RefError("BadWindow", `window [${startPoint},${startPoint + len}) outside 0..${meta.nPoints}`);
  }
  const firstBlock = Math.floor(startPoint / meta.blockPoints);
  const lastBlock = Math.floor((startPoint + len - 1) / meta.blockPoints);
  let fromBlock = 0;
  if (meta.syncBlocks > 0) fromBlock = Math.floor(firstBlock / meta.syncBlocks) * meta.syncBlocks;
  const decoded = decodeBlocks(bytes, meta, fromBlock, lastBlock);
  const basePoint = fromBlock * meta.blockPoints;
  const offset = startPoint - basePoint;
  const scaled = scaleToGpzUnits(
    {
      t: decoded.t.slice(offset, offset + len),
      lat: decoded.lat.slice(offset, offset + len),
      lon: decoded.lon.slice(offset, offset + len),
      alt: decoded.alt.slice(offset, offset + len),
    },
    meta
  );
  scaled.meta = { ...toMeta(meta), byteLength: bytes.length };
  return scaled;
}

export default { decodeGpsl0Ref, decodeGpsl0WindowRef, parseHeaderRef, crc32Ref, q1Ref, dtBucketRef, zigzagRef, unzigzagRef };
