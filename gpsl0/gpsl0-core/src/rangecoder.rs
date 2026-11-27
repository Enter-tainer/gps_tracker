#[cfg(feature = "alloc")]
use alloc::{format, vec::Vec};

use crate::container::ByteSink;
#[cfg(feature = "alloc")]
use crate::error::Gpsl0Error;
use crate::error::StreamError;

pub const TOP: u32 = 1 << 24;

// ---------------------------------------------------------------------------
// GPSL0 v1 LZMA-style binary range coder (11-bit probabilities, bit-exact)
// ---------------------------------------------------------------------------
#[cfg(feature = "v1")]
pub const PROB_BITS_V1: u32 = 11;
#[cfg(feature = "v1")]
pub const PROB_SCALE_V1: u16 = 1 << PROB_BITS_V1; // 2048
#[cfg(feature = "v1")]
pub const PROB_INIT_V1: u16 = PROB_SCALE_V1 >> 1; // 1024
#[cfg(feature = "v1")]
pub const MOVE_BITS_V1: u32 = 5;

#[cfg(feature = "v1")]
pub struct RangeEncoderV1 {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    out: Vec<u8>,
}

#[cfg(feature = "v1")]
impl RangeEncoderV1 {
    pub fn new() -> Self {
        Self {
            low: 0,
            range: 0xFFFF_FFFF,
            cache: 0,
            cache_size: 1,
            out: Vec::new(),
        }
    }

    #[inline]
    fn shift_low(&mut self) {
        let low32 = self.low as u32;
        let carry = (self.low >> 32) as u8;
        if low32 < 0xFF00_0000 || carry != 0 {
            let mut temp = self.cache;
            loop {
                self.out.push(temp.wrapping_add(carry));
                temp = 0xFF;
                self.cache_size -= 1;
                if self.cache_size == 0 {
                    break;
                }
            }
            self.cache = (low32 >> 24) as u8;
        }
        self.cache_size += 1;
        self.low = (low32 << 8) as u64;
    }

    #[inline]
    pub fn encode_bit(&mut self, probs: &mut [u16], index: usize, bit: u8) -> Result<(), Gpsl0Error> {
        let p = *probs
            .get(index)
            .ok_or_else(|| Gpsl0Error::InvalidInput(format!("prob index {index} out of range")))?;
        let bound = (self.range >> PROB_BITS_V1) * (p as u32);
        if bit == 0 {
            self.range = bound;
            probs[index] = p + ((PROB_SCALE_V1 - p) >> MOVE_BITS_V1);
        } else {
            self.low += bound as u64;
            self.range -= bound;
            probs[index] = p - (p >> MOVE_BITS_V1);
        }
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
        Ok(())
    }

    #[inline]
    pub fn encode_direct(&mut self, bit: u8) {
        self.range >>= 1;
        if bit != 0 {
            self.low += self.range as u64;
        }
        while self.range < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }

    pub fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        self.out
    }
}

#[cfg(all(feature = "v1", feature = "decode"))]
pub struct RangeDecoderV1<'a> {
    code: u32,
    range: u32,
    pos: usize,
    bytes: &'a [u8],
}

#[cfg(all(feature = "v1", feature = "decode"))]
impl<'a> RangeDecoderV1<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, Gpsl0Error> {
        if bytes.len() < 5 {
            return Err(Gpsl0Error::Truncated("range stream too short".into()));
        }
        let code = ((bytes[1] as u32) << 24)
            | ((bytes[2] as u32) << 16)
            | ((bytes[3] as u32) << 8)
            | (bytes[4] as u32);
        Ok(Self {
            code,
            range: 0xFFFF_FFFF,
            pos: 5,
            bytes,
        })
    }

    #[inline]
    fn next_byte(&mut self) -> Result<u8, Gpsl0Error> {
        if self.pos >= self.bytes.len() {
            return Err(Gpsl0Error::Truncated(
                "range coder underflow (truncated block payload)".into(),
            ));
        }
        let b = self.bytes[self.pos];
        self.pos += 1;
        Ok(b)
    }

    #[inline]
    pub fn decode_bit(&mut self, probs: &mut [u16], index: usize) -> Result<u8, Gpsl0Error> {
        let p = *probs
            .get(index)
            .ok_or_else(|| Gpsl0Error::InvalidInput(format!("prob index {index} out of range")))?;
        let bound = (self.range >> PROB_BITS_V1) * (p as u32);
        let bit = if self.code < bound {
            self.range = bound;
            probs[index] = p + ((PROB_SCALE_V1 - p) >> MOVE_BITS_V1);
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            probs[index] = p - (p >> MOVE_BITS_V1);
            1
        };
        while self.range < TOP {
            let b = self.next_byte()? as u32;
            self.code = (self.code << 8) | b;
            self.range <<= 8;
        }
        Ok(bit)
    }

    #[inline]
    pub fn decode_direct(&mut self) -> Result<u8, Gpsl0Error> {
        self.range >>= 1;
        let bit = if self.code >= self.range {
            self.code -= self.range;
            1
        } else {
            0
        };
        while self.range < TOP {
            let b = self.next_byte()? as u32;
            self.code = (self.code << 8) | b;
            self.range <<= 8;
        }
        Ok(bit)
    }
}

// ---------------------------------------------------------------------------
// GPSL0 v2 configurable binary range coder (12..14-bit prob, dual-speed,
// rounded update, configurable probability floor & per-role adaptation speeds)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    SlowZero, // all_zero3, dt_zero (95%+ skewed)
    FastZero, // lat/lon/alt zero flags (60-85%)
    MagSign,  // unary, mantissa, sign
}

#[derive(Debug, Clone, Copy)]
pub struct RcV2Params {
    pub prob_bits: u32,
    pub exact_bound: bool,
    pub min_prob: u16,
    pub dual_speed: bool,
    pub slow_zero_shift: u32,
    pub fast_zero_shift: u32,
    pub mag_shift: u32,
}

impl Default for RcV2Params {
    fn default() -> Self {
        Self {
            prob_bits: 12,
            exact_bound: true,
            min_prob: 4,
            dual_speed: true,
            slow_zero_shift: 6,
            fast_zero_shift: 5,
            mag_shift: 5,
        }
    }
}

/// Frozen GPSL0 v3 (`version = 2`, `model_id = 22`) range coder parameters.
pub const RC_V2_FROZEN: RcV2Params = RcV2Params {
    prob_bits: 12,
    exact_bound: true,
    min_prob: 4,
    dual_speed: true,
    slow_zero_shift: 7,
    fast_zero_shift: 5,
    mag_shift: 5,
};

/// Packed `u16` state cell constants for `#![no_std]` zero-alloc v3 streaming:
/// low 12 bits hold `prob` in `[4, 4092]`, upper 4 bits hold saturated sample `count` in `0..=14`.
pub const PACKED_PROB_MASK: u16 = 0x0FFF;
pub const PACKED_COUNT_SHIFT: u32 = 12;
pub const PACKED_INIT_V3: u16 = RC_V2_FROZEN.prob_init();

impl RcV2Params {
    #[inline]
    pub const fn prob_scale(self) -> u16 {
        1u16 << self.prob_bits
    }

    #[inline]
    pub const fn prob_init(self) -> u16 {
        1u16 << (self.prob_bits - 1)
    }
}

#[inline]
fn update_prob_v2(
    p: u16,
    count: u8,
    bit: u8,
    kind: SlotKind,
    params: &RcV2Params,
) -> (u16, u8) {
    let scale = params.prob_scale();
    let min_p = params.min_prob.max(1);
    let max_p = scale - min_p;
    let steady = match kind {
        SlotKind::SlowZero => params.slow_zero_shift,
        SlotKind::FastZero => params.fast_zero_shift,
        SlotKind::MagSign => params.mag_shift,
    };
    let shift = if params.dual_speed {
        if count < 2 {
            2
        } else if count < 6 {
            3
        } else if count < 14 {
            4
        } else {
            steady
        }
    } else {
        steady
    };
    let round = 1u16 << (shift - 1);
    let new_p = if bit == 0 {
        let diff = scale - p;
        let delta = ((diff + round) >> shift).max(1);
        (p + delta).min(max_p)
    } else {
        let delta = ((p + round) >> shift).max(1);
        p.saturating_sub(delta).max(min_p)
    };
    (new_p, count.saturating_add(1))
}

/// Zero-allocation v2 range encoder core writing directly to any [`ByteSink`].
pub struct RangeEncoderV2Core {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    params: RcV2Params,
}

impl RangeEncoderV2Core {
    #[inline]
    pub const fn new(params: RcV2Params) -> Self {
        Self {
            low: 0,
            range: 0xFFFF_FFFF,
            cache: 0,
            cache_size: 1,
            params,
        }
    }

    #[inline]
    pub fn reset(&mut self) {
        self.low = 0;
        self.range = 0xFFFF_FFFF;
        self.cache = 0;
        self.cache_size = 1;
    }

    #[inline]
    fn shift_low<S: ByteSink>(&mut self, sink: &mut S) -> Result<(), S::Error> {
        let low32 = self.low as u32;
        let carry = (self.low >> 32) as u8;
        if low32 < 0xFF00_0000 || carry != 0 {
            let mut temp = self.cache;
            loop {
                sink.write_byte(temp.wrapping_add(carry))?;
                temp = 0xFF;
                self.cache_size -= 1;
                if self.cache_size == 0 {
                    break;
                }
            }
            self.cache = (low32 >> 24) as u8;
        }
        self.cache_size += 1;
        self.low = (low32 << 8) as u64;
        Ok(())
    }

    #[inline]
    pub fn encode_bit<S: ByteSink>(
        &mut self,
        sink: &mut S,
        probs: &mut [u16],
        counts: &mut [u8],
        index: usize,
        bit: u8,
        kind: SlotKind,
    ) -> Result<(), StreamError<S::Error>> {
        let p = *probs
            .get(index)
            .ok_or(StreamError::InvalidInput("prob index out of range"))?;
        let bound = if self.params.exact_bound {
            (((self.range as u64) * (p as u64)) >> self.params.prob_bits) as u32
        } else {
            (self.range >> self.params.prob_bits) * (p as u32)
        };
        if bit == 0 {
            self.range = bound;
        } else {
            self.low += bound as u64;
            self.range -= bound;
        }
        let (np, nc) = update_prob_v2(p, counts[index], bit, kind, &self.params);
        probs[index] = np;
        counts[index] = nc;
        while self.range < TOP {
            self.shift_low(sink).map_err(StreamError::Sink)?;
            self.range <<= 8;
        }
        Ok(())
    }

    /// Encode one binary symbol using a packed `u16` cell `(count.min(14) << 12) | prob`.
    #[inline]
    pub fn encode_bit_packed<S: ByteSink>(
        &mut self,
        sink: &mut S,
        cells: &mut [u16],
        index: usize,
        bit: u8,
        kind: SlotKind,
    ) -> Result<(), StreamError<S::Error>> {
        let cell = *cells
            .get(index)
            .ok_or(StreamError::InvalidInput("prob index out of range"))?;
        let p = cell & PACKED_PROB_MASK;
        let count = (cell >> PACKED_COUNT_SHIFT) as u8;
        let bound = if self.params.exact_bound {
            (((self.range as u64) * (p as u64)) >> self.params.prob_bits) as u32
        } else {
            (self.range >> self.params.prob_bits) * (p as u32)
        };
        if bit == 0 {
            self.range = bound;
        } else {
            self.low += bound as u64;
            self.range -= bound;
        }
        let (np, nc) = update_prob_v2(p, count, bit, kind, &self.params);
        cells[index] = np | ((nc.min(14) as u16) << PACKED_COUNT_SHIFT);
        while self.range < TOP {
            self.shift_low(sink).map_err(StreamError::Sink)?;
            self.range <<= 8;
        }
        Ok(())
    }

    #[inline]
    pub fn encode_direct<S: ByteSink>(&mut self, sink: &mut S, bit: u8) -> Result<(), S::Error> {
        self.range >>= 1;
        if bit != 0 {
            self.low += self.range as u64;
        }
        while self.range < TOP {
            self.shift_low(sink)?;
            self.range <<= 8;
        }
        Ok(())
    }

    pub fn finish<S: ByteSink>(&mut self, sink: &mut S) -> Result<(), S::Error> {
        for _ in 0..5 {
            self.shift_low(sink)?;
        }
        Ok(())
    }
}

#[cfg(feature = "alloc")]
pub struct RangeEncoderV2 {
    core: RangeEncoderV2Core,
    out: Vec<u8>,
}

#[cfg(feature = "alloc")]
impl RangeEncoderV2 {
    pub fn new(params: RcV2Params) -> Self {
        Self {
            core: RangeEncoderV2Core::new(params),
            out: Vec::new(),
        }
    }

    #[inline]
    pub fn encode_bit(
        &mut self,
        probs: &mut [u16],
        counts: &mut [u8],
        index: usize,
        bit: u8,
        kind: SlotKind,
    ) -> Result<(), Gpsl0Error> {
        self.core
            .encode_bit(&mut self.out, probs, counts, index, bit, kind)
            .map_err(|err| match err {
                StreamError::InvalidInput(_) => {
                    Gpsl0Error::InvalidInput(format!("prob index {index} out of range"))
                }
                StreamError::Sink(inf) => match inf {},
            })
    }

    #[inline]
    pub fn encode_direct(&mut self, bit: u8) {
        let Ok(()) = self.core.encode_direct(&mut self.out, bit);
    }

    pub fn finish(mut self) -> Vec<u8> {
        let Ok(()) = self.core.finish(&mut self.out);
        self.out
    }
}

#[cfg(feature = "decode")]
pub struct RangeDecoderV2<'a> {
    code: u32,
    range: u32,
    pos: usize,
    bytes: &'a [u8],
    params: RcV2Params,
}

#[cfg(feature = "decode")]
impl<'a> RangeDecoderV2<'a> {
    pub fn new(bytes: &'a [u8], params: RcV2Params) -> Result<Self, Gpsl0Error> {
        if bytes.len() < 5 {
            return Err(Gpsl0Error::Truncated("range stream too short".into()));
        }
        let code = ((bytes[1] as u32) << 24)
            | ((bytes[2] as u32) << 16)
            | ((bytes[3] as u32) << 8)
            | (bytes[4] as u32);
        Ok(Self {
            code,
            range: 0xFFFF_FFFF,
            pos: 5,
            bytes,
            params,
        })
    }

    #[inline]
    fn next_byte(&mut self) -> Result<u8, Gpsl0Error> {
        if self.pos >= self.bytes.len() {
            return Err(Gpsl0Error::Truncated(
                "range coder underflow (truncated block payload)".into(),
            ));
        }
        let b = self.bytes[self.pos];
        self.pos += 1;
        Ok(b)
    }

    #[inline]
    pub fn decode_bit(
        &mut self,
        probs: &mut [u16],
        counts: &mut [u8],
        index: usize,
        kind: SlotKind,
    ) -> Result<u8, Gpsl0Error> {
        let p = *probs
            .get(index)
            .ok_or_else(|| Gpsl0Error::InvalidInput(format!("prob index {index} out of range")))?;
        let bound = if self.params.exact_bound {
            (((self.range as u64) * (p as u64)) >> self.params.prob_bits) as u32
        } else {
            (self.range >> self.params.prob_bits) * (p as u32)
        };
        let bit = if self.code < bound {
            self.range = bound;
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            1
        };
        let (np, nc) = update_prob_v2(p, counts[index], bit, kind, &self.params);
        probs[index] = np;
        counts[index] = nc;
        while self.range < TOP {
            let b = self.next_byte()? as u32;
            self.code = (self.code << 8) | b;
            self.range <<= 8;
        }
        Ok(bit)
    }

    #[inline]
    pub fn decode_direct(&mut self) -> Result<u8, Gpsl0Error> {
        self.range >>= 1;
        let bit = if self.code >= self.range {
            self.code -= self.range;
            1
        } else {
            0
        };
        while self.range < TOP {
            let b = self.next_byte()? as u32;
            self.code = (self.code << 8) | b;
            self.range <<= 8;
        }
        Ok(bit)
    }
}

