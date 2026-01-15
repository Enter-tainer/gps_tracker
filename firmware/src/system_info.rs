use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpsState {
    S0Initializing = 0,
    S1GpsSearchingFix = 1,
    S2IdleGpsOff = 2,
    S3TrackingFixed = 3,
    S4AnalyzingStillness = 4,
    S5AgnssProcessing = 5,
}

impl Default for GpsState {
    fn default() -> Self {
        Self::S0Initializing
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SystemInfo {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: f32,
    pub satellites: u32,
    pub hdop: f32,
    pub speed: f32,
    pub course: f32,
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub location_valid: bool,
    pub date_time_valid: bool,
    pub battery_voltage: f32,
    pub gps_state: GpsState,
    pub is_stationary: bool,
}

impl SystemInfo {
    pub const fn new() -> Self {
        Self {
            latitude: 0.0,
            longitude: 0.0,
            altitude: 0.0,
            satellites: 0,
            hdop: 99.9,
            speed: 0.0,
            course: 0.0,
            year: 0,
            month: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            location_valid: false,
            date_time_valid: false,
            battery_voltage: -1.0,
            gps_state: GpsState::S0Initializing,
            is_stationary: false,
        }
    }
}

pub static SYSTEM_INFO: Mutex<CriticalSectionRawMutex, SystemInfo> =
    Mutex::new(SystemInfo::new());

pub const SYSTEM_INFO_SERIALIZED_LEN: usize = 50;

pub fn serialize_system_info(
    info: &SystemInfo,
    out: &mut [u8; SYSTEM_INFO_SERIALIZED_LEN],
) -> usize {
    let mut offset = 0;

    // Keep packing order identical to legacy processGetSysInfo().
    out[offset..offset + 8].copy_from_slice(&info.latitude.to_le_bytes());
    offset += 8;
    out[offset..offset + 8].copy_from_slice(&info.longitude.to_le_bytes());
    offset += 8;
    out[offset..offset + 4].copy_from_slice(&info.altitude.to_le_bytes());
    offset += 4;
    out[offset..offset + 4].copy_from_slice(&info.satellites.to_le_bytes());
    offset += 4;
    out[offset..offset + 4].copy_from_slice(&info.hdop.to_le_bytes());
    offset += 4;
    out[offset..offset + 4].copy_from_slice(&info.speed.to_le_bytes());
    offset += 4;
    out[offset..offset + 4].copy_from_slice(&info.course.to_le_bytes());
    offset += 4;
    out[offset..offset + 2].copy_from_slice(&info.year.to_le_bytes());
    offset += 2;
    out[offset] = info.month;
    offset += 1;
    out[offset] = info.day;
    offset += 1;
    out[offset] = info.hour;
    offset += 1;
    out[offset] = info.minute;
    offset += 1;
    out[offset] = info.second;
    offset += 1;
    out[offset] = u8::from(info.location_valid);
    offset += 1;
    out[offset] = u8::from(info.date_time_valid);
    offset += 1;
    out[offset..offset + 4].copy_from_slice(&info.battery_voltage.to_le_bytes());
    offset += 4;
    out[offset] = info.gps_state as u8;
    offset += 1;

    offset
}
