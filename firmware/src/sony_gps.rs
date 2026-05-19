//! Sony BLE GPS sharing.
//!
//! Scans for nearby Sony cameras and periodically writes GPS location data
//! to the camera's Location Service (`8000DD00-DD00-FFFF-FFFF-FFFFFFFFFFFF`).
//!
//! Protocol reverse-engineered from furble (https://github.com/gkoh/furble),
//! which itself was based on sniffing the Sony RMT-P1BT remote and
//! the Imaging Edge Mobile app.
//!
//! ## How it works
//!
//! 1. Wait until GPS has a valid fix (location_valid + date_time_valid).
//! 2. BLE scan for Sony cameras (Manufacturer Data `company_id == 0x012d`,
//!    `type == 0x0003`, mode22 bits indicating pairing + remote enabled).
//! 3. Connect as BLE Central, discover the Location Service.
//! 4. Enable location injection (write 0x01 to DD30 + DD31).
//! 5. Periodically (every 10s) write a 96-byte GPS/time struct to DD11.
//! 6. If the camera disconnects, wait and re-scan.
//!
//! ## Sony Location Service GATT Layout
//!
//! ```text
//! Service:  8000DD00-DD00-FFFF-FFFF-FFFFFFFFFFFF
//! ├── DD01  Notify       (camera → remote: location request)
//! ├── DD11  Write        (remote → camera: GPS/time data, 96 bytes)
//! ├── DD21  Read         (location capabilities)
//! ├── DD30  Read/Write   (allow location: 0x01 = yes)
//! └── DD31  Read/Write   (enable location: 0x01 = yes)
//! ```

use embassy_time::{Duration, Timer};
use nrf_softdevice::ble::{central, gatt_client, Address};
use nrf_softdevice::{raw, Softdevice};

use crate::system_info::SYSTEM_INFO;

// ─── Sony Advertisement Constants ───────────────────────────────────────

/// Sony's Bluetooth SIG company identifier (little-endian on wire).
const SONY_COMPANY_ID: u16 = 0x012d;

/// Manufacturer data type value indicating a camera.
const SONY_CAMERA_TYPE: u16 = 0x0003;

/// mode22 bits we require: pairing supported + pairing enabled + remote enabled.
const SONY_MODE22_REQUIRED: u8 = 0x80 | 0x40 | 0x02;

// ─── Timing ─────────────────────────────────────────────────────────────

/// Interval between GPS data writes to a connected camera.
const GPS_UPDATE_INTERVAL: Duration = Duration::from_secs(10);

/// How long to scan for Sony cameras before giving up.
const SCAN_DURATION_SECS: u16 = 15;

/// Delay before re-scanning after a disconnect or failed connection.
const RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// How long to wait between GPS fix checks when no fix is available.
const NO_FIX_RETRY_DELAY: Duration = Duration::from_secs(5);

// ─── Sony GPS Data Packet (96 bytes) ────────────────────────────────────

/// Fixed magic prefix prepended to every GPS data packet.
const SONY_GEO_PREFIX: [u8; 11] = [0x00, 0x5d, 0x08, 0x02, 0xfc, 0x03, 0x00, 0x00, 0x10, 0x10, 0x10];

/// Build a 96-byte Sony GPS data packet from system info.
fn build_geo_packet(lat: f64, lon: f64, year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> [u8; 96] {
    let mut buf = [0u8; 96];

    // Bytes 0-10: fixed magic prefix
    buf[..11].copy_from_slice(&SONY_GEO_PREFIX);

    // Bytes 11-14: latitude × 10^7 as big-endian i32
    let lat_i32 = (lat * 10_000_000.0) as i32;
    buf[11..15].copy_from_slice(&lat_i32.to_be_bytes());

    // Bytes 15-18: longitude × 10^7 as big-endian i32
    let lon_i32 = (lon * 10_000_000.0) as i32;
    buf[15..19].copy_from_slice(&lon_i32.to_be_bytes());

    // Bytes 19-20: year as big-endian u16
    buf[19..21].copy_from_slice(&year.to_be_bytes());

    // Bytes 21-25: month, day, hour, minute, second
    buf[21] = month;
    buf[22] = day;
    buf[23] = hour;
    buf[24] = minute;
    buf[25] = second;

    // Bytes 26-90: zero padding (65 bytes)
    // Already zero from initialization.

    // Bytes 91-92: UTC offset in minutes as big-endian u16
    // China Standard Time = UTC+8 = 480 minutes
    let offset: u16 = 480;
    buf[91..93].copy_from_slice(&offset.to_be_bytes());

    // Bytes 93-95: zero padding (2 bytes)
    // Already zero.

    buf
}

// ─── Advertisement Parsing ──────────────────────────────────────────────

/// Sony manufacturer data as it appears in a BLE advertisement.
#[repr(C, packed)]
struct SonyAdvData {
    company_id: u16,
    camera_type: u16,
    protocol_version: u8,
    _unused: u8,
    model: u16,
    _tag22: u8,
    mode22: u8,
}

/// Check if a BLE advertisement report is from a Sony camera ready for pairing.
///
/// Returns the device address if it matches, `None` otherwise.
fn check_sony_adv(report: &raw::ble_gap_evt_adv_report_t) -> Option<Address> {
    let data = unsafe {
        core::slice::from_raw_parts(report.data.p_data, report.data.len as usize)
    };

    // Walk through BLE AD elements looking for Manufacturer Specific Data (type 0xFF)
    let mut offset = 0;
    while offset + 1 < data.len() {
        let len = data[offset] as usize;
        if len == 0 || offset + 1 + len > data.len() {
            break;
        }
        let ad_type = data[offset + 1];
        if ad_type == 0xFF && len >= 3 {
            // Manufacturer Specific Data
            let mfr_data = &data[offset + 2..offset + 1 + len];
            if mfr_data.len() >= core::mem::size_of::<SonyAdvData>() {
                // Safety: SonyAdvData is packed and we checked the length
                let adv: &SonyAdvData = unsafe { &*(mfr_data.as_ptr() as *const SonyAdvData) };
                if adv.company_id == SONY_COMPANY_ID
                    && adv.camera_type == SONY_CAMERA_TYPE
                    && (adv.mode22 & SONY_MODE22_REQUIRED) == SONY_MODE22_REQUIRED
                {
                    return Some(Address::from_raw(report.peer_addr));
                }
            }
            // Only one Manufacturer Data element per advertisement, we can break
            break;
        }
        offset += 1 + len;
    }

    None
}

// ─── GATT Client Definition ─────────────────────────────────────────────

/// GATT client for the Sony Camera Location Service.
///
/// The `#[gatt_client]` macro generates:
/// - `SonyLocationClient::new_undiscovered(conn)` — create before discovery
/// - `gatt_client::discover::<SonyLocationClient>(&conn)` — discover service + characteristics
/// - `client.allow_read()` / `client.allow_write(&val)` — DD30
/// - `client.enable_read()` / `client.enable_write(&val)` — DD31
/// - `client.location_data_write_without_response(&buf)` — DD11
#[nrf_softdevice::gatt_client(uuid = "8000dd00-dd00-ffff-ffff-ffffffffffff")]
struct SonyLocationClient {
    /// DD30: allow location injection (write 0x01 to enable)
    #[characteristic(uuid = "dd30", read, write)]
    allow: u8,

    /// DD31: enable location injection (write 0x01 to enable)
    #[characteristic(uuid = "dd31", read, write)]
    enable: u8,

    /// DD11: GPS/time data packet (96 bytes, write without response)
    #[characteristic(uuid = "dd11", write, write_without_response)]
    location_data: [u8; 96],
}

// ─── Sony GPS Task ──────────────────────────────────────────────────────

/// Main task: scan for Sony cameras and share GPS data.
///
/// This task runs indefinitely:
/// 1. Wait for GPS fix
/// 2. Scan for Sony cameras
/// 3. Connect, enable location, start streaming GPS data
/// 4. On disconnect, go back to step 2
#[embassy_executor::task]
pub async fn sony_gps_task(sd: &'static Softdevice) {
    defmt::info!("[sony_gps] task started");

    let mut camera_addr: Option<Address> = None;

    loop {
        // ── Wait for valid GPS fix ──────────────────────────────────
        loop {
            let has_fix = {
                let info = SYSTEM_INFO.lock().await;
                info.location_valid && info.date_time_valid
            };
            if has_fix {
                break;
            }
            defmt::trace!("[sony_gps] waiting for GPS fix...");
            Timer::after(NO_FIX_RETRY_DELAY).await;
        }

        // ── Scan for Sony camera ────────────────────────────────────
        defmt::info!("[sony_gps] scanning for Sony cameras...");

        let scan_config = central::ScanConfig {
            active: true,
            interval: 160,  // 100ms
            window: 80,     // 50ms
            timeout: SCAN_DURATION_SECS * 100, // units of 10ms
            ..Default::default()
        };

        let scan_result = central::scan(sd, &scan_config, |report| {
            if let Some(addr) = check_sony_adv(report) {
                defmt::info!(
                    "[sony_gps] found Sony camera: {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                    addr.bytes[5], addr.bytes[4], addr.bytes[3],
                    addr.bytes[2], addr.bytes[1], addr.bytes[0]
                );
                // The closure captures `camera_addr` by mutable reference.
                // When scan() returns, the borrow is released.
                camera_addr = Some(addr);
                return Some(());
            }
            None
        })
        .await;

        match scan_result {
            Ok(()) => {
                // camera_addr was set in the scan callback
            }
            Err(central::ScanError::Timeout) => {
                defmt::info!("[sony_gps] scan timeout, no Sony camera found");
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
            Err(e) => {
                defmt::warn!("[sony_gps] scan error: {:?}", e);
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
        }

        let addr = match camera_addr {
            Some(ref a) => a,
            None => {
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
        };

        // ── Connect to camera ───────────────────────────────────────
        defmt::info!("[sony_gps] connecting to camera...");

        let conn_params = raw::ble_gap_conn_params_t {
            min_conn_interval: 12,   // 15ms
            max_conn_interval: 24,   // 30ms
            slave_latency: 0,
            conn_sup_timeout: 400,   // 4s
        };

        let connect_config = central::ConnectConfig {
            scan_config: central::ScanConfig {
                whitelist: Some(&[addr]),
                ..Default::default()
            },
            conn_params,
            ..Default::default()
        };

        let conn = match central::connect(sd, &connect_config).await {
            Ok(c) => {
                defmt::info!("[sony_gps] connected to camera");

                // Initiate pairing (Just Works — Sony cameras don't require a PIN).
                // Even though we don't use a SecurityHandler, the SoftDevice with
                // central_sec_count=1 will handle the pairing automatically.
                if let Err(e) = c.request_pairing() {
                    defmt::warn!("[sony_gps] pairing request failed: {:?}", e);
                    // Continue anyway — the camera might initiate pairing itself
                    // when we try to read/write characteristics.
                } else {
                    defmt::info!("[sony_gps] pairing initiated");
                }
                c
            }
            Err(e) => {
                defmt::warn!("[sony_gps] connect error: {:?}", e);
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
        };

        // ── Discover Location Service ───────────────────────────────
        defmt::info!("[sony_gps] discovering location service...");

        let client: SonyLocationClient = match gatt_client::discover(&conn).await {
            Ok(c) => {
                defmt::info!("[sony_gps] location service discovered");
                c
            }
            Err(e) => {
                defmt::warn!("[sony_gps] discover error: {:?}", e);
                let _ = conn.disconnect();
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
        };

        // ── Enable location injection ───────────────────────────────
        defmt::info!("[sony_gps] enabling location injection...");

        match client.allow_read().await {
            Ok(val) => {
                if val != 1 {
                    if let Err(e) = client.allow_write(&1).await {
                        defmt::warn!("[sony_gps] allow write error: {:?}", e);
                    } else {
                        defmt::info!("[sony_gps] location allow set to 1");
                    }
                }
            }
            Err(e) => {
                // DD30 might not exist on older cameras, not fatal
                defmt::info!("[sony_gps] allow read skipped: {:?}", e);
            }
        }

        match client.enable_read().await {
            Ok(val) => {
                if val != 1 {
                    if let Err(e) = client.enable_write(&1).await {
                        defmt::warn!("[sony_gps] enable write error: {:?}", e);
                    } else {
                        defmt::info!("[sony_gps] location enable set to 1");
                    }
                }
            }
            Err(e) => {
                defmt::info!("[sony_gps] enable read skipped: {:?}", e);
            }
        }

        // ── GPS data streaming loop ─────────────────────────────────
        defmt::info!("[sony_gps] starting GPS data stream");

        loop {
            // Read current GPS data
            let (lat, lon, year, month, day, hour, minute, second, fix_valid) = {
                let info = SYSTEM_INFO.lock().await;
                (
                    info.latitude,
                    info.longitude,
                    info.year,
                    info.month,
                    info.day,
                    info.hour,
                    info.minute,
                    info.second,
                    info.location_valid && info.date_time_valid,
                )
            };

            if !fix_valid {
                defmt::info!("[sony_gps] GPS fix lost, stopping stream");
                let _ = conn.disconnect();
                break;
            }

            let packet = build_geo_packet(lat, lon, year, month, day, hour, minute, second);

            match client.location_data_write_without_response(&packet).await {
                Ok(()) => {
                    // Log with integer representation to avoid defmt float formatting issues
                    defmt::trace!(
                        "[sony_gps] GPS sent: lat={}, lon={}",
                        (lat * 1_000_000.0) as i32,
                        (lon * 1_000_000.0) as i32,
                    );
                }
                Err(gatt_client::WriteError::Disconnected) => {
                    defmt::info!("[sony_gps] camera disconnected during write");
                    break;
                }
                Err(e) => {
                    defmt::warn!("[sony_gps] GPS write error: {:?}", e);
                    // Don't break on transient errors, retry next interval
                }
            }

            Timer::after(GPS_UPDATE_INTERVAL).await;
        }

        // ── Cleanup ─────────────────────────────────────────────────
        defmt::info!("[sony_gps] disconnected from camera");
        // Loop back to scanning
    }
}
