use core::cell::{Cell, RefCell};
use core::cmp::Ordering;

use embassy_embedded_hal::SetConfig;
use embassy_nrf::gpio::Output;
use embassy_nrf::spim::{self, Spim};
use embassy_sync::blocking_mutex::raw::{CriticalSectionRawMutex, ThreadModeRawMutex};
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::{Delay, Instant};
use embedded_hal::spi::{Operation, SpiBus, SpiDevice};
use embedded_sdmmc::{
    DirEntry, Error, Mode, RawDirectory, RawFile, RawVolume, SdCard, ShortFileName, TimeSource,
    Timestamp, VolumeIdx, VolumeManager,
};
use libm::{round, roundf};

const CACHE_SIZE: usize = 4096;
const ENCODER_BUFFER_SIZE: usize = 64;
const FULL_BLOCK_INTERVAL: usize = 64;
const MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_GPX_FILES: usize = 64;
const LOG_EXTENSION: &[u8] = b"gpz";
pub const MAX_PATH_LENGTH: usize = 64;

pub enum ListDirOutcome {
    Entry {
        is_dir: bool,
        name: [u8; MAX_PATH_LENGTH],
        name_len: usize,
        size: u32,
    },
    Done,
    Error,
}

static SD_LOGGER: Mutex<CriticalSectionRawMutex, Option<SdLogger>> = Mutex::new(None);
static USB_CARD: BlockingMutex<ThreadModeRawMutex, RefCell<Option<UsbSdCard>>> =
    BlockingMutex::new(RefCell::new(None));

struct UsbSdCard {
    card: SdCard<SdSpiDevice, Delay>,
    init_frequency: spim::Frequency,
    run_frequency: spim::Frequency,
}

impl UsbSdCard {
    fn new(
        card: SdCard<SdSpiDevice, Delay>,
        init_frequency: spim::Frequency,
        run_frequency: spim::Frequency,
    ) -> Self {
        Self {
            card,
            init_frequency,
            run_frequency,
        }
    }
}

pub fn init_sd_logger(
    spi: Spim<'static>,
    mut cs: Output<'static>,
    config: spim::Config,
    run_frequency: spim::Frequency,
) -> bool {
    cs.set_high();
    let init_frequency = config.frequency;
    let Some(logger) = create_logger(spi, cs, config, init_frequency, run_frequency) else {
        defmt::warn!("SD idle clock preamble failed");
        return false;
    };
    if let Ok(mut guard) = SD_LOGGER.try_lock() {
        *guard = Some(logger);
        defmt::info!("SD logger initialized");
        return true;
    }
    defmt::warn!("SD logger init lock failed");
    false
}

pub async fn enter_usb_mode() -> bool {
    let logger = {
        let mut guard = SD_LOGGER.lock().await;
        guard.take()
    };

    if let Some(logger) = logger {
        let usb_card = logger.into_usb_card();
        USB_CARD.lock(|card| {
            *card.borrow_mut() = Some(usb_card);
        });
        defmt::info!("enter_usb_mode: logger -> usb card");
        return true;
    }

    let has_usb = USB_CARD.lock(|card| card.borrow().is_some());
    if has_usb {
        defmt::info!("enter_usb_mode: already in usb mode");
    } else {
        defmt::warn!("enter_usb_mode: no logger or usb card");
    }
    has_usb
}

pub async fn exit_usb_mode() -> bool {
    let usb_card = USB_CARD.lock(|card| card.borrow_mut().take());
    let Some(usb_card) = usb_card else {
        let guard = SD_LOGGER.lock().await;
        let has_logger = guard.is_some();
        if has_logger {
            defmt::info!("exit_usb_mode: logger already active");
        } else {
            defmt::warn!("exit_usb_mode: no usb card or logger");
        }
        return has_logger;
    };

    let Some(logger) = rebuild_logger(usb_card) else {
        defmt::warn!("exit_usb_mode: rebuild logger failed");
        return false;
    };
    let mut guard = SD_LOGGER.lock().await;
    *guard = Some(logger);
    defmt::info!("exit_usb_mode: logger restored");
    true
}

pub fn with_usb_card<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&mut SdCard<SdSpiDevice, Delay>) -> R,
{
    USB_CARD.lock(|card| {
        let mut card = card.borrow_mut();
        match card.as_mut() {
            Some(usb_card) => Some(f(&mut usb_card.card)),
            None => None,
        }
    })
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

pub async fn list_dir_next(path: &[u8]) -> ListDirOutcome {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return ListDirOutcome::Error;
    };
    logger.list_dir_next(path)
}

pub async fn open_file(path: &[u8]) -> Option<u32> {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return None;
    };
    logger.open_transfer_file(path)
}

pub async fn read_file(offset: u32, out: &mut [u8]) -> Result<usize, ()> {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return Err(());
    };
    logger.read_transfer_file(offset, out)
}

pub async fn close_file() -> bool {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return false;
    };
    logger.close_transfer_file()
}

pub async fn delete_file(path: &[u8]) -> bool {
    let mut logger = SD_LOGGER.lock().await;
    let Some(logger) = logger.as_mut() else {
        return false;
    };
    logger.delete_transfer_file(path)
}

fn create_logger(
    mut spi: Spim<'static>,
    mut cs: Output<'static>,
    config: spim::Config,
    init_frequency: spim::Frequency,
    run_frequency: spim::Frequency,
) -> Option<SdLogger> {
    cs.set_high();
    let idle = [0xFFu8; 10];
    SpiBus::write(&mut spi, &idle).ok()?;
    let _ = SpiBus::flush(&mut spi);

    let sd_spi = SdSpiDevice::new(spi, cs, config);
    let delay = Delay;
    let sd_card = SdCard::new(sd_spi, delay);
    let volume_mgr = VolumeManager::new(sd_card, FixedTimeSource);
    let volume = volume_mgr.open_raw_volume(VolumeIdx(0)).ok()?;
    let root_dir = volume_mgr.open_root_dir(volume).ok()?;

    let _ = volume_mgr.device(|sd| {
        sd.spi(|spi| {
            spi.set_frequency(run_frequency);
        });
        FixedTimeSource
    });

    Some(SdLogger::new(
        volume_mgr,
        volume,
        root_dir,
        init_frequency,
        run_frequency,
    ))
}

fn rebuild_logger(usb_card: UsbSdCard) -> Option<SdLogger> {
    usb_card.card.spi(|spi| {
        spi.set_frequency(usb_card.init_frequency);
        let _ = spi.send_idle_clocks();
    });
    usb_card.card.mark_card_uninit();

    let volume_mgr = VolumeManager::new(usb_card.card, FixedTimeSource);
    let volume = volume_mgr.open_raw_volume(VolumeIdx(0)).ok()?;
    let root_dir = volume_mgr.open_root_dir(volume).ok()?;

    let _ = volume_mgr.device(|sd| {
        sd.spi(|spi| {
            spi.set_frequency(usb_card.run_frequency);
        });
        FixedTimeSource
    });

    Some(SdLogger::new(
        volume_mgr,
        volume,
        root_dir,
        usb_card.init_frequency,
        usb_card.run_frequency,
    ))
}

struct TransferState {
    open_file: Option<RawFile>,
    listing_dir: Option<RawDirectory>,
    listing_in_progress: bool,
    listing_dir_is_root: bool,
    list_index: usize,
}

impl TransferState {
    const fn new() -> Self {
        Self {
            open_file: None,
            listing_dir: None,
            listing_in_progress: false,
            listing_dir_is_root: true,
            list_index: 0,
        }
    }
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
    transfer: TransferState,
    init_frequency: spim::Frequency,
    run_frequency: spim::Frequency,
}

impl SdLogger {
    fn new(
        volume_mgr: VolumeManager<SdCard<SdSpiDevice, Delay>, FixedTimeSource, 4, 4, 1>,
        volume: RawVolume,
        root_dir: RawDirectory,
        init_frequency: spim::Frequency,
        run_frequency: spim::Frequency,
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
            transfer: TransferState::new(),
            init_frequency,
            run_frequency,
        }
    }

    fn into_usb_card(mut self) -> UsbSdCard {
        self.prepare_for_usb();
        let (card, _time) = self.volume_mgr.free();
        UsbSdCard::new(card, self.init_frequency, self.run_frequency)
    }

    fn prepare_for_usb(&mut self) {
        let _ = self.flush_cache();
        self.close_current_file();
        if let Some(file) = self.transfer.open_file.take() {
            let _ = self.volume_mgr.close_file(file);
        }
        self.finish_listing();
        let _ = self.volume_mgr.close_dir(self.root_dir);
        let _ = self.volume_mgr.close_volume(self.volume);
    }

    fn close_current_file(&mut self) {
        if let Some(file) = self.current_file.take() {
            let _ = self.volume_mgr.close_file(file);
        }
    }

    fn current_date_parts(&self) -> Option<(u16, u8, u8)> {
        if self.current_date == 0 {
            return None;
        }
        let year = (self.current_date / 10000) as u16;
        let month = ((self.current_date / 100) % 100) as u8;
        let day = (self.current_date % 100) as u8;
        Some((year, month, day))
    }

    fn open_log_file_for_current_date(&mut self) -> Option<RawFile> {
        let (year, month, day) = self.current_date_parts()?;
        let filename = build_log_filename(year, month, day);
        self.volume_mgr
            .open_file_in_dir(self.root_dir, filename.as_str(), Mode::ReadWriteCreateOrAppend)
            .ok()
    }

    fn is_current_log_file(&self, file_name: &str) -> bool {
        let Some((year, month, day)) = self.current_date_parts() else {
            return false;
        };
        let filename = build_log_filename(year, month, day);
        filename.as_str().eq_ignore_ascii_case(file_name)
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
            latitude_scaled_1e7: round_f64(latitude * 1e7) as i32,
            longitude_scaled_1e7: round_f64(longitude * 1e7) as i32,
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

        let file = match self.current_file {
            Some(file) => file,
            None => {
                let Some(file) = self.open_log_file_for_current_date() else {
                    return false;
                };
                self.current_file = Some(file);
                file
            }
        };

        let write_ok = self
            .volume_mgr
            .write(file, &self.cache[..self.cache_len])
            .is_ok();
        let flush_ok = write_ok && self.volume_mgr.flush_file(file).is_ok();
        self.close_current_file();

        if !flush_ok {
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

        if new_date == self.current_date && self.current_date != 0 {
            return true;
        }

        if self.current_date != 0 && !self.flush_cache() {
            return false;
        }

        self.close_current_file();

        self.manage_old_files();
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

    fn list_dir_next(&mut self, path: &[u8]) -> ListDirOutcome {
        if !self.transfer.listing_in_progress {
            let (dir, is_root) = match self.open_dir_from_path(path) {
                Ok(result) => result,
                Err(_) => return ListDirOutcome::Error,
            };
            self.transfer.listing_dir = Some(dir);
            self.transfer.listing_dir_is_root = is_root;
            self.transfer.listing_in_progress = true;
            self.transfer.list_index = 0;
        }

        let dir = match self.transfer.listing_dir {
            Some(dir) => dir,
            None => return ListDirOutcome::Error,
        };

        let target_index = self.transfer.list_index;
        let mut found: Option<DirEntry> = None;
        let mut idx = 0usize;

        if self
            .volume_mgr
            .iterate_dir(dir, |entry| {
                if found.is_some() {
                    return;
                }
                if should_skip_entry(entry) {
                    return;
                }
                if idx == target_index {
                    found = Some(entry.clone());
                }
                idx = idx.saturating_add(1);
            })
            .is_err()
        {
            self.finish_listing();
            return ListDirOutcome::Error;
        }

        if let Some(entry) = found {
            self.transfer.list_index = self.transfer.list_index.saturating_add(1);
            let mut name = [0u8; MAX_PATH_LENGTH];
            let name_len = short_name_to_buf(&entry.name, &mut name);
            let is_dir = entry.attributes.is_directory();
            return ListDirOutcome::Entry {
                is_dir,
                name,
                name_len,
                size: entry.size,
            };
        }

        self.finish_listing();
        ListDirOutcome::Done
    }

    fn open_transfer_file(&mut self, path: &[u8]) -> Option<u32> {
        if path.is_empty() || path.len() >= MAX_PATH_LENGTH {
            return None;
        }
        let path_str = core::str::from_utf8(path).ok()?;
        let trimmed = path_str.trim_matches('/');
        if trimmed.is_empty() {
            return None;
        }

        let (dir_path, file_name) = match trimmed.rfind('/') {
            Some(idx) => (&trimmed[..idx], &trimmed[idx + 1..]),
            None => ("", trimmed),
        };
        if file_name.is_empty() {
            return None;
        }

        if let Some(file) = self.transfer.open_file.take() {
            let _ = self.volume_mgr.close_file(file);
        }

        let (dir, is_root) = self.open_dir_from_path(dir_path.as_bytes()).ok()?;
        let file = match self
            .volume_mgr
            .open_file_in_dir(dir, file_name, Mode::ReadOnly)
        {
            Ok(file) => file,
            Err(err) => {
                let should_retry =
                    matches!(err, Error::TooManyOpenFiles | Error::FileAlreadyOpen);
                if should_retry {
                    let _ = self.flush_cache();
                    self.close_current_file();
                    match self
                        .volume_mgr
                        .open_file_in_dir(dir, file_name, Mode::ReadOnly)
                    {
                        Ok(file) => file,
                        Err(_) => {
                            self.close_dir_if_needed(dir, is_root);
                            return None;
                        }
                    }
                } else {
                    self.close_dir_if_needed(dir, is_root);
                    return None;
                }
            }
        };

        let size = self.volume_mgr.file_length(file).ok()?;
        self.transfer.open_file = Some(file);
        self.close_dir_if_needed(dir, is_root);
        Some(size)
    }

    fn read_transfer_file(&mut self, offset: u32, out: &mut [u8]) -> Result<usize, ()> {
        let Some(file) = self.transfer.open_file else {
            return Err(());
        };
        self.volume_mgr
            .file_seek_from_start(file, offset)
            .map_err(|_| ())?;
        self.volume_mgr.read(file, out).map_err(|_| ())
    }

    fn close_transfer_file(&mut self) -> bool {
        if let Some(file) = self.transfer.open_file.take() {
            let _ = self.volume_mgr.close_file(file);
        }
        true
    }

    fn delete_transfer_file(&mut self, path: &[u8]) -> bool {
        if self.transfer.open_file.is_some() {
            return false;
        }
        if path.is_empty() || path.len() >= MAX_PATH_LENGTH {
            return false;
        }
        let path_str = match core::str::from_utf8(path) {
            Ok(path) => path,
            Err(_) => return false,
        };
        let trimmed = path_str.trim_matches('/');
        if trimmed.is_empty() {
            return false;
        }

        let (dir_path, file_name) = match trimmed.rfind('/') {
            Some(idx) => (&trimmed[..idx], &trimmed[idx + 1..]),
            None => ("", trimmed),
        };
        if file_name.is_empty() {
            return false;
        }

        let deleting_current = dir_path.is_empty() && self.is_current_log_file(file_name);
        self.close_current_file();

        let (dir, is_root) = match self.open_dir_from_path(dir_path.as_bytes()) {
            Ok(result) => result,
            Err(_) => return false,
        };

        let entry = match self.volume_mgr.find_directory_entry(dir, file_name) {
            Ok(entry) => entry,
            Err(_) => {
                if deleting_current {
                    self.cache_len = 0;
                    self.cache_dirty = false;
                    self.encoder.clear();
                }
                self.close_dir_if_needed(dir, is_root);
                return false;
            }
        };

        if entry.attributes.is_directory() {
            self.close_dir_if_needed(dir, is_root);
            return false;
        }

        let ok = self
            .volume_mgr
            .delete_file_in_dir(dir, file_name)
            .is_ok();
        if ok && deleting_current {
            self.cache_len = 0;
            self.cache_dirty = false;
            self.encoder.clear();
        }
        self.close_dir_if_needed(dir, is_root);
        ok
    }

    fn open_dir_from_path(&mut self, path: &[u8]) -> Result<(RawDirectory, bool), ()> {
        if path.is_empty() {
            return Ok((self.root_dir, true));
        }
        let path_str = core::str::from_utf8(path).map_err(|_| ())?;
        let trimmed = path_str.trim_matches('/');
        if trimmed.is_empty() {
            return Ok((self.root_dir, true));
        }

        let mut current = self.root_dir;
        let mut current_is_root = true;

        for component in trimmed.split('/') {
            if component.is_empty() {
                continue;
            }
            let next = match self.volume_mgr.open_dir(current, component) {
                Ok(dir) => dir,
                Err(_) => {
                    self.close_dir_if_needed(current, current_is_root);
                    return Err(());
                }
            };
            self.close_dir_if_needed(current, current_is_root);
            current = next;
            current_is_root = false;
        }

        Ok((current, current_is_root))
    }

    fn close_dir_if_needed(&mut self, dir: RawDirectory, is_root: bool) {
        if !is_root {
            let _ = self.volume_mgr.close_dir(dir);
        }
    }

    fn finish_listing(&mut self) {
        if let Some(dir) = self.transfer.listing_dir.take() {
            self.close_dir_if_needed(dir, self.transfer.listing_dir_is_root);
        }
        self.transfer.listing_in_progress = false;
        self.transfer.listing_dir_is_root = true;
        self.transfer.list_index = 0;
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

fn short_name_to_buf(name: &ShortFileName, out: &mut [u8; MAX_PATH_LENGTH]) -> usize {
    let base = name.base_name();
    let ext = name.extension();
    let mut len = 0;
    let base_len = core::cmp::min(base.len(), out.len());
    out[..base_len].copy_from_slice(&base[..base_len]);
    len += base_len;

    if !ext.is_empty() && len < out.len() {
        out[len] = b'.';
        len += 1;
        let ext_len = core::cmp::min(ext.len(), out.len() - len);
        out[len..len + ext_len].copy_from_slice(&ext[..ext_len]);
        if ext.eq_ignore_ascii_case(LOG_EXTENSION) {
            for byte in &mut out[len..len + ext_len] {
                *byte = byte.to_ascii_lowercase();
            }
        }
        len += ext_len;
    }

    len
}

fn should_skip_entry(entry: &DirEntry) -> bool {
    entry.name == ShortFileName::this_dir() || entry.name == ShortFileName::parent_dir()
}

fn is_gpx_entry(entry: &DirEntry) -> bool {
    entry.name.extension().eq_ignore_ascii_case(LOG_EXTENSION)
}

struct FixedTimeSource;

impl TimeSource for FixedTimeSource {
    fn get_timestamp(&self) -> Timestamp {
        Timestamp::from_calendar(2025, 1, 1, 0, 0, 0).unwrap()
    }
}

pub(crate) struct SdSpiDevice {
    spi: Spim<'static>,
    cs: Output<'static>,
    config: spim::Config,
}

impl SdSpiDevice {
    fn new(spi: Spim<'static>, mut cs: Output<'static>, config: spim::Config) -> Self {
        cs.set_high();
        Self { spi, cs, config }
    }

    fn set_frequency(&mut self, frequency: spim::Frequency) {
        self.config.frequency = frequency;
        let _ = self.spi.set_config(&self.config);
    }

    fn send_idle_clocks(&mut self) -> Result<(), embassy_nrf::spim::Error> {
        self.cs.set_high();
        let idle = [0xFFu8; 10];
        SpiBus::write(&mut self.spi, &idle)?;
        let _ = SpiBus::flush(&mut self.spi);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SdSpiError {
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

/// GPS 数据点内部表示 (V2 格式)
/// 使用 1e7 精度的经纬度 (约 1.1 厘米精度)
#[derive(Clone, Copy, Default)]
struct GpxPointInternal {
    timestamp: u32,
    latitude_scaled_1e7: i32,  // 纬度 * 10^7
    longitude_scaled_1e7: i32, // 经度 * 10^7
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
            // V2 Full Block: Header = 0xFE
            self.write_u8(0xFE);
            self.write_u32_le(point.timestamp);
            self.write_i32_le(point.latitude_scaled_1e7);
            self.write_i32_le(point.longitude_scaled_1e7);
            self.write_i32_le(point.altitude_m_scaled_1e1);
            self.points_since_last_full_block = 0;
            self.is_first_point = false;
        } else {
            let delta_timestamp = point.timestamp as i32 - self.previous_point.timestamp as i32;
            let delta_latitude =
                point.latitude_scaled_1e7 - self.previous_point.latitude_scaled_1e7;
            let delta_longitude =
                point.longitude_scaled_1e7 - self.previous_point.longitude_scaled_1e7;
            let delta_altitude =
                point.altitude_m_scaled_1e1 - self.previous_point.altitude_m_scaled_1e1;

            // V2 Delta Block: Header bit 4 = 1 (0x10 基值)
            let mut header = 0x10u8;
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
    buf[9] = LOG_EXTENSION[0];
    buf[10] = LOG_EXTENSION[1];
    buf[11] = LOG_EXTENSION[2];
    Filename { buf, len: 12 }
}

struct Filename {
    buf: [u8; 12],
    len: usize,
}

impl Filename {
    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("00000000.gpz")
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
