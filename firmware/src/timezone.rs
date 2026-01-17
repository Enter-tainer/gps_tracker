//! Timezone lookup from GPS coordinates.
//!
//! Uses a 1°×1° grid with RLE compression and row index for fast lookup.
//! Data files:
//!   - tz_offsets.bin: i16[] UTC offsets in minutes
//!   - tz_row_index.bin: u16[] byte offset into RLE data for each latitude row
//!   - tz_rle.bin: (count, offset_id)[] RLE encoded grid data

/// UTC offset table: offset_id -> minutes from UTC (i16)
static OFFSETS: &[u8] = include_bytes!("../data/tz_offsets.bin");

/// Row index: lat_idx -> byte offset into RLE data (u16)
static ROW_INDEX: &[u8] = include_bytes!("../data/tz_row_index.bin");

/// RLE encoded grid: (count, offset_id) pairs
static RLE: &[u8] = include_bytes!("../data/tz_rle.bin");

/// Look up UTC offset in minutes for given coordinates.
/// Returns 0 (UTC) for ocean or invalid coordinates.
pub fn lookup_offset_minutes(lat: f32, lon: f32) -> i16 {
    // Clamp and convert to grid indices
    let lat_idx = ((lat + 90.0) as i32).clamp(0, 179) as usize;
    let lon_idx = ((lon + 180.0) as i32).clamp(0, 359) as usize;

    // Get row offset from index table
    let row_offset = u16::from_le_bytes([
        ROW_INDEX[lat_idx * 2],
        ROW_INDEX[lat_idx * 2 + 1],
    ]) as usize;

    // Decode RLE to find offset_id at lon_idx
    let mut pos = row_offset;
    let mut col = 0usize;
    let offset_id = loop {
        let count = RLE[pos] as usize;
        let id = RLE[pos + 1];

        if col + count > lon_idx {
            break id;
        }

        col += count;
        pos += 2;

        // Safety check
        if col >= 360 {
            break 0;
        }
    };

    // Look up offset in minutes
    let off_idx = offset_id as usize * 2;
    if off_idx + 1 < OFFSETS.len() {
        i16::from_le_bytes([OFFSETS[off_idx], OFFSETS[off_idx + 1]])
    } else {
        0
    }
}

/// UTC offset with hours and minutes parts.
#[derive(Clone, Copy, Debug)]
pub struct UtcOffset {
    /// Total offset in minutes from UTC (can be negative).
    pub total_minutes: i16,
}

impl UtcOffset {
    /// Create from total minutes.
    pub const fn from_minutes(minutes: i16) -> Self {
        Self { total_minutes: minutes }
    }

    /// Get hours part (can be negative).
    pub const fn hours(&self) -> i8 {
        (self.total_minutes / 60) as i8
    }

    /// Get minutes part (always 0-59).
    pub const fn minutes(&self) -> u8 {
        (self.total_minutes.abs() % 60) as u8
    }

    /// Check if offset is positive or zero.
    pub const fn is_positive(&self) -> bool {
        self.total_minutes >= 0
    }
}

/// Cached timezone lookup to avoid recalculating when position hasn't changed much.
pub struct TzCache {
    last_lat: f32,
    last_lon: f32,
    cached_offset: i16,
    valid: bool,
}

impl TzCache {
    /// Distance threshold in degrees (~55km) before recalculating.
    const THRESHOLD: f32 = 0.5;

    pub const fn new() -> Self {
        Self {
            last_lat: 0.0,
            last_lon: 0.0,
            cached_offset: 0,
            valid: false,
        }
    }

    /// Get UTC offset for coordinates, using cache if position hasn't changed much.
    pub fn get_offset(&mut self, lat: f32, lon: f32) -> UtcOffset {
        if !self.valid
            || (lat - self.last_lat).abs() > Self::THRESHOLD
            || (lon - self.last_lon).abs() > Self::THRESHOLD
        {
            self.cached_offset = lookup_offset_minutes(lat, lon);
            self.last_lat = lat;
            self.last_lon = lon;
            self.valid = true;
        }

        UtcOffset::from_minutes(self.cached_offset)
    }

    /// Invalidate cache (force recalculation on next lookup).
    #[allow(dead_code)]
    pub fn invalidate(&mut self) {
        self.valid = false;
    }
}
