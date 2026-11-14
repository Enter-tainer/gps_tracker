// GPSL0 binary range coder (LZMA style, 11-bit probabilities, u16 state).
//
// The constants and the shift_low carry handling must match the spec exactly:
//   PROB_BITS = 11, PROB_INIT = 1024, MOVE_BITS = 5, TOP = 1 << 24
// Probability slots store P(bit = 0) scaled to 2048.
//
// All state is kept in plain Numbers bounded below 2^53, so every operation is
// exact in IEEE-754 doubles and bit-identical across engines.

export const PROB_BITS = 11;
export const PROB_SCALE = 1 << PROB_BITS; // 2048
export const PROB_INIT = PROB_SCALE >> 1; // 1024
export const MOVE_BITS = 5;
export const TOP = 1 << 24;

const LOW_MASK = 0xffffffff;

export class RangeEncoder {
  private low = 0; // exact value in [0, 2^33)
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private readonly out: number[] = [];

  private shiftLow(): void {
    const low32 = this.low >>> 0;
    const carry = Math.floor(this.low / 0x100000000);
    if (low32 < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (low32 >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (low32 << 8) >>> 0;
  }

  encodeBit(probs: Uint16Array, index: number, bit: number): void {
    const p = probs[index];
    if (p === undefined) {
      throw new Error(`GPSL0: probability index ${index} out of range`);
    }
    const bound = (this.range >>> PROB_BITS) * p;
    if (bit === 0) {
      this.range = bound;
      probs[index] = (p + ((PROB_SCALE - p) >> MOVE_BITS)) & 0xffff;
    } else {
      this.low += bound;
      this.range = (this.range - bound) >>> 0;
      probs[index] = (p - (p >> MOVE_BITS)) & 0xffff;
    }
    while (this.range < TOP) {
      this.shiftLow();
      this.range = (this.range << 8) >>> 0;
    }
  }

  /** Equiprobable bit, used for mantissa low bits. */
  encodeDirect(bit: number): void {
    this.range = this.range >>> 1;
    if (bit !== 0) this.low += this.range;
    while (this.range < TOP) {
      this.shiftLow();
      this.range = (this.range << 8) >>> 0;
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

export class RangeDecoder {
  private code = 0;
  private range = 0xffffffff;
  private pos: number;
  private readonly end: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length < 5) {
      throw new Error("GPSL0: range stream too short");
    }
    this.bytes = bytes;
    this.end = bytes.length;
    // The first byte written by shift_low is always 0x00; the decoder consumes
    // it and seeds `code` from the next four bytes.
    this.code =
      ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
    this.pos = 5;
  }

  private nextByte(): number {
    if (this.pos >= this.end) {
      throw new Error("GPSL0: range coder underflow (truncated block payload)");
    }
    return this.bytes[this.pos++];
  }

  decodeBit(probs: Uint16Array, index: number): number {
    const p = probs[index];
    if (p === undefined) {
      throw new Error(`GPSL0: probability index ${index} out of range`);
    }
    const bound = (this.range >>> PROB_BITS) * p;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = (p + ((PROB_SCALE - p) >> MOVE_BITS)) & 0xffff;
      bit = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[index] = (p - (p >> MOVE_BITS)) & 0xffff;
      bit = 1;
    }
    while (this.range < TOP) {
      this.code = ((this.code << 8) | this.nextByte()) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
    return bit;
  }

  decodeDirect(): number {
    this.range = this.range >>> 1;
    let bit = 0;
    if (this.code >= this.range) {
      this.code = (this.code - this.range) >>> 0;
      bit = 1;
    }
    while (this.range < TOP) {
      this.code = ((this.code << 8) | this.nextByte()) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
    return bit;
  }

  /** Bytes consumed so far (used by tests/diagnostics only). */
  get consumed(): number {
    return this.pos;
  }
}

export { LOW_MASK };
