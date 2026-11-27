use core::fmt;

#[cfg(feature = "alloc")]
use alloc::vec::Vec;
#[cfg(feature = "decode")]
use alloc::format;

#[cfg(feature = "decode")]
use crate::error::Gpsl0Error;

#[cfg(feature = "v1")]
pub const HEADER_SIZE_V1: usize = 48;
pub const HEADER_SIZE_V2: usize = 36;
#[cfg(feature = "v1")]
pub const INDEX_ENTRY_SIZE_V1: usize = 24;
pub const MAGIC: [u8; 8] = *b"GPSL0\0\0\0";

/// Byte output sink for zero-allocation streaming encoding (`no_std` compatible).
pub trait ByteSink {
    type Error;

    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error>;

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        for &b in bytes {
            self.write_byte(b)?;
        }
        Ok(())
    }
}

#[cfg(feature = "alloc")]
impl ByteSink for Vec<u8> {
    type Error = core::convert::Infallible;

    #[inline]
    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error> {
        self.push(byte);
        Ok(())
    }

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.extend_from_slice(bytes);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SliceOverflow;

impl fmt::Display for SliceOverflow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "output buffer capacity exceeded")
    }
}

impl core::error::Error for SliceOverflow {}

/// Fixed-buffer [`ByteSink`] writing into a caller-provided `&mut [u8]`.
pub struct SliceSink<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> SliceSink<'a> {
    #[inline]
    pub fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.pos
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.pos == 0
    }

    #[inline]
    pub fn written(&self) -> &[u8] {
        &self.buf[..self.pos]
    }
}

impl ByteSink for SliceSink<'_> {
    type Error = SliceOverflow;

    #[inline]
    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error> {
        if self.pos >= self.buf.len() {
            return Err(SliceOverflow);
        }
        self.buf[self.pos] = byte;
        self.pos += 1;
        Ok(())
    }

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        let end = self.pos.checked_add(bytes.len()).ok_or(SliceOverflow)?;
        if end > self.buf.len() {
            return Err(SliceOverflow);
        }
        self.buf[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
        Ok(())
    }
}

/// Incremental IEEE 802.3 CRC-32 hasher.
#[derive(Debug, Clone, Copy)]
pub struct Crc32Hasher {
    state: u32,
}

impl Crc32Hasher {
    #[inline]
    pub const fn new() -> Self {
        Self {
            state: 0xFFFF_FFFF,
        }
    }

    #[inline]
    pub fn reset(&mut self) {
        self.state = 0xFFFF_FFFF;
    }

    #[inline]
    pub fn update_byte(&mut self, b: u8) {
        self.state = CRC_TABLE[((self.state ^ (b as u32)) & 0xFF) as usize] ^ (self.state >> 8);
    }

    #[inline]
    pub fn update(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.update_byte(b);
        }
    }

    #[inline]
    pub const fn finalize(&self) -> u32 {
        !self.state
    }
}

impl Default for Crc32Hasher {
    fn default() -> Self {
        Self::new()
    }
}

/// Sink that hashes every byte into CRC-32 and counts written bytes without storing them.
pub struct Crc32OnlySink {
    crc: Crc32Hasher,
    len: u32,
}

impl Crc32OnlySink {
    #[inline]
    pub const fn new() -> Self {
        Self {
            crc: Crc32Hasher::new(),
            len: 0,
        }
    }

    #[inline]
    pub const fn len(&self) -> u32 {
        self.len
    }

    #[inline]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub const fn finalize(&self) -> u32 {
        self.crc.finalize()
    }
}

impl Default for Crc32OnlySink {
    fn default() -> Self {
        Self::new()
    }
}

impl ByteSink for Crc32OnlySink {
    type Error = core::convert::Infallible;

    #[inline]
    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error> {
        self.crc.update_byte(byte);
        self.len = self.len.wrapping_add(1);
        Ok(())
    }

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.crc.update(bytes);
        self.len = self.len.wrapping_add(bytes.len() as u32);
        Ok(())
    }
}

/// Wrapper sink forwarding bytes to `inner` while maintaining an incremental CRC-32 and byte count.
pub struct CrcCountingSink<'a, S> {
    inner: &'a mut S,
    crc: Crc32Hasher,
    len: u32,
}

impl<'a, S: ByteSink> CrcCountingSink<'a, S> {
    #[inline]
    pub fn new(inner: &'a mut S) -> Self {
        Self {
            inner,
            crc: Crc32Hasher::new(),
            len: 0,
        }
    }

    #[inline]
    pub fn len(&self) -> u32 {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub fn finalize_crc(&self) -> u32 {
        self.crc.finalize()
    }
}

impl<S: ByteSink> ByteSink for CrcCountingSink<'_, S> {
    type Error = S::Error;

    #[inline]
    fn write_byte(&mut self, byte: u8) -> Result<(), Self::Error> {
        self.inner.write_byte(byte)?;
        self.crc.update_byte(byte);
        self.len = self.len.wrapping_add(1);
        Ok(())
    }

    #[inline]
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.inner.write_all(bytes)?;
        self.crc.update(bytes);
        self.len = self.len.wrapping_add(bytes.len() as u32);
        Ok(())
    }
}

#[inline]
pub fn write_uvarint_to_sink<S: ByteSink>(sink: &mut S, mut v: u64) -> Result<(), S::Error> {
    while v >= 0x80 {
        sink.write_byte(((v as u8) & 0x7F) | 0x80)?;
        v >>= 7;
    }
    sink.write_byte(v as u8)
}

#[inline]
pub fn write_svarint_to_sink<S: ByteSink>(sink: &mut S, v: i64) -> Result<(), S::Error> {
    let zz = ((v << 1) ^ (v >> 63)) as u64;
    write_uvarint_to_sink(sink, zz)
}

#[cfg(feature = "alloc")]
#[inline]
pub fn write_uvarint_u64(out: &mut Vec<u8>, v: u64) {
    let Ok(()) = write_uvarint_to_sink(out, v);
}

#[cfg(feature = "alloc")]
#[inline]
pub fn write_svarint_i64(out: &mut Vec<u8>, v: i64) {
    let Ok(()) = write_svarint_to_sink(out, v);
}

#[cfg(feature = "decode")]
#[inline]
pub fn read_uvarint_u64(bytes: &[u8], pos: &mut usize) -> Result<u64, Gpsl0Error> {
    let mut val: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *pos >= bytes.len() {
            return Err(Gpsl0Error::Truncated("truncated varint".into()));
        }
        let b = bytes[*pos];
        *pos += 1;
        if shift >= 63 && b > 1 {
            return Err(Gpsl0Error::BadIndex("varint overflow".into()));
        }
        val |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Ok(val);
        }
        shift += 7;
        if shift >= 64 {
            return Err(Gpsl0Error::BadIndex("varint too long".into()));
        }
    }
}

#[cfg(feature = "decode")]
#[inline]
pub fn read_svarint_i64(bytes: &[u8], pos: &mut usize) -> Result<i64, Gpsl0Error> {
    let zz = read_uvarint_u64(bytes, pos)?;
    Ok(((zz >> 1) as i64) ^ (-((zz & 1) as i64)))
}

const fn make_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0usize;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            if (c & 1) != 0 {
                c = 0xEDB8_8320 ^ (c >> 1);
            } else {
                c >>= 1;
            }
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

const CRC_TABLE: [u32; 256] = make_crc_table();

/// Standard CRC-32 (IEEE 802.3).
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c = CRC_TABLE[((c ^ (b as u32)) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

#[cfg(feature = "decode")]
#[inline]
pub fn read_u16_le(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}

#[cfg(feature = "decode")]
#[inline]
pub fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

#[cfg(feature = "decode")]
#[inline]
pub fn read_i32_le(bytes: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

#[inline]
pub fn write_u16_le(out: &mut [u8], off: usize, v: u16) {
    out[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

#[inline]
pub fn write_u32_le(out: &mut [u8], off: usize, v: u32) {
    out[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

#[cfg(feature = "alloc")]
#[inline]
pub fn write_i32_le(out: &mut [u8], off: usize, v: i32) {
    out[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gpsl0BlockEntry {
    pub start_ts: u32,
    pub end_ts: u32,
    pub point_count: u32,
    pub byte_offset: u32,
    pub byte_length: u32,
    pub crc32: u32,
}

#[cfg(feature = "v1")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gpsl0HeaderV1 {
    pub version: u16,
    pub tier0: bool,
    pub has_alt: bool,
    pub alt_damped: bool,
    pub coord_mode: u8,
    pub coord_quantum: u32,
    pub alt_quantum: u32,
    pub n_points: u32,
    pub block_points: u32,
    pub sync_blocks: u32,
    pub n_blocks: u32,
    pub model_id: u32,
    pub header_crc32: u32,
    pub index_crc32: u32,
}

#[cfg(feature = "decode")]
pub fn peek_version(bytes: &[u8]) -> Result<u16, Gpsl0Error> {
    if bytes.len() < 10 {
        return Err(Gpsl0Error::Truncated(format!(
            "header too short ({} bytes)",
            bytes.len()
        )));
    }
    if bytes[..8] != MAGIC {
        return Err(Gpsl0Error::BadMagic);
    }
    Ok(read_u16_le(bytes, 8))
}

#[cfg(feature = "v1")]
pub fn write_v1_header(out: &mut [u8], h: &Gpsl0HeaderV1) {
    out[0..8].copy_from_slice(&MAGIC);
    write_u16_le(out, 8, h.version);
    let mut flags: u16 = 0;
    if h.tier0 {
        flags |= 1;
    }
    if h.has_alt {
        flags |= 2;
    }
    if h.alt_damped {
        flags |= 4;
    }
    flags |= ((h.coord_mode as u16) & 3) << 3;
    write_u16_le(out, 10, flags);
    write_u32_le(out, 12, h.coord_quantum);
    write_u32_le(out, 16, h.alt_quantum);
    write_u32_le(out, 20, h.n_points);
    write_u32_le(out, 24, h.block_points);
    write_u32_le(out, 28, h.sync_blocks);
    write_u32_le(out, 32, h.n_blocks);
    write_u32_le(out, 36, h.model_id);
    let hcrc = crc32(&out[0..40]);
    write_u32_le(out, 40, hcrc);
    write_u32_le(out, 44, h.index_crc32);
}

#[cfg(all(feature = "v1", feature = "decode"))]
pub fn read_v1_header(bytes: &[u8]) -> Result<Gpsl0HeaderV1, Gpsl0Error> {
    if bytes.len() < HEADER_SIZE_V1 {
        return Err(Gpsl0Error::Truncated(format!(
            "truncated header ({} < {})",
            bytes.len(),
            HEADER_SIZE_V1
        )));
    }
    if bytes[..8] != MAGIC {
        return Err(Gpsl0Error::BadMagic);
    }
    let version = read_u16_le(bytes, 8);
    if version != 1 {
        return Err(Gpsl0Error::UnsupportedVersion(version));
    }
    let expected_crc = read_u32_le(bytes, 40);
    let actual_crc = crc32(&bytes[0..40]);
    if expected_crc != actual_crc {
        return Err(Gpsl0Error::CrcMismatch(format!(
            "header crc mismatch (got 0x{actual_crc:08x}, want 0x{expected_crc:08x})"
        )));
    }
    let flag_bits = read_u16_le(bytes, 10);
    if (flag_bits & !0x1F) != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "unknown header flags 0x{flag_bits:04x}"
        )));
    }
    let coord_mode = ((flag_bits >> 3) & 3) as u8;
    if coord_mode > 2 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "reserved coord_mode {coord_mode}"
        )));
    }
    let coord_quantum = read_u32_le(bytes, 12);
    if coord_quantum < 1 || coord_quantum > 10_000_000 || 10_000_000 % coord_quantum != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "bad coord_quantum {coord_quantum}"
        )));
    }
    let alt_quantum = read_u32_le(bytes, 16);
    if alt_quantum < 1 || 10 % alt_quantum != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "bad alt_quantum {alt_quantum}"
        )));
    }
    let n_points = read_u32_le(bytes, 20);
    let block_points = read_u32_le(bytes, 24);
    let sync_blocks = read_u32_le(bytes, 28);
    let n_blocks = read_u32_le(bytes, 32);
    let model_id = read_u32_le(bytes, 36);
    let index_crc32 = read_u32_le(bytes, 44);

    if block_points == 0 || block_points > (1 << 20) {
        return Err(Gpsl0Error::BadIndex(format!(
            "bad block_points {block_points}"
        )));
    }
    if n_points > (1 << 30) {
        return Err(Gpsl0Error::BadIndex(format!("bad n_points {n_points}")));
    }
    let max_index_bytes = (n_blocks as usize)
        .checked_mul(INDEX_ENTRY_SIZE_V1)
        .ok_or_else(|| Gpsl0Error::BadIndex("n_blocks overflow".into()))?;
    if n_blocks > (1 << 22)
        || HEADER_SIZE_V1
            .checked_add(max_index_bytes)
            .map_or(true, |end| end > bytes.len())
    {
        return Err(Gpsl0Error::BadIndex(format!("bad n_blocks {n_blocks}")));
    }
    let expected_blocks = if n_points == 0 {
        0
    } else {
        n_points.div_ceil(block_points)
    };
    if n_blocks != expected_blocks {
        return Err(Gpsl0Error::BadIndex(format!(
            "n_blocks {n_blocks} does not match ceil({n_points}/{block_points})={expected_blocks}"
        )));
    }
    if sync_blocks != 0 && sync_blocks > n_blocks {
        return Err(Gpsl0Error::BadIndex(format!(
            "bad sync_blocks {sync_blocks} for {n_blocks} blocks"
        )));
    }

    Ok(Gpsl0HeaderV1 {
        version,
        tier0: (flag_bits & 1) != 0,
        has_alt: (flag_bits & 2) != 0,
        alt_damped: (flag_bits & 4) != 0,
        coord_mode,
        coord_quantum,
        alt_quantum,
        n_points,
        block_points,
        sync_blocks,
        n_blocks,
        model_id,
        header_crc32: expected_crc,
        index_crc32,
    })
}

#[cfg(all(feature = "v1", feature = "decode"))]
pub fn read_v1_block_index(
    bytes: &[u8],
    header: &Gpsl0HeaderV1,
) -> Result<Vec<Gpsl0BlockEntry>, Gpsl0Error> {
    let n_blocks = header.n_blocks as usize;
    let index_end = HEADER_SIZE_V1 + n_blocks * INDEX_ENTRY_SIZE_V1;
    if index_end > bytes.len() {
        return Err(Gpsl0Error::Truncated("truncated block index".into()));
    }
    let actual_index_crc = crc32(&bytes[HEADER_SIZE_V1..index_end]);
    if actual_index_crc != header.index_crc32 {
        return Err(Gpsl0Error::CrcMismatch(format!(
            "block index crc mismatch (got 0x{actual_index_crc:08x}, want 0x{:08x})",
            header.index_crc32
        )));
    }

    let mut entries = Vec::with_capacity(n_blocks);
    let mut off = HEADER_SIZE_V1;
    let mut expect_points: u64 = 0;
    let mut prev_payload_end = index_end;

    for i in 0..n_blocks {
        let start_ts = read_u32_le(bytes, off);
        let end_ts = read_u32_le(bytes, off + 4);
        let point_count = read_u32_le(bytes, off + 8);
        let byte_offset = read_u32_le(bytes, off + 12);
        let byte_length = read_u32_le(bytes, off + 16);
        let block_crc = read_u32_le(bytes, off + 20);
        off += INDEX_ENTRY_SIZE_V1;

        if point_count == 0 || point_count > header.block_points {
            return Err(Gpsl0Error::BadIndex(format!(
                "block {i} bad point_count {point_count}"
            )));
        }
        if end_ts < start_ts {
            return Err(Gpsl0Error::BadIndex(format!(
                "block {i} end_ts before start_ts"
            )));
        }
        let b_off = byte_offset as usize;
        let b_len = byte_length as usize;
        let b_end = b_off
            .checked_add(b_len)
            .ok_or_else(|| Gpsl0Error::BadIndex(format!("block {i} offset+length overflow")))?;
        if b_off < prev_payload_end || b_end > bytes.len() {
            return Err(Gpsl0Error::BadIndex(format!(
                "block {i} payload out of range or overlapping"
            )));
        }
        prev_payload_end = b_end;
        expect_points += point_count as u64;
        entries.push(Gpsl0BlockEntry {
            start_ts,
            end_ts,
            point_count,
            byte_offset,
            byte_length,
            crc32: block_crc,
        });
    }

    if expect_points != header.n_points as u64 {
        return Err(Gpsl0Error::BadIndex(format!(
            "block point counts sum to {expect_points}, header says {}",
            header.n_points
        )));
    }
    Ok(entries)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gpsl0HeaderV2 {
    pub version: u16,
    pub tier0: bool,
    pub has_alt: bool,
    pub alt_damped: bool,
    pub coord_mode: u8,
    pub coord_quantum: u32,
    pub alt_quantum: u32,
    pub n_points: u32,
    pub block_points: u32,
    pub sync_blocks: u32,
    pub n_blocks: u32,
    pub model_id: u32,
    pub header_crc32: u32,
    pub index_crc32: u32,
}

pub fn write_v2_header(out: &mut [u8], h: &Gpsl0HeaderV2) {
    out[0..8].copy_from_slice(&MAGIC);
    write_u16_le(out, 8, h.version);
    let mut flags: u16 = 0;
    if h.tier0 {
        flags |= 1;
    }
    if h.has_alt {
        flags |= 2;
    }
    if h.alt_damped {
        flags |= 4;
    }
    flags |= ((h.coord_mode as u16) & 3) << 3;
    write_u16_le(out, 10, flags);
    write_u32_le(out, 12, h.coord_quantum);
    write_u32_le(out, 16, h.n_points);
    write_u32_le(out, 20, h.block_points);
    write_u16_le(out, 24, h.sync_blocks as u16);
    out[26] = h.alt_quantum as u8;
    out[27] = h.model_id as u8;
    let hcrc = crc32(&out[0..28]);
    write_u32_le(out, 28, hcrc);
    write_u32_le(out, 32, h.index_crc32);
}

#[cfg(feature = "decode")]
pub fn read_v2_header(bytes: &[u8]) -> Result<Gpsl0HeaderV2, Gpsl0Error> {
    if bytes.len() < HEADER_SIZE_V2 {
        return Err(Gpsl0Error::Truncated(format!(
            "truncated v2 header ({} < {})",
            bytes.len(),
            HEADER_SIZE_V2
        )));
    }
    if bytes[..8] != MAGIC {
        return Err(Gpsl0Error::BadMagic);
    }
    let version = read_u16_le(bytes, 8);
    if version != 2 {
        return Err(Gpsl0Error::UnsupportedVersion(version));
    }
    let expected_crc = read_u32_le(bytes, 28);
    let actual_crc = crc32(&bytes[0..28]);
    if expected_crc != actual_crc {
        return Err(Gpsl0Error::CrcMismatch(format!(
            "header crc mismatch (got 0x{actual_crc:08x}, want 0x{expected_crc:08x})"
        )));
    }
    let flag_bits = read_u16_le(bytes, 10);
    if (flag_bits & !0x1F) != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "unknown header flags 0x{flag_bits:04x}"
        )));
    }
    let coord_mode = ((flag_bits >> 3) & 3) as u8;
    // v2 reserves coord_mode 0=tn, 1=naive, 2=tn-clamped/damped, 3=d1
    let coord_quantum = read_u32_le(bytes, 12);
    if coord_quantum < 1 || coord_quantum > 10_000_000 || 10_000_000 % coord_quantum != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "bad coord_quantum {coord_quantum}"
        )));
    }
    let n_points = read_u32_le(bytes, 16);
    let block_points = read_u32_le(bytes, 20);
    let sync_blocks = read_u16_le(bytes, 24) as u32;
    let alt_quantum = bytes[26] as u32;
    let model_id = bytes[27] as u32;
    let index_crc32 = read_u32_le(bytes, 32);

    if alt_quantum < 1 || 10 % alt_quantum != 0 {
        return Err(Gpsl0Error::CorruptHeader(format!(
            "bad alt_quantum {alt_quantum}"
        )));
    }
    if block_points < 2 || block_points > (1 << 20) {
        return Err(Gpsl0Error::BadIndex(format!(
            "bad block_points {block_points}"
        )));
    }
    if n_points > (1 << 30) {
        return Err(Gpsl0Error::BadIndex(format!("bad n_points {n_points}")));
    }
    let n_blocks = if n_points == 0 {
        0
    } else {
        n_points.div_ceil(block_points)
    };
    if n_blocks > (1 << 22) {
        return Err(Gpsl0Error::BadIndex(format!("bad n_blocks {n_blocks}")));
    }
    if n_blocks > 0 {
        let min_index_bytes = 10usize.saturating_add((n_blocks as usize - 1).saturating_mul(7));
        if HEADER_SIZE_V2.saturating_add(min_index_bytes) > bytes.len() {
            return Err(Gpsl0Error::BadIndex(format!(
                "n_blocks {n_blocks} exceeds file size {}",
                bytes.len()
            )));
        }
    }
    if sync_blocks != 0 && sync_blocks > n_blocks {
        return Err(Gpsl0Error::BadIndex(format!(
            "bad sync_blocks {sync_blocks} for {n_blocks} blocks"
        )));
    }

    Ok(Gpsl0HeaderV2 {
        version,
        tier0: (flag_bits & 1) != 0,
        has_alt: (flag_bits & 2) != 0,
        alt_damped: (flag_bits & 4) != 0,
        coord_mode,
        coord_quantum,
        alt_quantum,
        n_points,
        block_points,
        sync_blocks,
        n_blocks,
        model_id,
        header_crc32: expected_crc,
        index_crc32,
    })
}

pub fn encode_v2_block_index_to_sink<S: ByteSink>(
    entries: &[Gpsl0BlockEntry],
    sink: &mut S,
) -> Result<(), S::Error> {
    let mut prev_end_ts: i64 = 0;
    for (b, e) in entries.iter().enumerate() {
        if b == 0 {
            sink.write_all(&e.start_ts.to_le_bytes())?;
        } else {
            write_svarint_to_sink(sink, (e.start_ts as i64) - prev_end_ts)?;
        }
        let dur = (e.end_ts as u64).saturating_sub(e.start_ts as u64);
        write_uvarint_to_sink(sink, dur)?;
        write_uvarint_to_sink(sink, e.byte_length as u64)?;
        sink.write_all(&e.crc32.to_le_bytes())?;
        prev_end_ts = e.end_ts as i64;
    }
    Ok(())
}

/// Computes `index_crc32`, fills `header.index_crc32`, and writes the 36-byte v2 header
/// followed immediately by the delta-varint block index into `sink` without heap allocation.
pub fn write_v2_header_and_index<S: ByteSink>(
    header: &mut Gpsl0HeaderV2,
    entries: &[Gpsl0BlockEntry],
    sink: &mut S,
) -> Result<(), S::Error> {
    let mut crc_sink = Crc32OnlySink::new();
    let Ok(()) = encode_v2_block_index_to_sink(entries, &mut crc_sink);
    header.index_crc32 = crc_sink.finalize();
    let mut hdr_buf = [0u8; HEADER_SIZE_V2];
    write_v2_header(&mut hdr_buf, header);
    sink.write_all(&hdr_buf)?;
    encode_v2_block_index_to_sink(entries, sink)
}

#[cfg(feature = "alloc")]
pub fn encode_v2_block_index(entries: &[Gpsl0BlockEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(entries.len() * 12);
    let Ok(()) = encode_v2_block_index_to_sink(entries, &mut out);
    out
}

#[cfg(feature = "decode")]
pub fn read_v2_block_index(
    bytes: &[u8],
    header: &Gpsl0HeaderV2,
) -> Result<(Vec<Gpsl0BlockEntry>, usize), Gpsl0Error> {
    let n_blocks = header.n_blocks as usize;
    let mut pos = HEADER_SIZE_V2;
    let mut raw_entries = Vec::with_capacity(n_blocks);
    let mut prev_end_ts: i64 = 0;
    let mut remaining_points = header.n_points;

    for b in 0..n_blocks {
        let start_ts: u32 = if b == 0 {
            if pos + 4 > bytes.len() {
                return Err(Gpsl0Error::Truncated("truncated v2 index start_ts".into()));
            }
            let v = read_u32_le(bytes, pos);
            pos += 4;
            v
        } else {
            let delta = read_svarint_i64(bytes, &mut pos)?;
            let ts = prev_end_ts + delta;
            if ts < 0 || ts > (u32::MAX as i64) {
                return Err(Gpsl0Error::BadIndex(format!("block {b} invalid start_ts")));
            }
            ts as u32
        };
        let dur = read_uvarint_u64(bytes, &mut pos)?;
        let end_ts64 = (start_ts as u64)
            .checked_add(dur)
            .ok_or_else(|| Gpsl0Error::BadIndex(format!("block {b} end_ts overflow")))?;
        if end_ts64 > (u32::MAX as u64) {
            return Err(Gpsl0Error::BadIndex(format!("block {b} end_ts out of range")));
        }
        let end_ts = end_ts64 as u32;
        let byte_len_u64 = read_uvarint_u64(bytes, &mut pos)?;
        if byte_len_u64 == 0 || byte_len_u64 > (bytes.len() as u64) {
            return Err(Gpsl0Error::BadIndex(format!("block {b} bad byte_length")));
        }
        if pos + 4 > bytes.len() {
            return Err(Gpsl0Error::Truncated("truncated v2 index crc32".into()));
        }
        let crc = read_u32_le(bytes, pos);
        pos += 4;

        let pc = remaining_points.min(header.block_points);
        remaining_points -= pc;
        prev_end_ts = end_ts as i64;

        raw_entries.push((start_ts, end_ts, pc, byte_len_u64 as usize, crc));
    }

    if remaining_points != 0 {
        return Err(Gpsl0Error::BadIndex("v2 block point count mismatch".into()));
    }

    let index_end = pos;
    let actual_index_crc = crc32(&bytes[HEADER_SIZE_V2..index_end]);
    if actual_index_crc != header.index_crc32 {
        return Err(Gpsl0Error::CrcMismatch(format!(
            "block index crc mismatch (got 0x{actual_index_crc:08x}, want 0x{:08x})",
            header.index_crc32
        )));
    }

    let mut entries = Vec::with_capacity(n_blocks);
    let mut payload_off = index_end;
    for (b, (start_ts, end_ts, point_count, byte_len, crc)) in raw_entries.into_iter().enumerate() {
        let payload_end = payload_off
            .checked_add(byte_len)
            .ok_or_else(|| Gpsl0Error::BadIndex(format!("block {b} offset overflow")))?;
        if payload_end > bytes.len() {
            return Err(Gpsl0Error::Truncated(format!(
                "block {b} payload truncated ({payload_end} > {})",
                bytes.len()
            )));
        }
        entries.push(Gpsl0BlockEntry {
            start_ts,
            end_ts,
            point_count,
            byte_offset: payload_off as u32,
            byte_length: byte_len as u32,
            crc32: crc,
        });
        payload_off = payload_end;
    }

    Ok((entries, index_end))
}
