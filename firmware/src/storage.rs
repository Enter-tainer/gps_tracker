use core::cell::Cell;
use core::cmp::Ordering;

use embassy_nrf::gpio::Output;
use embassy_nrf::spim::Spim;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::{Delay, Instant};
use embedded_hal::spi::{Operation, SpiBus, SpiDevice};
use embedded_sdmmc::{
    DirEntry, Mode, RawDirectory, RawFile, RawVolume, SdCard, ShortFileName, TimeSource,
    Timestamp, VolumeIdx, VolumeManager,
};
use libm::{round, roundf};

const CACHE_SIZE: usize = 4096;
const ENCODER_BUFFER_SIZE: usize = 64;
const FULL_BLOCK_INTERVAL: usize = 64;
const MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_GPX_FILES: usize = 64;
const LOG_EXTENSION: &[u8] = b"GPX";

static SD_LOGGER: Mutex<CriticalSectionRawMutex, Option<SdLogger>> = Mutex::new(None);

pub fn init_sd_logger(spi: Spim<'static>, mut cs: Output<'static>) -> bool {
    cs.set_high();
    if !send_idle_clocks(spi, cs) {
        defmt::warn!("SD idle clock preamble failed");
        return false;
    }
    true
}

pub async fn append_gpx_point(
    timestamp: u32,
    latitude: f64,
    longitude: f64,
    altitude_m: f32,
) -> bool {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return false;
    };
    logger.append_gpx_point(timestamp, latitude, longitude, altitude_m)
}

pub async fn flush_sd_cache() -> bool {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return false;
    };
    logger.flush_cache()
}

fn send_idle_clocks(mut spi: Spim<'static>, mut cs: Output<'static>) -> bool {
    cs.set_high();
    let idle = [0xFFu8; 10];
    if SpiBus::write(&mut spi, &idle).is_err() {
        return false;
    }
    let _ = SpiBus::flush(&mut spi);

    let mut sd_spi = SdSpiDevice::new(spi, cs);
    let delay = Delay;
    let sd_card = SdCard::new(sd_spi, delay);
    let volume_mgr = VolumeManager::new(sd_card, FixedTimeSource);
    let volume = match volume_mgr.open_raw_volume(VolumeIdx(0)) {
        Ok(volume) => volume,
        Err(_) => return false,
    };
    let root_dir = match volume_mgr.open_root_dir(volume) {
        Ok(dir) => dir,
        Err(_) => return false,
    };

    let logger = SdLogger::new(volume_mgr, volume, root_dir);
    if let Ok(mut guard) = SD_LOGGER.try_lock() {
        *guard = Some(logger);
        return true;
    }
    false
}

struct SdLogger {
    volume_mgr: VolumeManager<SdCard<SdSpiDevice, Delay>, FixedTimeSource, 4, 4, 1>,
    volume: RawVolume,
    root_dir: RawDirectory,
    current_file: Option<RawFile>,
    current_date: u32,
    encoder: GpsDataEncoder,
    cache: [u8; CACHE_SIZE],
    cache_len: usize,
    cache_dirty: bool,
    last_timestamp: u32,
    last_nrf_timestamp: u32,
}

impl SdLogger {
    fn new(
        volume_mgr: VolumeManager<SdCard<SdSpiDevice, Delay>, FixedTimeSource, 4, 4, 1>,
        volume: RawVolume,
        root_dir: RawDirectory,
    ) -> Self {
        Self {
            volume_mgr,
            volume,
            root_dir,
            current_file: None,
            current_date: 0,
            encoder: GpsDataEncoder::new(FULL_BLOCK_INTERVAL),
            cache: [0; CACHE_SIZE],
            cache_len: 0,
            cache_dirty: false,
            last_timestamp: 0,
            last_nrf_timestamp: 0,
        }
    }

    fn append_gpx_point(
        &mut self,
        timestamp: u32,
        latitude: f64,
        longitude: f64,
        altitude_m: f32,
    ) -> bool {
        if timestamp == 0 {
            defmt::warn!("GPS log skipped: timestamp is zero");
            return false;
        }

        let now_sec = (Instant::now().as_millis() / 1000) as u32;
        if self.last_timestamp != 0 && self.last_nrf_timestamp != 0 {
            let gps_diff = timestamp as i64 - self.last_timestamp as i64;
            let nrf_diff = now_sec as i64 - self.last_nrf_timestamp as i64;
            if nrf_diff >= 0 && (gps_diff - nrf_diff).abs() > 3600 {
                defmt::warn!("GPS log skipped: timestamp jump detected");
                return false;
            }
        }
        self.last_timestamp = timestamp;
        self.last_nrf_timestamp = now_sec;

        let entry = GpxPointInternal {
            timestamp,
            latitude_scaled_1e5: round_f64(latitude * 1e5) as i32,
            longitude_scaled_1e5: round_f64(longitude * 1e5) as i32,
            altitude_m_scaled_1e1: round_f32(altitude_m * 10.0) as i32,
        };

        if !self.rotate_log_file_if_needed(timestamp) {
            return false;
        }

        let len = self.encoder.encode(entry);
        if self.cache_len + len > self.cache.len() && !self.flush_cache() {
            return false;
        }

        let data = self.encoder.buffer();
        if data.len() != len {
            return false;
        }

        self.cache[self.cache_len..self.cache_len + len].copy_from_slice(data);
        self.cache_len += len;
        self.cache_dirty = true;

        if self.cache_len >= self.cache.len() {
            return self.flush_cache();
        }

        true
    }

    fn flush_cache(&mut self) -> bool {
        if !self.cache_dirty || self.cache_len == 0 {
            return true;
        }

        let Some(file) = self.current_file else {
            return false;
        };

        if self
            .volume_mgr
            .write(file, &self.cache[..self.cache_len])
            .is_err()
        {
            return false;
        }
        if self.volume_mgr.flush_file(file).is_err() {
            return false;
        }

        self.cache_len = 0;
        self.cache_dirty = false;
        true
    }

    fn rotate_log_file_if_needed(&mut self, timestamp: u32) -> bool {
        let Some((year, month, day)) = unix_to_date(timestamp) else {
            return false;
        };
        let new_date = (year as u32) * 10000 + (month as u32) * 100 + (day as u32);

        if new_date == self.current_date && self.current_file.is_some() {
            return true;
        }

        if self.current_file.is_some() {
            let _ = self.flush_cache();
            if let Some(file) = self.current_file.take() {
                let _ = self.volume_mgr.close_file(file);
            }
        }

        self.manage_old_files();

        let filename = build_log_filename(year, month, day);
        let file = match self
            .volume_mgr
            .open_file_in_dir(self.root_dir, filename.as_str(), Mode::ReadWriteCreateOrAppend)
        {
            Ok(file) => file,
            Err(_) => {
                return false;
            }
        };

        self.current_file = Some(file);
        self.current_date = new_date;
        self.encoder.clear();
        true
    }

    fn manage_old_files(&mut self) {
        let mut files: heapless::Vec<GpxFileInfo, MAX_GPX_FILES> = heapless::Vec::new();
        let total = Cell::new(0u64);

        let _ = self.volume_mgr.iterate_dir(self.root_dir, |entry| {
            if entry.attributes.is_directory() {
                return;
            }
            if !is_gpx_entry(entry) {
                return;
            }
            if files.is_full() {
                return;
            }
            files.push(GpxFileInfo::new(entry)).ok();
            total.set(total.get().saturating_add(entry.size as u64));
        });

        let mut total_size = total.get();
        while total_size > MAX_FILE_SIZE_BYTES && !files.is_empty() {
            let oldest_idx = find_oldest_index(&files);
            let file = files.swap_remove(oldest_idx);
            let _ = self
                .volume_mgr
                .delete_file_in_dir(self.root_dir, &file.name);
            total_size = total_size.saturating_sub(file.size as u64);
        }
    }
}

#[derive(Clone)]
struct GpxFileInfo {
    name: ShortFileName,
    size: u32,
}

impl GpxFileInfo {
    fn new(entry: &DirEntry) -> Self {
        Self {
            name: entry.name.clone(),
            size: entry.size,
        }
    }
}

fn find_oldest_index(files: &[GpxFileInfo]) -> usize {
    let mut oldest = 0;
    for (idx, file) in files.iter().enumerate().skip(1) {
        if compare_short_name(&file.name, &files[oldest].name) == Ordering::Less {
            oldest = idx;
        }
    }
    oldest
}

fn compare_short_name(a: &ShortFileName, b: &ShortFileName) -> Ordering {
    let base_cmp = a.base_name().cmp(b.base_name());
    if base_cmp != Ordering::Equal {
        return base_cmp;
    }
    a.extension().cmp(b.extension())
}

fn is_gpx_entry(entry: &DirEntry) -> bool {
    entry.name.extension() == LOG_EXTENSION
}

struct FixedTimeSource;

impl TimeSource for FixedTimeSource {
    fn get_timestamp(&self) -> Timestamp {
        Timestamp::from_calendar(2025, 1, 1, 0, 0, 0).unwrap()
    }
}

struct SdSpiDevice {
    spi: Spim<'static>,
    cs: Output<'static>,
}

impl SdSpiDevice {
    fn new(spi: Spim<'static>, mut cs: Output<'static>) -> Self {
        cs.set_high();
        Self { spi, cs }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SdSpiError {
    Spi(embassy_nrf::spim::Error),
}

impl embedded_hal::spi::Error for SdSpiError {
    fn kind(&self) -> embedded_hal::spi::ErrorKind {
        embedded_hal::spi::ErrorKind::Other
    }
}

impl embedded_hal::spi::ErrorType for SdSpiDevice {
    type Error = SdSpiError;
}

impl SpiDevice<u8> for SdSpiDevice {
    fn transaction(&mut self, operations: &mut [Operation<'_, u8>]) -> Result<(), Self::Error> {
        self.cs.set_low();

        for op in operations {
            let result = match op {
                Operation::Read(buf) => SpiBus::read(&mut self.spi, buf),
                Operation::Write(buf) => SpiBus::write(&mut self.spi, buf),
                Operation::Transfer(read, write) => SpiBus::transfer(&mut self.spi, read, write),
                Operation::TransferInPlace(buf) => SpiBus::transfer_in_place(&mut self.spi, buf),
                Operation::DelayNs(ns) => {
                    embassy_time::block_for(embassy_time::Duration::from_nanos(*ns as u64));
                    Ok(())
                }
            };
            if let Err(err) = result {
                self.cs.set_high();
                return Err(SdSpiError::Spi(err));
            }
        }

        if let Err(err) = SpiBus::flush(&mut self.spi) {
            self.cs.set_high();
            return Err(SdSpiError::Spi(err));
        }

        self.cs.set_high();
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct GpxPointInternal {
    timestamp: u32,
    latitude_scaled_1e5: i32,
    longitude_scaled_1e5: i32,
    altitude_m_scaled_1e1: i32,
}

struct GpsDataEncoder {
    buffer: [u8; ENCODER_BUFFER_SIZE],
    buffer_len: usize,
    previous_point: GpxPointInternal,
    full_block_interval: usize,
    points_since_last_full_block: usize,
    is_first_point: bool,
}

impl GpsDataEncoder {
    fn new(full_block_interval: usize) -> Self {
        Self {
            buffer: [0; ENCODER_BUFFER_SIZE],
            buffer_len: 0,
            previous_point: GpxPointInternal::default(),
            full_block_interval: full_block_interval.max(1),
            points_since_last_full_block: 0,
            is_first_point: true,
        }
    }

    fn clear(&mut self) {
        *self = Self::new(self.full_block_interval);
    }

    fn buffer(&self) -> &[u8] {
        &self.buffer[..self.buffer_len]
    }

    fn encode(&mut self, point: GpxPointInternal) -> usize {
        self.buffer_len = 0;
        let mut use_full = false;

        if self.is_first_point {
            use_full = true;
        } else if self.full_block_interval == 1 {
            use_full = true;
        } else if self.points_since_last_full_block >= self.full_block_interval - 1 {
            use_full = true;
        }

        if use_full {
            self.write_u8(0xFF);
            self.write_u32_le(point.timestamp);
            self.write_i32_le(point.latitude_scaled_1e5);
            self.write_i32_le(point.longitude_scaled_1e5);
            self.write_i32_le(point.altitude_m_scaled_1e1);
            self.points_since_last_full_block = 0;
            self.is_first_point = false;
        } else {
            let delta_timestamp = point.timestamp as i32 - self.previous_point.timestamp as i32;
            let delta_latitude =
                point.latitude_scaled_1e5 - self.previous_point.latitude_scaled_1e5;
            let delta_longitude =
                point.longitude_scaled_1e5 - self.previous_point.longitude_scaled_1e5;
            let delta_altitude =
                point.altitude_m_scaled_1e1 - self.previous_point.altitude_m_scaled_1e1;

            let mut header = 0u8;
            if delta_timestamp != 0 {
                header |= 1 << 3;
            }
            if delta_latitude != 0 {
                header |= 1 << 2;
            }
            if delta_longitude != 0 {
                header |= 1 << 1;
            }
            if delta_altitude != 0 {
                header |= 1 << 0;
            }

            self.write_u8(header);
            if delta_timestamp != 0 {
                self.write_varint_s32(delta_timestamp);
            }
            if delta_latitude != 0 {
                self.write_varint_s32(delta_latitude);
            }
            if delta_longitude != 0 {
                self.write_varint_s32(delta_longitude);
            }
            if delta_altitude != 0 {
                self.write_varint_s32(delta_altitude);
            }
            self.points_since_last_full_block += 1;
        }

        self.previous_point = point;
        self.buffer_len
    }

    fn write_u8(&mut self, value: u8) {
        if self.buffer_len < self.buffer.len() {
            self.buffer[self.buffer_len] = value;
            self.buffer_len += 1;
        }
    }

    fn write_u32_le(&mut self, value: u32) {
        if self.buffer_len + 4 <= self.buffer.len() {
            let bytes = value.to_le_bytes();
            self.buffer[self.buffer_len..self.buffer_len + 4].copy_from_slice(&bytes);
            self.buffer_len += 4;
        }
    }

    fn write_i32_le(&mut self, value: i32) {
        self.write_u32_le(value as u32);
    }

    fn write_varint_s32(&mut self, value: i32) {
        let mut zz = ((value as u32) << 1) ^ ((value >> 31) as u32);
        while zz >= 0x80 && self.buffer_len < self.buffer.len() {
            self.write_u8((zz as u8) | 0x80);
            zz >>= 7;
        }
        self.write_u8(zz as u8);
    }
}

fn build_log_filename(year: u16, month: u8, day: u8) -> Filename {
    let mut buf = [0u8; 12];
    let year_digits = year_to_digits(year);
    buf[0] = year_digits[0];
    buf[1] = year_digits[1];
    buf[2] = year_digits[2];
    buf[3] = year_digits[3];
    let month_digits = two_digits(month);
    buf[4] = month_digits[0];
    buf[5] = month_digits[1];
    let day_digits = two_digits(day);
    buf[6] = day_digits[0];
    buf[7] = day_digits[1];
    buf[8] = b'.';
    buf[9] = b'G';
    buf[10] = b'P';
    buf[11] = b'X';
    Filename { buf, len: 12 }
}

struct Filename {
    buf: [u8; 12],
    len: usize,
}

impl Filename {
    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("00000000.GPX")
    }
}

fn year_to_digits(year: u16) -> [u8; 4] {
    let y = year as u32;
    [
        b'0' + ((y / 1000) % 10) as u8,
        b'0' + ((y / 100) % 10) as u8,
        b'0' + ((y / 10) % 10) as u8,
        b'0' + (y % 10) as u8,
    ]
}

fn two_digits(value: u8) -> [u8; 2] {
    let v = value as u32;
    [b'0' + ((v / 10) % 10) as u8, b'0' + (v % 10) as u8]
}

fn unix_to_date(timestamp: u32) -> Option<(u16, u8, u8)> {
    let mut days = timestamp / 86_400;
    let mut year: u16 = 1970;

    loop {
        let year_days = if is_leap_year(year) { 366 } else { 365 };
        if days >= year_days {
            days -= year_days;
            year = year.wrapping_add(1);
        } else {
            break;
        }
    }

    let mut month: u8 = 1;
    let mut days_in_month = [31u32, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if is_leap_year(year) {
        days_in_month[1] = 29;
    }
    for dim in days_in_month.iter() {
        if days >= *dim {
            days -= *dim;
            month = month.wrapping_add(1);
        } else {
            break;
        }
    }

    let day = (days + 1) as u8;
    Some((year, month, day))
}

fn is_leap_year(year: u16) -> bool {
    year % 4 == 0
}

fn round_f64(value: f64) -> f64 {
    round(value)
}

fn round_f32(value: f32) -> f32 {
    roundf(value)
}
