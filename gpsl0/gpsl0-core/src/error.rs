use core::fmt;

#[cfg(feature = "alloc")]
use alloc::string::String;

/// Errors returned by GPSL0 encoding, decoding, and header inspection.
///
/// Mirrors the error categories specified in `docs/gpsl0_format.md` §8
/// and `docs/gpsl0_v3_format.md` §6.
#[cfg(feature = "alloc")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gpsl0Error {
    Truncated(String),
    BadMagic,
    UnsupportedVersion(u16),
    CrcMismatch(String),
    CorruptHeader(String),
    BadIndex(String),
    UnsupportedModel(u32),
    BadWindow(String),
    InvalidInput(String),
}

#[cfg(not(feature = "alloc"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gpsl0Error {
    Truncated(&'static str),
    BadMagic,
    UnsupportedVersion(u16),
    CrcMismatch(&'static str),
    CorruptHeader(&'static str),
    BadIndex(&'static str),
    UnsupportedModel(u32),
    BadWindow(&'static str),
    InvalidInput(&'static str),
}

impl fmt::Display for Gpsl0Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Gpsl0Error::Truncated(msg) => write!(f, "GPSL0: truncated: {msg}"),
            Gpsl0Error::BadMagic => write!(f, "GPSL0: bad magic"),
            Gpsl0Error::UnsupportedVersion(v) => write!(f, "GPSL0: unsupported version {v}"),
            Gpsl0Error::CrcMismatch(msg) => write!(f, "GPSL0: crc mismatch: {msg}"),
            Gpsl0Error::CorruptHeader(msg) => write!(f, "GPSL0: corrupt header: {msg}"),
            Gpsl0Error::BadIndex(msg) => write!(f, "GPSL0: bad index: {msg}"),
            Gpsl0Error::UnsupportedModel(id) => write!(f, "GPSL0: unsupported model_id {id}"),
            Gpsl0Error::BadWindow(msg) => write!(f, "GPSL0: bad window arguments: {msg}"),
            Gpsl0Error::InvalidInput(msg) => write!(f, "GPSL0: invalid input: {msg}"),
        }
    }
}

impl core::error::Error for Gpsl0Error {}

/// Errors produced by the zero-allocation streaming encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError<E> {
    InvalidInput(&'static str),
    Sink(E),
}

impl<E: fmt::Display> fmt::Display for StreamError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StreamError::InvalidInput(msg) => write!(f, "GPSL0 stream: invalid input: {msg}"),
            StreamError::Sink(e) => write!(f, "GPSL0 stream: sink error: {e}"),
        }
    }
}

impl<E: fmt::Display + fmt::Debug> core::error::Error for StreamError<E> {}
