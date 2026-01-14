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
