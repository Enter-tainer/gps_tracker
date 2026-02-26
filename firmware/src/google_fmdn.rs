//! Google Find My Device Network (FMDN) compatible BLE advertising.
//!
//! Implements the FMDN offline finding protocol:
//! - Ephemeral Identifier (EID) computation using AES-ECB-256 + SECP160R1
//! - EID rotation every 1024 seconds (~17 minutes)
//! - BLE advertisement payload construction (Eddystone 0xFEAA format)
//! - Hashed flags byte (battery level, UTP mode)
//!
//! # EID Generation Algorithm
//!
//! Given the 32-byte Ephemeral Identity Key (EIK) and a Unix timestamp:
//! 1. Construct 32-byte AES input block with masked timestamp (K=10, 1024s rotation)
//! 2. AES-ECB-256 encrypt using EIK as key → 256-bit result `r'`
//! 3. Reduce `r = r' mod n` (SECP160R1 curve order)
//! 4. Compute `R = r * G` (scalar multiplication on SECP160R1 generator)
//! 5. Extract x-coordinate of R as 20-byte EID (big-endian)
//! 6. Compute hashed flags: `SHA256(r)[0] XOR flags_raw`

use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use aes::cipher::{BlockEncrypt, KeyInit};
use aes::Aes256;
use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_time::{Duration, Instant, Timer};
use sha2::{Digest, Sha256};

use nrf_softdevice::{raw, RawError, Softdevice};

use crate::adv_scheduler::{AdvPriority, ADV_SCHEDULER};
use crate::display;
use crate::secp160r1;
use crate::system_info::SYSTEM_INFO;

/// EID rotation interval in seconds (2^10 = 1024).
const EID_ROTATION_SECS: u64 = 1024;

/// Rotation exponent K=10 (2^K = 1024 seconds).
const K: u8 = 10;

/// BLE advertising interval in units of 0.625ms.
/// 2000ms matches Find My interval.
const FMDN_ADV_INTERVAL_UNITS: u32 = 3200;

/// Enable/disable FMDN advertising at runtime.
static FMDN_ENABLED: AtomicBool = AtomicBool::new(false);
static FMDN_DIAG_STATE: AtomicU8 = AtomicU8::new(FmdnDiagState::Disabled as u8);
static mut FMDN_ADV_HANDLE: u8 = raw::BLE_GAP_ADV_SET_HANDLE_NOT_SET as u8;

/// 32-byte Ephemeral Identity Key. Set once during initialization.
static mut EIK: [u8; 32] = [0u8; 32];

#[repr(u8)]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum FmdnDiagState {
    Disabled = 0,
    WaitingGpsTime = 1,
    WaitingBleIdle = 2,
    EidReady = 3,
    Advertising = 4,
    SetAddrFailed = 5,
    AdvConfigureFailed = 6,
    AdvStartFailed = 7,
}

impl FmdnDiagState {
    fn from_raw(raw: u8) -> Option<Self> {
        match raw {
            0 => Some(Self::Disabled),
            1 => Some(Self::WaitingGpsTime),
            2 => Some(Self::WaitingBleIdle),
            3 => Some(Self::EidReady),
            4 => Some(Self::Advertising),
            5 => Some(Self::SetAddrFailed),
            6 => Some(Self::AdvConfigureFailed),
            7 => Some(Self::AdvStartFailed),
            _ => None,
        }
    }
}

fn set_diag_state(state: FmdnDiagState) {
    FMDN_DIAG_STATE.store(state as u8, Ordering::Release);
}

pub fn diag_state() -> FmdnDiagState {
    let raw = FMDN_DIAG_STATE.load(Ordering::Acquire);
    FmdnDiagState::from_raw(raw).unwrap_or(FmdnDiagState::Disabled)
}

// ---------------------------------------------------------------------------
// EID computation
// ---------------------------------------------------------------------------

/// Computed EID data for a single rotation period.
struct EidData {
    /// 20-byte Ephemeral Identifier (x-coordinate of R).
    eid: [u8; 20],
    /// Hashed flags byte.
    hashed_flags: u8,
    /// The masked timestamp used (for rotation detection).
    masked_ts: u32,
}

/// Construct the 32-byte AES input block for EID generation.
///
/// Layout:
/// ```text
/// Bytes  0-10: 0xFF padding
/// Byte     11: K (rotation exponent)
/// Bytes 12-15: masked timestamp (big-endian)
/// Bytes 16-26: 0x00 padding
/// Byte     27: K (rotation exponent)
/// Bytes 28-31: masked timestamp (big-endian, same as 12-15)
/// ```
fn build_aes_input(unix_ts: u64) -> [u8; 32] {
    let mask = !((1u32 << K) - 1);
    let masked_ts = (unix_ts as u32) & mask;
    let ts_bytes = masked_ts.to_be_bytes();

    let mut block = [0u8; 32];
    // Bytes 0-10: 0xFF padding
    for b in &mut block[0..11] {
        *b = 0xFF;
    }
    // Byte 11: K
    block[11] = K;
    // Bytes 12-15: masked timestamp (big-endian)
    block[12..16].copy_from_slice(&ts_bytes);
    // Bytes 16-26: 0x00 (already zeroed)
    // Byte 27: K
    block[27] = K;
    // Bytes 28-31: masked timestamp
    block[28..32].copy_from_slice(&ts_bytes);

    block
}

/// Compute the EID for a given Unix timestamp.
///
/// Returns the EID data including the 20-byte identifier and hashed flags.
fn compute_eid(unix_ts: u64, battery_flags: u8) -> EidData {
    let eik = unsafe { core::ptr::read_volatile(&raw const EIK) };
    let aes_input = build_aes_input(unix_ts);

    // AES-ECB-256 encrypt the 32-byte block using EIK as key.
    // The aes crate processes 16-byte blocks, so we encrypt two blocks.
    let cipher = Aes256::new((&eik).into());
    let mut block0 = aes::Block::from(
        <[u8; 16]>::try_from(&aes_input[0..16]).unwrap_or([0u8; 16]),
    );
    let mut block1 = aes::Block::from(
        <[u8; 16]>::try_from(&aes_input[16..32]).unwrap_or([0u8; 16]),
    );
    cipher.encrypt_block(&mut block0);
    cipher.encrypt_block(&mut block1);

    // Concatenate to get 32-byte r' (big-endian)
    let mut r_prime = [0u8; 32];
    r_prime[0..16].copy_from_slice(&block0);
    r_prime[16..32].copy_from_slice(&block1);

    // Reduce r' mod n (SECP160R1 curve order)
    let r = secp160r1::U192::from_be_bytes_32(&r_prime);

    // Compute R = r * G on SECP160R1
    let r_point = secp160r1::scalar_mul_generator(&r);

    // Extract x-coordinate as 20-byte big-endian EID
    let eid = match r_point.to_affine() {
        Some(affine) => affine.x.to_be_bytes(),
        None => [0u8; 20], // Degenerate case (r = 0 mod n), should never happen
    };

    // Compute hashed flags: SHA256(r)[0] XOR flags_raw
    // r needs to be encoded as big-endian bytes, right-aligned to curve size (20 bytes)
    let mut r_bytes = [0u8; 20];
    r.to_be_bytes_padded(&mut r_bytes);
    let r_hash = Sha256::digest(&r_bytes);
    let hashed_flags = r_hash[0] ^ battery_flags;

    let mask = !((1u32 << K) - 1);
    let masked_ts = (unix_ts as u32) & mask;

    EidData {
        eid,
        hashed_flags,
        masked_ts,
    }
}

// ---------------------------------------------------------------------------
// BLE advertisement payload
// ---------------------------------------------------------------------------

/// Build the 29-byte FMDN advertisement payload (SECP160R1, 20-byte EID).
///
/// Layout:
/// ```text
/// [0]     0x02  Length of Flags element
/// [1]     0x01  AD Type: Flags
/// [2]     0x06  Flags: LE General Discoverable + BR/EDR Not Supported
/// [3]     0x19  Length of Service Data (25 bytes)
/// [4]     0x16  AD Type: Service Data - 16-bit UUID
/// [5-6]   0xAAFE  Eddystone Service UUID (little-endian)
/// [7]     0x40  Frame type (0x40=normal, 0x41=UTP mode)
/// [8-27]  EID   20-byte Ephemeral Identifier
/// [28]    flags Hashed flags byte
/// ```
fn build_adv_payload(eid: &[u8; 20], hashed_flags: u8, utp_mode: bool) -> [u8; 29] {
    let mut payload = [0u8; 29];
    payload[0] = 0x02; // Flags length
    payload[1] = 0x01; // AD Type: Flags
    payload[2] = 0x06; // LE General Discoverable + BR/EDR Not Supported
    payload[3] = 0x19; // Service Data length (25 bytes)
    payload[4] = 0x16; // AD Type: Service Data
    payload[5] = 0xAA; // Eddystone UUID low byte
    payload[6] = 0xFE; // Eddystone UUID high byte
    payload[7] = if utp_mode { 0x41 } else { 0x40 }; // Frame type
    payload[8..28].copy_from_slice(eid);
    payload[28] = hashed_flags;
    payload
}

/// Map battery percentage to FMDN battery level flags.
///
/// Bits 5-6 of flags byte:
/// - 0b00 = unsupported
/// - 0b01 = normal
/// - 0b10 = low
/// - 0b11 = critical
fn battery_to_flags(battery_percent: u8) -> u8 {
    let level = if battery_percent > 30 {
        0b01 // normal
    } else if battery_percent > 10 {
        0b10 // low
    } else {
        0b11 // critical
    };
    level << 5
}

// ---------------------------------------------------------------------------
// SoftDevice advertising helpers
// ---------------------------------------------------------------------------

fn configure_adv_set(
    adv_data: &raw::ble_gap_adv_data_t,
    adv_params: &raw::ble_gap_adv_params_t,
) -> Result<u8, RawError> {
    unsafe {
        let handle_ptr = &raw mut FMDN_ADV_HANDLE;
        let first = RawError::convert(raw::sd_ble_gap_adv_set_configure(
            handle_ptr,
            adv_data as *const _,
            adv_params as *const _,
        ));
        match first {
            Ok(()) => Ok(*handle_ptr),
            Err(RawError::NoMem) => {
                *handle_ptr = 0;
                RawError::convert(raw::sd_ble_gap_adv_set_configure(
                    handle_ptr,
                    adv_data as *const _,
                    adv_params as *const _,
                ))?;
                Ok(*handle_ptr)
            }
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
// Time helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct TimeAnchor {
    unix_ts: u64,
    monotonic_ms: u64,
}

async fn gps_unix_ts() -> Option<u64> {
    let info = *SYSTEM_INFO.lock().await;
    if !info.date_time_valid {
        return None;
    }
    let dt = chrono::NaiveDate::from_ymd_opt(info.year as i32, info.month as u32, info.day as u32)?
        .and_hms_opt(info.hour as u32, info.minute as u32, info.second as u32)?;
    Some(dt.and_utc().timestamp() as u64)
}

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

/// Seconds remaining until next EID rotation boundary.
fn secs_until_next_rotation(unix_ts: u64) -> u64 {
    let into_slot = unix_ts % EID_ROTATION_SECS;
    EID_ROTATION_SECS - into_slot
}

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
// Public API
// ---------------------------------------------------------------------------

/// Initialize FMDN with the Ephemeral Identity Key.
///
/// * `eik` - 32-byte EIK (from storage or provisioning)
pub fn init(eik: &[u8; 32]) {
    unsafe {
        let dst = &raw mut EIK;
        core::ptr::copy_nonoverlapping(eik.as_ptr(), (*dst).as_mut_ptr(), 32);
    }
}

/// Enable or disable FMDN advertising.
pub fn set_enabled(enabled: bool) {
    FMDN_ENABLED.store(enabled, Ordering::Release);
    if enabled {
        set_diag_state(FmdnDiagState::WaitingGpsTime);
    } else {
        set_diag_state(FmdnDiagState::Disabled);
    }
}

pub fn is_enabled() -> bool {
    FMDN_ENABLED.load(Ordering::Acquire)
}

// ---------------------------------------------------------------------------
// Embassy task
// ---------------------------------------------------------------------------

/// Background task: FMDN BLE advertiser with GPS-time-based EID rotation.
///
/// Waits for initial GPS time, then computes EIDs and advertises with rotation
/// every 1024 seconds. Uses `AdvScheduler` to coordinate with main BLE and
/// Find My advertising.
#[task]
pub async fn fmdn_task(_sd: &'static Softdevice) {
    defmt::info!("FMDN: task started, waiting for enable + GPS time");
    set_diag_state(FmdnDiagState::Disabled);
    let mut time_anchor: Option<TimeAnchor> = None;
    let mut current_masked_ts: u32 = 0;

    loop {
        // Wait until enabled
        while !is_enabled() {
            set_diag_state(FmdnDiagState::Disabled);
            Timer::after(Duration::from_secs(1)).await;
        }

        // Wait for initial time anchor.
        let unix_ts = loop {
            if !is_enabled() {
                break 0;
            }
            set_diag_state(FmdnDiagState::WaitingGpsTime);
            if let Some(ts) = unix_ts_with_fallback(&mut time_anchor).await {
                break ts;
            }
            Timer::after(Duration::from_secs(5)).await;
        };

        if !is_enabled() || unix_ts == 0 {
            continue;
        }

        defmt::info!("FMDN: GPS time acquired, ts={}", unix_ts);

        // Main advertising loop
        loop {
            if !is_enabled() {
                break;
            }

            // Acquire advertising resource.
            set_diag_state(FmdnDiagState::WaitingBleIdle);
            let guard = ADV_SCHEDULER.acquire(AdvPriority::FindMyAdv).await;

            if !is_enabled() {
                drop(guard);
                break;
            }

            let unix_ts = match unix_ts_with_fallback(&mut time_anchor).await {
                Some(ts) => ts,
                None => {
                    set_diag_state(FmdnDiagState::WaitingGpsTime);
                    defmt::warn!("FMDN: waiting for GPS time");
                    drop(guard);
                    Timer::after(Duration::from_secs(10)).await;
                    continue;
                }
            };

            // Compute EID
            let bat = battery_percent().await;
            let flags = battery_to_flags(bat);
            let eid_data = compute_eid(unix_ts, flags);
            set_diag_state(FmdnDiagState::EidReady);

            if eid_data.masked_ts != current_masked_ts {
                defmt::info!(
                    "FMDN: EID rotated, masked_ts={}",
                    eid_data.masked_ts
                );
                current_masked_ts = eid_data.masked_ts;
            }

            let adv_payload = build_adv_payload(&eid_data.eid, eid_data.hashed_flags, false);

            // Generate random static address for this rotation period
            // (independent of EID, just needs to rotate with it)
            let mut ble_addr = [0u8; 6];
            // Use first 6 bytes of SHA256(EID) as random address
            let addr_hash = Sha256::digest(&eid_data.eid);
            ble_addr.copy_from_slice(&addr_hash[0..6]);
            ble_addr[5] |= 0xC0; // Mark as random static address

            display::send_command(display::DisplayCommand::SetFindMyAddress(ble_addr));

            // Save original BLE address
            let mut orig_addr: raw::ble_gap_addr_t = unsafe { core::mem::zeroed() };
            let _ = unsafe { raw::sd_ble_gap_addr_get(&mut orig_addr) };

            // Set FMDN BLE address
            let addr = raw::ble_gap_addr_t {
                _bitfield_1: raw::ble_gap_addr_t::new_bitfield_1(
                    0,
                    raw::BLE_GAP_ADDR_TYPE_RANDOM_STATIC as u8,
                ),
                addr: ble_addr,
            };
            if let Err(e) = RawError::convert(unsafe { raw::sd_ble_gap_addr_set(&addr) }) {
                defmt::warn!("FMDN: set addr failed: {:?}", e);
                set_diag_state(FmdnDiagState::SetAddrFailed);
                drop(guard);
                Timer::after(Duration::from_secs(5)).await;
                continue;
            }

            // Configure non-connectable advertising
            let mut adv_params: raw::ble_gap_adv_params_t = unsafe { core::mem::zeroed() };
            adv_params.properties.type_ =
                raw::BLE_GAP_ADV_TYPE_NONCONNECTABLE_NONSCANNABLE_UNDIRECTED as u8;
            adv_params.interval = FMDN_ADV_INTERVAL_UNITS;
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
                    defmt::warn!("FMDN: adv configure failed: {:?}", e);
                    set_diag_state(FmdnDiagState::AdvConfigureFailed);
                    let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
                    drop(guard);
                    Timer::after(Duration::from_secs(5)).await;
                    continue;
                }
            };

            if let Err(e) = RawError::convert(unsafe {
                raw::sd_ble_gap_adv_start(adv_handle, raw::BLE_CONN_CFG_TAG_DEFAULT as u8)
            }) {
                defmt::warn!("FMDN: adv start failed: {:?}", e);
                set_diag_state(FmdnDiagState::AdvStartFailed);
                let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
                drop(guard);
                Timer::after(Duration::from_secs(5)).await;
                continue;
            }

            set_diag_state(FmdnDiagState::Advertising);
            defmt::info!("FMDN: advertising (masked_ts={})", current_masked_ts);

            // Wait until preempted or rotation timer fires.
            let sleep_secs = secs_until_next_rotation(unix_ts);
            let rotation_timer = Timer::after(Duration::from_secs(sleep_secs + 1));

            match select(guard.wait_preempted(), rotation_timer).await {
                Either::First(()) => {
                    defmt::info!("FMDN: preempted by main BLE");
                }
                Either::Second(()) => {
                    // Normal rotation
                }
            }

            // Stop advertising and restore original address.
            let _ = RawError::convert(unsafe { raw::sd_ble_gap_adv_stop(adv_handle) });
            let _ = unsafe { raw::sd_ble_gap_addr_set(&orig_addr) };
            drop(guard);
        }

        set_diag_state(FmdnDiagState::Disabled);
        defmt::info!("FMDN: disabled");
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_aes_input() {
        // Unix timestamp 1700000000 (2023-11-14T22:13:20Z)
        let block = build_aes_input(1700000000);

        // Check padding bytes 0-10 are 0xFF
        for i in 0..11 {
            assert_eq!(block[i], 0xFF, "byte {} should be 0xFF", i);
        }

        // Check K byte at position 11
        assert_eq!(block[11], 10);

        // Masked timestamp: 1700000000 & !0x3FF = 1700000000 & 0xFFFFFC00
        // 1700000000 = 0x6554_4000 already aligned to 1024
        let expected_ts = (1700000000u32) & 0xFFFF_FC00;
        let ts_bytes = expected_ts.to_be_bytes();
        assert_eq!(&block[12..16], &ts_bytes);

        // Check padding 16-26 are 0x00
        for i in 16..27 {
            assert_eq!(block[i], 0x00, "byte {} should be 0x00", i);
        }

        // Check K at position 27
        assert_eq!(block[27], 10);

        // Check second timestamp copy
        assert_eq!(&block[28..32], &ts_bytes);
    }

    #[test]
    fn test_build_adv_payload() {
        let eid = [0x42u8; 20];
        let payload = build_adv_payload(&eid, 0xAB, false);

        assert_eq!(payload.len(), 29);
        assert_eq!(payload[0], 0x02);
        assert_eq!(payload[1], 0x01);
        assert_eq!(payload[2], 0x06);
        assert_eq!(payload[3], 0x19);
        assert_eq!(payload[4], 0x16);
        assert_eq!(payload[5], 0xAA);
        assert_eq!(payload[6], 0xFE);
        assert_eq!(payload[7], 0x40); // normal mode
        assert_eq!(&payload[8..28], &[0x42u8; 20]);
        assert_eq!(payload[28], 0xAB);
    }

    #[test]
    fn test_build_adv_payload_utp() {
        let eid = [0x00u8; 20];
        let payload = build_adv_payload(&eid, 0x00, true);
        assert_eq!(payload[7], 0x41); // UTP mode
    }

    #[test]
    fn test_battery_to_flags() {
        assert_eq!(battery_to_flags(100), 0b01 << 5); // normal
        assert_eq!(battery_to_flags(50), 0b01 << 5); // normal
        assert_eq!(battery_to_flags(31), 0b01 << 5); // normal
        assert_eq!(battery_to_flags(30), 0b10 << 5); // low
        assert_eq!(battery_to_flags(15), 0b10 << 5); // low
        assert_eq!(battery_to_flags(10), 0b11 << 5); // critical
        assert_eq!(battery_to_flags(0), 0b11 << 5); // critical
    }

    #[test]
    fn test_secs_until_next_rotation() {
        // Exactly on boundary
        assert_eq!(secs_until_next_rotation(0), 1024);
        assert_eq!(secs_until_next_rotation(1024), 1024);

        // 1 second into a slot
        assert_eq!(secs_until_next_rotation(1), 1023);

        // 500 seconds into a slot
        assert_eq!(secs_until_next_rotation(500), 524);
    }
}
