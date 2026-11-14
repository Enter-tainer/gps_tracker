// GPSL0 container helpers: CRC32 and little-endian fixed-layout header/index IO.
// Pure integer code, no allocation tricks, safe to run in browsers and Node.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), returns unsigned 32-bit. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export const HEADER_SIZE = 48;
export const INDEX_ENTRY_SIZE = 24;
export const MAGIC = "GPSL0";
export const VERSION = 1;

export type Gpsl0Flags = {
  /** bit0: stored coordinates are already at quantum 1 (fully lossless tier). */
  tier0: boolean;
  /** bit1: altitude channel present. */
  hasAlt: boolean;
  /** bit2: altitude predictor is the damped second difference (else first difference). */
  altDamped: boolean;
  /**
   * Coordinate residual predictor, encoded in flags bits 3..4:
   * 0 = time-normalized d2, 1 = naive d2, 2 = time-normalized d2 with the
   * extrapolation ratio clamped to 2x.
   */
  coordMode: number;
};

export type Gpsl0Header = {
  version: number;
  flags: Gpsl0Flags;
  /**
   * Coordinate quantum in units of 1e-7 degree: stored value * quantum = the
   * original GPZ integer. 1 => lossless at 1e7, 10 => 1e6 (11 cm),
   * 100 => 1e5 (1.1 m, the natural grid of GPZ V1 data).
   */
  coordQuantum: number;
  /** Altitude quantum in units of 0.1 m: 1 => 0.1 m, 10 => 1 m. */
  altQuantum: number;
  nPoints: number;
  blockPoints: number;
  /** Reset probability tables every `syncBlocks` blocks; 0 = never reset. */
  syncBlocks: number;
  nBlocks: number;
  modelId: number;
  headerCrc32: number;
  /** CRC-32 of the whole block-index region (detects index tampering). */
  indexCrc32: number;
};

export function writeHeader(bytes: Uint8Array, header: Gpsl0Header): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i++) {
    bytes[i] = i < MAGIC.length ? MAGIC.charCodeAt(i) : 0;
  }
  view.setUint16(8, header.version, true);
  let flags = 0;
  if (header.flags.tier0) flags |= 1;
  if (header.flags.hasAlt) flags |= 2;
  if (header.flags.altDamped) flags |= 4;
  if ((header.flags.coordMode & 1) !== 0) flags |= 8;
  if ((header.flags.coordMode & 2) !== 0) flags |= 16;
  view.setUint16(10, flags, true);
  view.setUint32(12, header.coordQuantum, true);
  view.setUint32(16, header.altQuantum, true);
  view.setUint32(20, header.nPoints, true);
  view.setUint32(24, header.blockPoints, true);
  view.setUint32(28, header.syncBlocks, true);
  view.setUint32(32, header.nBlocks, true);
  view.setUint32(36, header.modelId, true);
  view.setUint32(40, crc32(bytes, 0, 40), true);
  view.setUint32(44, header.indexCrc32 >>> 0, true);
}

export function readHeader(bytes: Uint8Array): Gpsl0Header {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`GPSL0: truncated header (${bytes.length} < ${HEADER_SIZE})`);
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      throw new Error("GPSL0: bad magic");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, true);
  if (version !== VERSION) {
    throw new Error(`GPSL0: unsupported version ${version}`);
  }
  const expectedCrc = view.getUint32(40, true);
  const actualCrc = crc32(bytes, 0, 40);
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `GPSL0: header crc mismatch (got 0x${actualCrc.toString(16)}, want 0x${expectedCrc.toString(16)})`
    );
  }
  const flagBits = view.getUint16(10, true);
  if ((flagBits & ~0x1f) !== 0) {
    throw new Error(`GPSL0: unknown header flags 0x${flagBits.toString(16)}`);
  }
  const header: Gpsl0Header = {
    version,
    flags: {
      tier0: (flagBits & 1) !== 0,
      hasAlt: (flagBits & 2) !== 0,
      altDamped: (flagBits & 4) !== 0,
      coordMode: (flagBits & 8 ? 1 : 0) | (flagBits & 16 ? 2 : 0),
    },
    coordQuantum: view.getUint32(12, true),
    altQuantum: view.getUint32(16, true),
    nPoints: view.getUint32(20, true),
    blockPoints: view.getUint32(24, true),
    syncBlocks: view.getUint32(28, true),
    nBlocks: view.getUint32(32, true),
    modelId: view.getUint32(36, true),
    headerCrc32: expectedCrc,
    indexCrc32: view.getUint32(44, true),
  };
  if (
    header.coordQuantum < 1 ||
    header.coordQuantum > 1e7 ||
    1e7 % header.coordQuantum !== 0
  ) {
    throw new Error(`GPSL0: bad coord_quantum ${header.coordQuantum}`);
  }
  if (header.altQuantum < 1 || 10 % header.altQuantum !== 0) {
    throw new Error(`GPSL0: bad alt_quantum ${header.altQuantum}`);
  }
  if (header.blockPoints === 0 || header.blockPoints > 1 << 20) {
    throw new Error(`GPSL0: bad block_points ${header.blockPoints}`);
  }
  if (header.nBlocks > (1 << 22) || header.nBlocks * INDEX_ENTRY_SIZE > bytes.length) {
    throw new Error(`GPSL0: bad n_blocks ${header.nBlocks}`);
  }
  if (header.nPoints > 1 << 30) {
    throw new Error(`GPSL0: bad n_points ${header.nPoints}`);
  }
  if (header.syncBlocks !== 0 && header.syncBlocks > header.nBlocks) {
    throw new Error(
      `GPSL0: bad sync_blocks ${header.syncBlocks} for ${header.nBlocks} blocks`
    );
  }
  return header;
}

export type Gpsl0BlockEntry = {
  startTs: number;
  endTs: number;
  pointCount: number;
  byteOffset: number;
  byteLength: number;
  crc32: number;
};

export function readBlockIndex(
  bytes: Uint8Array,
  header: Gpsl0Header
): Gpsl0BlockEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexEnd = HEADER_SIZE + header.nBlocks * INDEX_ENTRY_SIZE;
  const actualIndexCrc = crc32(bytes, HEADER_SIZE, indexEnd);
  if (actualIndexCrc !== header.indexCrc32) {
    throw new Error(
      `GPSL0: block index crc mismatch (got 0x${actualIndexCrc.toString(16)}, ` +
        `want 0x${header.indexCrc32.toString(16)})`
    );
  }
  const entries: Gpsl0BlockEntry[] = [];
  let off = HEADER_SIZE;
  let expectPoint = 0;
  for (let i = 0; i < header.nBlocks; i++) {
    const startTs = view.getUint32(off, true);
    const endTs = view.getUint32(off + 4, true);
    const pointCount = view.getUint32(off + 8, true);
    const byteOffset = view.getUint32(off + 12, true);
    const byteLength = view.getUint32(off + 16, true);
    const blockCrc = view.getUint32(off + 20, true);
    off += INDEX_ENTRY_SIZE;
    if (pointCount === 0 || pointCount > header.blockPoints) {
      throw new Error(`GPSL0: block ${i} bad point_count ${pointCount}`);
    }
    if (endTs < startTs) {
      throw new Error(`GPSL0: block ${i} end_ts before start_ts`);
    }
    if (byteOffset < HEADER_SIZE || byteOffset + byteLength > bytes.length) {
      throw new Error(`GPSL0: block ${i} payload out of range`);
    }
    entries.push({ startTs, endTs, pointCount, byteOffset, byteLength, crc32: blockCrc });
    expectPoint += pointCount;
  }
  if (expectPoint !== header.nPoints) {
    throw new Error(
      `GPSL0: block point counts sum to ${expectPoint}, header says ${header.nPoints}`
    );
  }
  return entries;
}
