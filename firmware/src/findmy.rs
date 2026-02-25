//! Apple Find My network compatible BLE advertising with rolling key rotation.
//!
//! Implements the offline finding protocol:
//! - P-224 elliptic curve key derivation (rolling keys every 15 minutes)
//! - BLE advertisement payload construction matching Apple's format
//! - Non-connectable undirected advertising when main BLE is idle
//!
//! # Key Derivation Algorithm
//!
//! Given master private key `d`, initial symmetric key `SK₀`, and epoch `T₀`:
//! - Counter `i = (now - T₀) / 900` (900s = 15 minutes)
//! - `SKᵢ = KDF(SKᵢ₋₁, "update", 32)` — ANSI X9.63 KDF with SHA-256
//! - `(uᵢ, vᵢ) = KDF(SKᵢ, "diversify", 72)` — 36 bytes each
//! - `dᵢ = (d × uᵢ' + vᵢ') mod q`
//! - `Pᵢ = dᵢ × G` — derive public key
//! - BLE address = first 6 bytes of Pᵢ.x, payload = remaining 22 bytes

use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use embassy_executor::task;
use embassy_time::{Duration, Instant, Timer};
use p224::elliptic_curve::ops::Reduce;
use p224::elliptic_curve::sec1::ToEncodedPoint;
use p224::{FieldBytes, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

use nrf_softdevice::{raw, RawError, Softdevice};

use crate::ble;
use crate::display;
use crate::storage;
use crate::system_info::SYSTEM_INFO;

/// Key rotation interval in seconds (15 minutes).
const KEY_ROTATION_SECS: u64 = 900;

/// BLE advertising interval in units of 0.625ms.
/// 2000ms balances discoverability and power consumption.
const FINDMY_ADV_INTERVAL_UNITS: u32 = 3200;

/// Enable/disable Find My advertising at runtime.
static FINDMY_ENABLED: AtomicBool = AtomicBool::new(false);
static FINDMY_DIAG_STATE: AtomicU8 = AtomicU8::new(FindMyDiagState::Disabled as u8);
static mut FINDMY_ADV_HANDLE: u8 = raw::BLE_GAP_ADV_SET_HANDLE_NOT_SET as u8;

/// Master key material. Set once during initialization.
/// Layout: [private_key: 28 | symmetric_key: 32 | epoch_secs: 8 (LE)]
static mut MASTER_KEYS: [u8; 68] = [0u8; 68];

/// Cached symmetric key state for incremental KDF advancement.
/// Avoids re-deriving from SK₀ on every rotation.
struct SkCache {
    sk: [u8; 32],
    counter: u32,
    valid: bool,
}

static mut SK_CACHE: SkCache = SkCache {
    sk: [0u8; 32],
    counter: 0,
    valid: false,
};

#[repr(u8)]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum FindMyDiagState {
    Disabled = 0,
    WaitingGpsTime = 1,
    WaitingBleIdle = 2,
    AddressReady = 3,
    Advertising = 4,
    SetAddrFailed = 5,
    AdvConfigureFailed = 6,
    AdvStartFailed = 7,
}

impl FindMyDiagState {
    fn from_raw(raw: u8) -> Option<Self> {
        match raw {
            0 => Some(Self::Disabled),
            1 => Some(Self::WaitingGpsTime),
            2 => Some(Self::WaitingBleIdle),
            3 => Some(Self::AddressReady),
            4 => Some(Self::Advertising),
            5 => Some(Self::SetAddrFailed),
            6 => Some(Self::AdvConfigureFailed),
            7 => Some(Self::AdvStartFailed),
            _ => None,
        }
    }
}

fn set_diag_state(state: FindMyDiagState) {
    FINDMY_DIAG_STATE.store(state as u8, Ordering::Release);
}

pub fn diag_state() -> FindMyDiagState {
    let raw = FINDMY_DIAG_STATE.load(Ordering::Acquire);
    FindMyDiagState::from_raw(raw).unwrap_or(FindMyDiagState::Disabled)
}

fn configure_adv_set(
    adv_data: &raw::ble_gap_adv_data_t,
    adv_params: &raw::ble_gap_adv_params_t,
) -> Result<u8, RawError> {
    unsafe {
        let handle_ptr = &raw mut FINDMY_ADV_HANDLE;
        let first = RawError::convert(raw::sd_ble_gap_adv_set_configure(
            handle_ptr,
            adv_data as *const _,
            adv_params as *const _,
        ));
        match first {
            Ok(()) => Ok(*handle_ptr),
            // Single advertising set device: if no free handle, reconfigure handle 0.
            Err(RawError::NoMem) => {
                *handle_ptr = 0;
                RawError::convert(raw::sd_ble_gap_adv_set_configure(
                    handle_ptr,
                    adv_data as *const _,
                    adv_params as *const _,
                ))?;
                Ok(*handle_ptr)
            }
            // Handle became stale; request a fresh one.
            Err(RawError::BleInvalidAdvHandle) => {
                *handle_ptr = raw::BLE_GAP_ADV_SET_HANDLE_NOT_SET as u8;
                RawError::convert(raw::sd_ble_gap_adv_set_configure(
                    handle_ptr,
                    adv_data as *const _,
                    adv_params as *const _,
                ))?;
                Ok(*handle_ptr)
            }
            Err(e) => Err(e),
        }
    }
}

// ---------------------------------------------------------------------------
// ANSI X9.63 KDF (SHA-256 based, matching Apple's implementation)
// ---------------------------------------------------------------------------

/// ANSI X9.63 Key Derivation Function using SHA-256.
///
/// `output = SHA256(input || counter_be32 || shared_info)` iterated until
/// enough bytes are produced.
fn kdf(input: &[u8], shared_info: &[u8], bytes_to_return: usize) -> KdfOutput {
    let mut result = KdfOutput::new();
    let mut counter: u32 = 1;

    while result.len < bytes_to_return {
        let mut sha = Sha256::new();
        sha.update(input);
        sha.update(counter.to_be_bytes());
        sha.update(shared_info);
        let hash = sha.finalize();

        let remaining = bytes_to_return - result.len;
        let to_copy = if remaining < 32 { remaining } else { 32 };
        result.data[result.len..result.len + to_copy].copy_from_slice(&hash[..to_copy]);
        result.len += to_copy;
        counter += 1;
    }

    result
}

/// Fixed-size buffer for KDF output (max 72 bytes for "diversify").
struct KdfOutput {
    data: [u8; 72],
    len: usize,
}

impl KdfOutput {
    fn new() -> Self {
        Self {
            data: [0u8; 72],
            len: 0,
        }
    }

    fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }
}

// ---------------------------------------------------------------------------
// P-224 key derivation
// ---------------------------------------------------------------------------

/// Advance symmetric key from `start_sk` at `start_counter` to `target_counter`.
///
/// Returns the SK at `target_counter`. If `target_counter == start_counter`,
/// returns `start_sk` unchanged.
fn advance_sk(start_sk: &[u8; 32], start_counter: u32, target_counter: u32) -> [u8; 32] {
    let mut sk = [0u8; 32];
    sk.copy_from_slice(start_sk);
    for _ in start_counter..target_counter {
        let derived = kdf(&sk, b"update", 32);
        sk.copy_from_slice(&derived.as_slice()[..32]);
    }
    sk
}

/// Derive the rolling key pair for time interval `counter`.
///
/// Uses SK cache when available for incremental advancement.
/// Falls back to iterating from SK₀ when cache is invalid.
fn derive_key_at(master_private: &[u8; 28], sk0: &[u8; 32], counter: u32) -> DerivedKey {
    // Step 1: Get SK at `counter`, using cache if possible
    let sk = unsafe {
        if SK_CACHE.valid && SK_CACHE.counter <= counter {
            let cached_sk = core::ptr::read_volatile(&raw const SK_CACHE.sk);
            let cached_counter = core::ptr::read_volatile(&raw const SK_CACHE.counter);
            let sk = advance_sk(&cached_sk, cached_counter, counter);
            SK_CACHE.sk = sk;
            SK_CACHE.counter = counter;
            sk
        } else {
            // Cold start: iterate from SK₀
            let sk = advance_sk(sk0, 0, counter);
            SK_CACHE.sk = sk;
            SK_CACHE.counter = counter;
            SK_CACHE.valid = true;
            sk
        }
    };

    // Step 2: Diversify to get u_i and v_i (36 bytes each)
    let diversified = kdf(&sk, b"diversify", 72);
    let u_bytes = &diversified.data[..36];
    let v_bytes = &diversified.data[36..72];

    // Step 3: Convert master private key to scalar
    let d0 = bytes_to_scalar(master_private);

    // Step 4: u_i' = (u_i mod (q-1)) + 1, v_i' = (v_i mod (q-1)) + 1
    let u_i = bytes_to_scalar_nonzero(u_bytes);
    let v_i = bytes_to_scalar_nonzero(v_bytes);

    // Step 5: d_i = d_0 * u_i' + v_i' (mod q)
    let d_i = d0 * u_i + v_i;

    // Step 6: P_i = d_i * G (public key)
    let p_i = ProjectivePoint::GENERATOR * d_i;
    let p_i_affine = p_i.to_affine();
    let encoded = p_i_affine.to_encoded_point(false);
    let x_bytes = encoded.x().expect("valid point");

    let mut public_key_x = [0u8; 28];
    public_key_x.copy_from_slice(x_bytes);

    DerivedKey { public_key_x }
}

/// Convert bytes to a P-224 scalar via reduction mod q.
///
/// Takes the first 28 bytes (or fewer, left-padded with zeros),
/// interprets as big-endian integer, and reduces modulo the curve order.
fn bytes_to_scalar(bytes: &[u8]) -> Scalar {
    let mut buf = FieldBytes::default();
    let copy_len = if bytes.len() > 28 { 28 } else { bytes.len() };
    buf[28 - copy_len..].copy_from_slice(&bytes[..copy_len]);
    Scalar::reduce_bytes(&buf)
}

/// Convert bytes to a non-zero P-224 scalar (for diversification).
fn bytes_to_scalar_nonzero(bytes: &[u8]) -> Scalar {
    let scalar = bytes_to_scalar(bytes);
    if bool::from(scalar.is_zero()) {
        Scalar::ONE
    } else {
        scalar
    }
}

struct DerivedKey {
    public_key_x: [u8; 28],
}

#[derive(Clone, Copy)]
struct TimeAnchor {
    unix_ts: u64,
    monotonic_ms: u64,
}

// ---------------------------------------------------------------------------
// BLE advertisement payload
// ---------------------------------------------------------------------------

/// Map battery percentage to Apple Find My status byte.
///
/// AirTag status byte encoding:
/// - 0x10 = full (>80%)
/// - 0x50 = medium (30-80%)
/// - 0x90 = low (10-30%)
/// - 0xD0 = very low (<10%)
fn battery_to_status(battery_percent: u8) -> u8 {
    if battery_percent > 80 {
        0x10
    } else if battery_percent > 30 {
        0x50
    } else if battery_percent > 10 {
        0x90
    } else {
        0xD0
    }
}

/// Build the 31-byte Find My advertisement payload from a public key.
fn build_adv_payload(public_key_x: &[u8; 28], status: u8) -> [u8; 31] {
    let mut payload = [0u8; 31];
    payload[0] = 0x1e; // Length (30)
    payload[1] = 0xff; // Manufacturer Specific Data
    payload[2] = 0x4c; // Apple Company ID (little-endian)
    payload[3] = 0x00;
    payload[4] = 0x12; // Offline Finding type
    payload[5] = 0x19; // Payload length (25 bytes)
    payload[6] = status;
    payload[7..29].copy_from_slice(&public_key_x[6..28]);
    payload[29] = public_key_x[0] >> 6;
    payload[30] = 0x00; // Hint byte (reserved)
    payload
}

/// Extract BLE random static address from public key x-coordinate.
///
/// `ble_gap_addr_t.addr` uses LSB format in SoftDevice.
/// Canonical Find My MAC bytes are derived as:
///   [x0|0xC0, x1, x2, x3, x4, x5]
/// so they must be reversed when placed into `addr[0..6]`.
fn build_ble_address(public_key_x: &[u8; 28]) -> [u8; 6] {
    let mut addr = [0u8; 6];
    addr[0] = public_key_x[5];
    addr[1] = public_key_x[4];
    addr[2] = public_key_x[3];
    addr[3] = public_key_x[2];
    addr[4] = public_key_x[1];
    addr[5] = public_key_x[0] | 0xC0;
    addr
}

// ---------------------------------------------------------------------------
// Time-based counter
// ---------------------------------------------------------------------------

/// Read GPS unix timestamp from SYSTEM_INFO.
///
/// Returns `None` if GPS datetime is not yet valid.
async fn gps_unix_ts() -> Option<u64> {
    let info = *SYSTEM_INFO.lock().await;
    if !info.date_time_valid {
        return None;
    }
    let dt = chrono::NaiveDate::from_ymd_opt(info.year as i32, info.month as u32, info.day as u32)?
        .and_hms_opt(info.hour as u32, info.minute as u32, info.second as u32)?;
    Some(dt.and_utc().timestamp() as u64)
}

/// Read the stored epoch from master keys.
fn stored_epoch() -> u64 {
    u64::from_le_bytes(unsafe {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&MASTER_KEYS[60..68]);
        buf
    })
}

pub fn epoch_secs() -> u64 {
    stored_epoch()
}

/// Compute the key counter from unix timestamp and stored epoch.
///
/// Counter rotates on absolute 15-minute UTC slots:
/// `counter = floor(unix_ts / 900) - floor(epoch / 900)`.
///
/// Returns `None` if unix time is before epoch.
fn counter_from_unix(unix_ts: u64) -> Option<u32> {
    let epoch = stored_epoch();
    if unix_ts < epoch {
        return None;
    }
    let epoch_slot = epoch / KEY_ROTATION_SECS;
    let now_slot = unix_ts / KEY_ROTATION_SECS;
    Some((now_slot - epoch_slot) as u32)
}

/// Seconds remaining until next absolute 15-minute slot boundary.
fn secs_until_next_rotation_from_unix(unix_ts: u64) -> Option<u64> {
    let epoch = stored_epoch();
    if unix_ts < epoch {
        return None;
    }
    let into_slot = unix_ts % KEY_ROTATION_SECS;
    Some(KEY_ROTATION_SECS - into_slot)
}

/// Read current battery percent from SYSTEM_INFO.
async fn battery_percent() -> u8 {
    let info = *SYSTEM_INFO.lock().await;
    if info.battery_voltage < 0.0 {
        return 0;
    }
    let percent = crate::battery::estimate_battery_level(info.battery_voltage * 1000.0)
        .clamp(0.0, 100.0);
    (percent + 0.5) as u8
}

// ---------------------------------------------------------------------------
// SD card SK cache persistence
// ---------------------------------------------------------------------------

/// Load SK cache from SD card into the static SK_CACHE.
/// File format: sk(32 bytes) || counter(4 bytes LE) = 36 bytes.
async fn load_sk_cache_from_sd() {
    if let Some(buf) = storage::read_findmy_sk_cache().await {
        let mut sk = [0u8; 32];
        sk.copy_from_slice(&buf[..32]);
        let counter = u32::from_le_bytes([buf[32], buf[33], buf[34], buf[35]]);
        unsafe {
            SK_CACHE.sk = sk;
            SK_CACHE.counter = counter;
            SK_CACHE.valid = true;
        }
        defmt::info!("FindMy: SK cache loaded from SD, counter={}", counter);
    }
}

/// Save current SK cache to SD card.
async fn save_sk_cache_to_sd() {
    let (sk, counter, valid) = unsafe {
        let sk = core::ptr::read_volatile(&raw const SK_CACHE.sk);
        let counter = core::ptr::read_volatile(&raw const SK_CACHE.counter);
        let valid = core::ptr::read_volatile(&raw const SK_CACHE.valid);
        (sk, counter, valid)
    };
    if !valid {
        return;
    }
    let mut buf = [0u8; storage::FINDMY_SK_CACHE_SIZE];
    buf[..32].copy_from_slice(&sk);
    buf[32..36].copy_from_slice(&counter.to_le_bytes());
    if storage::write_findmy_sk_cache(&buf).await {
        defmt::info!("FindMy: SK cache saved to SD, counter={}", counter);
    } else {
        defmt::warn!("FindMy: failed to save SK cache to SD");
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Initialize Find My with master key material.
///
/// * `private_key` - 28-byte P-224 private key (from flash)
/// * `symmetric_key` - 32-byte initial symmetric key SK₀ (from flash)
/// * `epoch` - Unix timestamp when counter=0 (provisioned with keys)
///
/// After setting keys, call `load_sk_cache()` to restore cached SK from SD.
pub fn init(private_key: &[u8; 28], symmetric_key: &[u8; 32], epoch: u64) {
    unsafe {
        MASTER_KEYS[..28].copy_from_slice(private_key);
        MASTER_KEYS[28..60].copy_from_slice(symmetric_key);
        MASTER_KEYS[60..68].copy_from_slice(&epoch.to_le_bytes());
        // Invalidate SK cache; will be restored from SD by load_sk_cache()
        SK_CACHE.valid = false;
    }
}

/// Load SK cache from SD card. Call after `init()` to accelerate cold start.
pub async fn load_sk_cache() {
    load_sk_cache_from_sd().await;
}

/// Invalidate SK cache on SD card. Call when keys change (re-provisioning).
pub async fn invalidate_sk_cache() {
    storage::delete_findmy_sk_cache().await;
}

/// Enable or disable Find My advertising.
pub fn set_enabled(enabled: bool) {
    FINDMY_ENABLED.store(enabled, Ordering::Release);
    if enabled {
        set_diag_state(FindMyDiagState::WaitingGpsTime);
    } else {
        set_diag_state(FindMyDiagState::Disabled);
    }
}

pub fn is_enabled() -> bool {
    FINDMY_ENABLED.load(Ordering::Acquire)
}

/// Update anchor from GPS when available; otherwise estimate from monotonic time.
///
/// Returns `None` until at least one valid GPS timestamp has been observed.
async fn unix_ts_with_fallback(anchor: &mut Option<TimeAnchor>) -> Option<u64> {
    if let Some(unix_ts) = gps_unix_ts().await {
        *anchor = Some(TimeAnchor {
            unix_ts,
            monotonic_ms: Instant::now().as_millis(),
        });
        return Some(unix_ts);
    }

    let now_ms = Instant::now().as_millis();
    let base = (*anchor)?;
    let elapsed_secs = now_ms.saturating_sub(base.monotonic_ms) / 1000;
    Some(base.unix_ts.saturating_add(elapsed_secs))
}

/// Derive advertisement data for the provided unix timestamp.
/// Returns `None` if timestamp is before the provisioned epoch.
async fn adv_data_for_unix(unix_ts: u64) -> Option<([u8; 31], [u8; 6], u32)> {
    let counter = counter_from_unix(unix_ts)?;
    let (pk, sk) = unsafe {
        let mut p = [0u8; 28];
        let mut s = [0u8; 32];
        p.copy_from_slice(&MASTER_KEYS[..28]);
        s.copy_from_slice(&MASTER_KEYS[28..60]);
        (p, s)
    };
    let derived = derive_key_at(&pk, &sk, counter);
    let status = battery_to_status(battery_percent().await);
    let payload = build_adv_payload(&derived.public_key_x, status);
    let addr = build_ble_address(&derived.public_key_x);
    Some((payload, addr, counter))
}

// ---------------------------------------------------------------------------
// Embassy task
// ---------------------------------------------------------------------------

/// Background task: Find My BLE advertiser with GPS-time-based key rotation.
///
/// Waits for initial GPS time to establish anchor, then advertises with rolling keys.
/// After first sync, if GPS time is temporarily unavailable, unix time is estimated
/// from monotonic uptime and the last GPS timestamp.
/// Key rotation happens at 15-minute boundaries aligned to the epoch.
/// Only advertises when main BLE is idle (not advertising or connected).
#[task]
pub async fn findmy_task(_sd: &'static Softdevice) {
    defmt::info!("FindMy: task started, waiting for enable + GPS time");
    set_diag_state(FindMyDiagState::Disabled);
    let mut time_anchor: Option<TimeAnchor> = None;

    loop {
        // Wait until enabled
        while !is_enabled() {
            set_diag_state(FindMyDiagState::Disabled);
            Timer::after(Duration::from_secs(1)).await;
        }

        // Wait for initial time anchor and epoch reachability.
        let counter = loop {
            if !is_enabled() {
                break 0;
            }
            set_diag_state(FindMyDiagState::WaitingGpsTime);
            if let Some(unix_ts) = unix_ts_with_fallback(&mut time_anchor).await {
                if let Some(c) = counter_from_unix(unix_ts) {
                    break c;
                }
            }
            Timer::after(Duration::from_secs(5)).await;
        };

        if !is_enabled() {
            continue;
        }

        defmt::info!("FindMy: GPS time acquired, counter={}", counter);
        // Save SK cache after initial derivation
        save_sk_cache_to_sd().await;

        let mut current_counter = counter;

        // Main advertising loop
        loop {
            if !is_enabled() {
                break;
            }

            // Wait for main BLE to become idle
            if ble::is_active() {
                set_diag_state(FindMyDiagState::WaitingBleIdle);
                Timer::after(Duration::from_secs(2)).await;
                continue;
            }

            let unix_ts = match unix_ts_with_fallback(&mut time_anchor).await {
                Some(ts) => ts,
                None => {
                    // Initial time was never acquired in this boot.
                    set_diag_state(FindMyDiagState::WaitingGpsTime);
                    defmt::warn!("FindMy: waiting for initial GPS time");
                    Timer::after(Duration::from_secs(10)).await;
                    continue;
                }
            };

            let (adv_payload, ble_addr, new_counter) = match adv_data_for_unix(unix_ts).await {
                Some(d) => d,
                None => {
                    // Time known, but still before provisioned epoch.
                    set_diag_state(FindMyDiagState::WaitingGpsTime);
                    defmt::warn!("FindMy: unix time before epoch, retrying in 10s");
                    Timer::after(Duration::from_secs(10)).await;
                    continue;
                }
            };
            display::send_command(display::DisplayCommand::SetFindMyAddress(ble_addr));
            set_diag_state(FindMyDiagState::AddressReady);

            if new_counter != current_counter {
                defmt::info!("FindMy: key rotated {} -> {}", current_counter, new_counter);
                current_counter = new_counter;
                // Persist SK cache to SD card after rotation
                save_sk_cache_to_sd().await;
            }

            // Save original BLE address before overriding
            let mut orig_addr: raw::ble_gap_addr_t = unsafe { core::mem::zeroed() };
            let _ = unsafe { raw::sd_ble_gap_addr_get(&mut orig_addr) };

            // Set Find My BLE address
            let addr = raw::ble_gap_addr_t {
                _bitfield_1: raw::ble_gap_addr_t::new_bitfield_1(
                    0,
                    raw::BLE_GAP_ADDR_TYPE_RANDOM_STATIC as u8,
                ),
                addr: ble_addr,
            };
            if let Err(e) = RawError::convert(unsafe { raw::sd_ble_gap_addr_set(&addr) }) {
                defmt::warn!("FindMy: set addr failed: {:?}", e);
                set_diag_state(FindMyDiagState::SetAddrFailed);
                Timer::after(Duration::from_secs(5)).await;
                continue;
            }

            // Configure and start non-connectable advertising
            let mut adv_params: raw::ble_gap_adv_params_t = unsafe { core::mem::zeroed() };
            adv_params.properties.type_ =
                raw::BLE_GAP_ADV_TYPE_NONCONNECTABLE_NONSCANNABLE_UNDIRECTED as u8;
            adv_params.interval = FINDMY_ADV_INTERVAL_UNITS;
            adv_params.duration = 0;
            adv_params.filter_policy = raw::BLE_GAP_ADV_FP_ANY as u8;
            adv_params.primary_phy = raw::BLE_GAP_PHY_1MBPS as u8;

            let adv_data = raw::ble_gap_adv_data_t {
                adv_data: raw::ble_data_t {
                    p_data: adv_payload.as_ptr() as *mut u8,
                    len: adv_payload.len() as u16,
                },
                scan_rsp_data: raw::ble_data_t {
                    p_data: core::ptr::null_mut(),
                    len: 0,
                },
            };

            let adv_handle = match configure_adv_set(&adv_data, &adv_params) {
                Ok(h) => h,
                Err(e) => {
                defmt::warn!("FindMy: adv configure failed: {:?}", e);
                set_diag_state(FindMyDiagState::AdvConfigureFailed);
                // Restore original address
                let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
                Timer::after(Duration::from_secs(5)).await;
                continue;
                }
            };

            if let Err(e) = RawError::convert(unsafe {
                raw::sd_ble_gap_adv_start(adv_handle, raw::BLE_CONN_CFG_TAG_DEFAULT as u8)
            }) {
                defmt::warn!("FindMy: adv start failed: {:?}", e);
                set_diag_state(FindMyDiagState::AdvStartFailed);
                // Restore original address
                let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
                Timer::after(Duration::from_secs(5)).await;
                continue;
            }

            set_diag_state(FindMyDiagState::Advertising);
            defmt::info!("FindMy: advertising (counter={})", current_counter);

            // Sleep until next rotation boundary or BLE becomes active
            let sleep_secs =
                secs_until_next_rotation_from_unix(unix_ts).unwrap_or(KEY_ROTATION_SECS);
            let mut remaining = sleep_secs + 1;
            while remaining > 0 && !ble::is_active() && is_enabled() {
                display::send_command(display::DisplayCommand::SetFindMyAddress(ble_addr));
                let step = if remaining > 2 { 2 } else { remaining };
                Timer::after(Duration::from_secs(step)).await;
                remaining = remaining.saturating_sub(step);
            }

            // Stop advertising and restore original address
            let _ = RawError::convert(unsafe { raw::sd_ble_gap_adv_stop(adv_handle) });
            let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
        }

        display::send_command(display::DisplayCommand::ClearFindMyAddress);
        set_diag_state(FindMyDiagState::Disabled);
        defmt::info!("FindMy: disabled");
    }
}
