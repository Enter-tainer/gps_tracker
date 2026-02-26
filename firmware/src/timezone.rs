//! Timezone lookup from GPS coordinates.
//!
//! Uses a 1x1 degree grid with RLE compression and row index for fast lookup.
//! Data files:
//!   - tz_row_index.bin: u16[] byte offset into RLE data for each latitude row
//!   - tz_rle.bin: (count, tz_id)[] RLE encoded grid data
//!   - tz_transition_index.bin: per-tz_id base offset + transition index
//!   - tz_transitions.bin: UTC transition timestamps and offsets

#[cfg(feature = "host-test")]
const TZ_ROW_INDEX: &[u8] = include_bytes!(concat!(env!("TZ_DATA_DIR"), "/tz_row_index.bin"));
#[cfg(not(feature = "host-test"))]
const TZ_ROW_INDEX: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/data/tz_row_index.bin"
));

#[cfg(feature = "host-test")]
const TZ_RLE: &[u8] = include_bytes!(concat!(env!("TZ_DATA_DIR"), "/tz_rle.bin"));
#[cfg(not(feature = "host-test"))]
const TZ_RLE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/tz_rle.bin"));

#[cfg(feature = "host-test")]
const TZ_TRANSITION_INDEX: &[u8] =
    include_bytes!(concat!(env!("TZ_DATA_DIR"), "/tz_transition_index.bin"));
#[cfg(not(feature = "host-test"))]
const TZ_TRANSITION_INDEX: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/data/tz_transition_index.bin"
));

#[cfg(feature = "host-test")]
const TZ_TRANSITIONS: &[u8] = include_bytes!(concat!(env!("TZ_DATA_DIR"), "/tz_transitions.bin"));
#[cfg(not(feature = "host-test"))]
const TZ_TRANSITIONS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/data/tz_transitions.bin"
));

const ROWS: usize = 180;
const COLS: usize = 360;
const ROW_INDEX_ENTRY_LEN: usize = 2;
const TZ_INDEX_ENTRY_LEN: usize = 8;
const TZ_TRANSITION_ENTRY_LEN: usize = 6;

#[derive(Clone, Copy)]
struct TzIndexEntry {
    base_offset: i16,
    first_transition: u32,
    transition_count: u16,
}

fn tz_index_entry(tz_id: u16) -> Option<TzIndexEntry> {
    let idx = tz_id as usize;
    let base = idx.checked_mul(TZ_INDEX_ENTRY_LEN)?;
    if base + TZ_INDEX_ENTRY_LEN > TZ_TRANSITION_INDEX.len() {
        return None;
    }
    let base_offset =
        i16::from_le_bytes([TZ_TRANSITION_INDEX[base], TZ_TRANSITION_INDEX[base + 1]]);
    let first_transition = u32::from_le_bytes([
        TZ_TRANSITION_INDEX[base + 2],
        TZ_TRANSITION_INDEX[base + 3],
        TZ_TRANSITION_INDEX[base + 4],
        TZ_TRANSITION_INDEX[base + 5],
    ]);
    let transition_count =
        u16::from_le_bytes([TZ_TRANSITION_INDEX[base + 6], TZ_TRANSITION_INDEX[base + 7]]);
    Some(TzIndexEntry {
        base_offset,
        first_transition,
        transition_count,
    })
}

fn transition_at(index: usize) -> Option<(u32, i16)> {
    let base = index.checked_mul(TZ_TRANSITION_ENTRY_LEN)?;
    if base + TZ_TRANSITION_ENTRY_LEN > TZ_TRANSITIONS.len() {
        return None;
    }
    let ts = u32::from_le_bytes([
        TZ_TRANSITIONS[base],
        TZ_TRANSITIONS[base + 1],
        TZ_TRANSITIONS[base + 2],
        TZ_TRANSITIONS[base + 3],
    ]);
    let offset = i16::from_le_bytes([TZ_TRANSITIONS[base + 4], TZ_TRANSITIONS[base + 5]]);
    Some((ts, offset))
}

fn lookup_tz_id(lat: f32, lon: f32) -> u16 {
    if !(lat >= -90.0 && lat < 90.0 && lon >= -180.0 && lon < 180.0) {
        return 0;
    }
    let lat_idx = (lat + 90.0) as usize;
    let lon_idx = (lon + 180.0) as usize;
    if lat_idx >= ROWS || lon_idx >= COLS {
        return 0;
    }
    let row_offset_pos = lat_idx * ROW_INDEX_ENTRY_LEN;
    if row_offset_pos + ROW_INDEX_ENTRY_LEN > TZ_ROW_INDEX.len() {
        return 0;
    }
    let row_offset = u16::from_le_bytes([
        TZ_ROW_INDEX[row_offset_pos],
        TZ_ROW_INDEX[row_offset_pos + 1],
    ]) as usize;

    let mut pos = row_offset;
    let mut col = 0usize;
    while col < COLS {
        if pos + 3 > TZ_RLE.len() {
            break;
        }
        let count = TZ_RLE[pos] as usize;
        if count == 0 {
            break;
        }
        let tz_id = u16::from_le_bytes([TZ_RLE[pos + 1], TZ_RLE[pos + 2]]);
        if lon_idx < col + count {
            return tz_id;
        }
        col += count;
        pos += 3;
    }

    0
}

fn lookup_offset_minutes_for_tz(tz_id: u16, utc_timestamp: u32) -> i16 {
    let Some(entry) = tz_index_entry(tz_id) else {
        return 0;
    };
    let count = entry.transition_count as usize;
    if count == 0 {
        return entry.base_offset;
    }

    let first_index = entry.first_transition as usize;
    let Some((first_ts, _)) = transition_at(first_index) else {
        return entry.base_offset;
    };
    if utc_timestamp < first_ts {
        return entry.base_offset;
    }

    let mut lo = 0usize;
    let mut hi = count;
    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        let idx = first_index + mid;
        let Some((ts, _)) = transition_at(idx) else {
            return entry.base_offset;
        };
        if ts <= utc_timestamp {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    let idx = first_index + lo;
    transition_at(idx)
        .map(|(_, offset)| offset)
        .unwrap_or(entry.base_offset)
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
        Self {
            total_minutes: minutes,
        }
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
    cached_tz_id: u16,
    valid: bool,
}

impl TzCache {
    /// Distance threshold in degrees (~55km) before recalculating.
    const THRESHOLD: f32 = 0.5;

    pub const fn new() -> Self {
        Self {
            last_lat: 0.0,
            last_lon: 0.0,
            cached_tz_id: 0,
            valid: false,
        }
    }

    /// Get UTC offset for coordinates and UTC date/time.
    pub fn get_offset(
        &mut self,
        lat: f32,
        lon: f32,
        year: u16,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
    ) -> UtcOffset {
        let Some(timestamp) = date_time_to_unix_timestamp(year, month, day, hour, minute, second)
        else {
            return UtcOffset::from_minutes(0);
        };

        if !self.valid
            || (lat - self.last_lat).abs() > Self::THRESHOLD
            || (lon - self.last_lon).abs() > Self::THRESHOLD
        {
            self.cached_tz_id = lookup_tz_id(lat, lon);
            self.last_lat = lat;
            self.last_lon = lon;
            self.valid = true;
        }

        UtcOffset::from_minutes(lookup_offset_minutes_for_tz(self.cached_tz_id, timestamp))
    }

    /// Invalidate cache (force recalculation on next lookup).
    #[allow(dead_code)]
    pub fn invalidate(&mut self) {
        self.valid = false;
    }
}

pub fn date_time_to_unix_timestamp(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> Option<u32> {
    if year < 1970 || year > 2100 {
        return None;
    }
    if month == 0 || month > 12 {
        return None;
    }
    if hour >= 24 || minute >= 60 || second >= 60 {
        return None;
    }

    let year_minus_one = (year - 1) as u32;
    let leap_years = year_minus_one / 4 - year_minus_one / 100 + year_minus_one / 400;
    let base_year_minus_one = 1969u32;
    let base_leaps =
        base_year_minus_one / 4 - base_year_minus_one / 100 + base_year_minus_one / 400;
    let mut days = (year as u32 - 1970) * 365 + (leap_years - base_leaps);

    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let mut days_in_month = [0u8, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if is_leap {
        days_in_month[2] = 29;
    }
    if day == 0 || day > days_in_month[month as usize] {
        return None;
    }

    for m in 1..month {
        days += days_in_month[m as usize] as u32;
    }
    days += (day as u32).saturating_sub(1);

    let mut seconds_val = days * 86_400;
    seconds_val += hour as u32 * 3_600;
    seconds_val += minute as u32 * 60;
    seconds_val += second as u32;
    Some(seconds_val)
}

#[cfg(test)]
mod tests {
    use super::{date_time_to_unix_timestamp, lookup_offset_minutes_for_tz, lookup_tz_id};

    const SECS_PER_DAY: u32 = 86_400;

    fn ts(year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> u32 {
        date_time_to_unix_timestamp(year, month, day, hour, minute, second).unwrap()
    }

    fn offset_minutes(lat: f32, lon: f32, year: u16, month: u8, day: u8, hour: u8) -> i16 {
        lookup_offset_minutes_for_tz(lookup_tz_id(lat, lon), ts(year, month, day, hour, 0, 0))
    }

    #[test]
    fn unix_epoch_zero() {
        assert_eq!(date_time_to_unix_timestamp(1970, 1, 1, 0, 0, 0), Some(0));
    }

    #[test]
    fn leap_year_2000_feb29() {
        let feb28 = date_time_to_unix_timestamp(2000, 2, 28, 0, 0, 0).unwrap();
        let mar1 = date_time_to_unix_timestamp(2000, 3, 1, 0, 0, 0).unwrap();
        assert_eq!(mar1 - feb28, 2 * SECS_PER_DAY);
    }

    #[test]
    fn non_leap_year_2100() {
        let feb28 = date_time_to_unix_timestamp(2100, 2, 28, 0, 0, 0).unwrap();
        let mar1 = date_time_to_unix_timestamp(2100, 3, 1, 0, 0, 0).unwrap();
        assert_eq!(mar1 - feb28, SECS_PER_DAY);
    }

    #[test]
    fn rejects_invalid_date_time() {
        assert!(date_time_to_unix_timestamp(2024, 0, 1, 0, 0, 0).is_none());
        assert!(date_time_to_unix_timestamp(2024, 13, 1, 0, 0, 0).is_none());
        assert!(date_time_to_unix_timestamp(2024, 2, 30, 0, 0, 0).is_none());
        assert!(date_time_to_unix_timestamp(2024, 1, 1, 24, 0, 0).is_none());
        assert!(date_time_to_unix_timestamp(2024, 1, 1, 0, 60, 0).is_none());
        assert!(date_time_to_unix_timestamp(2024, 1, 1, 0, 0, 60).is_none());
        assert!(date_time_to_unix_timestamp(2101, 1, 1, 0, 0, 0).is_none());
    }

    #[test]
    fn out_of_range_coords_map_to_utc() {
        assert_eq!(lookup_tz_id(-91.0, 0.0), 0);
        assert_eq!(lookup_tz_id(0.0, 181.0), 0);
        assert_eq!(lookup_tz_id(90.0, 0.0), 0);
        assert_eq!(lookup_tz_id(0.0, -180.0), 0);
    }

    #[test]
    fn dst_northern_hemisphere_new_york() {
        let winter = offset_minutes(40.7, -74.0, 2025, 1, 15, 12);
        let summer = offset_minutes(40.7, -74.0, 2025, 7, 1, 12);
        assert_eq!(winter, -300);
        assert_eq!(summer, -240);
    }

    #[test]
    fn dst_northern_hemisphere_london() {
        let winter = offset_minutes(51.5, -0.1, 2025, 1, 15, 12);
        let summer = offset_minutes(51.5, -0.1, 2025, 7, 1, 12);
        assert_eq!(winter, 0);
        assert_eq!(summer, 60);
    }

    #[test]
    fn dst_southern_hemisphere_sydney() {
        let summer = offset_minutes(-33.9, 151.2, 2025, 1, 15, 12);
        let winter = offset_minutes(-33.9, 151.2, 2025, 7, 1, 12);
        assert_eq!(summer, 660);
        assert_eq!(winter, 600);
    }

    #[test]
    fn no_dst_asia_beijing() {
        let winter = offset_minutes(39.9, 116.4, 2025, 1, 15, 12);
        let summer = offset_minutes(39.9, 116.4, 2025, 7, 1, 12);
        assert_eq!(winter, 480);
        assert_eq!(summer, 480);
    }

    #[test]
    fn no_dst_half_hour_kolkata() {
        let winter = offset_minutes(28.6, 77.2, 2025, 1, 15, 12);
        let summer = offset_minutes(28.6, 77.2, 2025, 7, 1, 12);
        assert_eq!(winter, 330);
        assert_eq!(summer, 330);
    }
}
