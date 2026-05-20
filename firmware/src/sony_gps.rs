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
//! ├── DD11  Write        (remote → camera: GPS/time data, 95 bytes)
//! ├── DD21  Read         (location capabilities)
//! ├── DD30  Read/Write   (allow location: 0x01 = yes)
//! └── DD31  Read/Write   (enable location: 0x01 = yes)
//! ```

use core::cell::Cell;

use embassy_sync::blocking_mutex::raw::ThreadModeRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{Duration, Timer, with_timeout};
use nrf_softdevice::ble::security::{IoCapabilities, SecurityHandler};
use nrf_softdevice::ble::{
    Address, AddressType, Connection, EncryptError, EncryptionInfo, IdentityKey, MasterId,
    SecurityMode, central, gatt_client,
};
use nrf_softdevice::{Softdevice, raw};
use static_cell::StaticCell;

use crate::adv_scheduler::{ADV_SCHEDULER, AdvPriority};
use crate::storage;
use crate::system_info::SYSTEM_INFO;

// ─── Sony Advertisement Constants ───────────────────────────────────────

/// Sony's Bluetooth SIG company identifier (little-endian on wire).
const SONY_COMPANY_ID: u16 = 0x012d;

/// Manufacturer data type value indicating a camera.
const SONY_CAMERA_TYPE: u16 = 0x0003;

const SONY_MODE22_PAIRING_SUPPORTED: u8 = 0x80;
const SONY_MODE22_PAIRING_ENABLED: u8 = 0x40;
const SONY_MODE22_LOCATION_SUPPORTED: u8 = 0x20;
const SONY_MODE22_LOCATION_ENABLED: u8 = 0x10;
const SONY_MODE22_REMOTE_ENABLED: u8 = 0x02;

/// mode22 bits used for first-time pairing discovery.
const SONY_MODE22_PAIRING_REQUIRED: u8 =
    SONY_MODE22_PAIRING_SUPPORTED | SONY_MODE22_PAIRING_ENABLED | SONY_MODE22_REMOTE_ENABLED;

/// mode22 bits that indicate an already-paired camera is still a useful
/// connection target even when it no longer advertises pairing mode.
const SONY_MODE22_SERVICE_BITS: u8 =
    SONY_MODE22_REMOTE_ENABLED | SONY_MODE22_LOCATION_SUPPORTED | SONY_MODE22_LOCATION_ENABLED;

// ─── Timing ─────────────────────────────────────────────────────────────

/// Interval between GPS data writes to a connected camera.
const GPS_UPDATE_INTERVAL: Duration = Duration::from_secs(10);

/// How long to scan for Sony cameras before giving up.
const SCAN_DURATION_SECS: u16 = 15;

/// Delay before re-scanning after a disconnect or failed connection.
const RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// How long to wait between GPS fix checks when no fix is available.
const NO_FIX_RETRY_DELAY: Duration = Duration::from_secs(5);

const SCAN_WATCHDOG: Duration = Duration::from_secs(SCAN_DURATION_SECS as u64 + 2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const SECURITY_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(15);
const SONY_LOCATION_PACKET_SIZE: u16 = 95;
const ATT_WRITE_OVERHEAD: u16 = 3;
const SONY_REQUIRED_ATT_MTU: u16 = SONY_LOCATION_PACKET_SIZE + ATT_WRITE_OVERHEAD;

// ─── BLE Security (bonding) ────────────────────────────────────────────

/// Keys for a bonded Sony camera, stored in RAM for the session lifetime.
#[derive(Debug, Clone, Copy)]
struct Peer {
    master_id: MasterId,
    key: EncryptionInfo,
    peer_id: IdentityKey,
}

/// Security handler for Sony camera Just Works bonding.
///
/// - First connection: pairs, stores keys in RAM, camera remembers the tracker
/// - Subsequent connections: re-encrypts with stored keys → no pairing dialog
struct SonyBonder {
    peer: Cell<Option<Peer>>,
    secured: Signal<ThreadModeRawMutex, bool>,
}

impl SonyBonder {
    const fn new() -> Self {
        Self {
            peer: Cell::new(None),
            secured: Signal::new(),
        }
    }

    /// Load bond data from SD card into the in-RAM cache.
    async fn load_from_sd(&self) {
        let Some(raw) = storage::read_sony_bond().await else {
            defmt::info!("[sony_gps] no bond file on SD");
            return;
        };
        let Some(peer) = Peer::from_raw(&raw) else {
            defmt::warn!("[sony_gps] invalid bond file on SD, discarding");
            let _ = storage::delete_sony_bond().await;
            return;
        };
        defmt::info!("[sony_gps] loaded bond from SD");
        self.peer.set(Some(peer));
    }

    /// If bond data was received during pairing, persist it to SD card.
    async fn save_bond_to_sd(&self) {
        let Some(peer) = self.peer.get() else {
            return; // No bond to save (re-encryption path).
        };
        let raw = peer.to_raw();
        if storage::write_sony_bond(&raw).await {
            defmt::info!("[sony_gps] bond saved to SD");
        } else {
            defmt::warn!("[sony_gps] failed to save bond to SD");
        }
    }

    fn has_bond(&self) -> bool {
        self.peer.get().is_some()
    }

    async fn clear_bond(&self) {
        self.peer.set(None);
        if storage::delete_sony_bond().await {
            defmt::info!("[sony_gps] bond cleared from SD");
        } else {
            defmt::warn!("[sony_gps] failed to clear bond from SD");
        }
    }

    fn peer_address(&self) -> Option<Address> {
        self.peer.get().map(|peer| peer.peer_id.addr)
    }
}

impl SecurityHandler for SonyBonder {
    fn io_capabilities(&self) -> IoCapabilities {
        IoCapabilities::None // Just Works
    }

    fn can_bond(&self, _conn: &Connection) -> bool {
        true
    }

    fn on_bonded(
        &self,
        _conn: &Connection,
        master_id: MasterId,
        key: EncryptionInfo,
        peer_id: IdentityKey,
    ) {
        defmt::info!("[sony_gps] bonded with camera");
        self.peer.set(Some(Peer {
            master_id,
            key,
            peer_id,
        }));
    }

    fn on_security_update(&self, _conn: &Connection, security_mode: SecurityMode) {
        let secure = !matches!(security_mode, SecurityMode::NoAccess | SecurityMode::Open);
        defmt::info!("[sony_gps] security update: secure={}", secure);
        self.secured.signal(secure);
    }

    fn get_peripheral_key(&self, conn: &Connection) -> Option<(MasterId, EncryptionInfo)> {
        self.peer.get().and_then(|peer| {
            peer.peer_id
                .is_match(conn.peer_address())
                .then_some((peer.master_id, peer.key))
        })
    }

    fn get_key(&self, _conn: &Connection, master_id: MasterId) -> Option<EncryptionInfo> {
        self.peer
            .get()
            .and_then(|peer| (master_id == peer.master_id).then_some(peer.key))
    }
}

// ─── Bond serialization ──────────────────────────────────────────────────
//
// On-disk binary format (SONY.BND, 50 bytes):
//   [0..2)   ediv:      u16 LE
//   [2..10)  rand:      [u8; 8]
//   [10..26) ltk:       [u8; 16]
//   [26..27) enc_flags: u8
//   [27..43) irk:       [u8; 16]
//   [43..44) addr_type: u8
//   [44..50) addr:      [u8; 6]

impl Peer {
    fn to_raw(&self) -> [u8; storage::SONY_BOND_SIZE] {
        let mut buf = [0u8; storage::SONY_BOND_SIZE];
        buf[..2].copy_from_slice(&self.master_id.ediv.to_le_bytes());
        buf[2..10].copy_from_slice(&self.master_id.rand);
        buf[10..26].copy_from_slice(&self.key.ltk);
        buf[26] = self.key.flags;
        buf[27..43].copy_from_slice(&self.peer_id.irk.as_raw().irk);
        buf[43] = self.peer_id.addr.flags;
        buf[44..50].copy_from_slice(&self.peer_id.addr.bytes);
        buf
    }

    fn from_raw(buf: &[u8; storage::SONY_BOND_SIZE]) -> Option<Self> {
        let ediv = u16::from_le_bytes(buf[..2].try_into().ok()?);
        let mut rand = [0u8; 8];
        rand.copy_from_slice(&buf[2..10]);
        let mut ltk = [0u8; 16];
        ltk.copy_from_slice(&buf[10..26]);
        let enc_flags = buf[26];
        let mut irk = [0u8; 16];
        irk.copy_from_slice(&buf[27..43]);
        let addr_flags = buf[43];
        let mut addr_bytes = [0u8; 6];
        addr_bytes.copy_from_slice(&buf[44..50]);

        Some(Peer {
            master_id: MasterId { ediv, rand },
            key: EncryptionInfo {
                ltk,
                flags: enc_flags,
            },
            peer_id: IdentityKey {
                irk: nrf_softdevice::ble::IdentityResolutionKey::from_raw(raw::ble_gap_irk_t {
                    irk,
                }),
                addr: Address::new(AddressType::try_from(addr_flags >> 1).ok()?, addr_bytes),
            },
        })
    }
}

static SONY_BONDER: StaticCell<SonyBonder> = StaticCell::new();

async fn wait_for_security_update(bonder: &SonyBonder) -> Option<bool> {
    match with_timeout(SECURITY_TIMEOUT, bonder.secured.wait()).await {
        Ok(secure) => Some(secure),
        Err(_) => {
            defmt::warn!("[sony_gps] security update timeout");
            None
        }
    }
}

async fn drop_failed_security(
    conn: &Connection,
    bonder: &SonyBonder,
    had_bond: bool,
    reason: &'static str,
) {
    if had_bond {
        defmt::warn!("[sony_gps] stale bond detected: {=str}", reason);
        bonder.clear_bond().await;
    } else {
        defmt::warn!("[sony_gps] pairing/security failed: {=str}", reason);
    }
    let _ = conn.disconnect();
}

async fn drop_security_timeout(conn: &Connection, reason: &'static str) {
    defmt::warn!("[sony_gps] security timeout, keeping bond: {=str}", reason);
    let _ = conn.disconnect();
}

// ─── Sony GPS Data Packet (95 bytes) ────────────────────────────────────

/// Fixed magic prefix prepended to every GPS data packet.
const SONY_GEO_PREFIX: [u8; 11] = [
    0x00, 0x5d, 0x08, 0x02, 0xfc, 0x03, 0x00, 0x00, 0x10, 0x10, 0x10,
];

/// Build a 95-byte Sony GPS data packet from system info.
fn build_geo_packet(
    lat: f64,
    lon: f64,
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> [u8; 95] {
    let mut buf = [0u8; 95];

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

    // Bytes 91-92: UTC offset in minutes as big-endian u16.
    // GPS time from NMEA is already UTC, so offset is 0
    // (matches furble's behavior).
    let offset: u16 = 0;
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

struct SonyAdvMatch {
    addr: Address,
    pairable: bool,
    mode22: u8,
}

/// Check if a BLE advertisement report is from a Sony camera.
///
/// For first pairing we prefer `pairable`, but after a camera has bonded it may
/// stop setting the pairing-enabled bit while still advertising the Sony camera
/// service bits. Returning those reports lets us recover the address if the
/// local address cache is missing.
fn check_sony_adv(report: &raw::ble_gap_evt_adv_report_t) -> Option<SonyAdvMatch> {
    let data = unsafe { core::slice::from_raw_parts(report.data.p_data, report.data.len as usize) };

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
                if adv.company_id == SONY_COMPANY_ID && adv.camera_type == SONY_CAMERA_TYPE {
                    let pairable =
                        (adv.mode22 & SONY_MODE22_PAIRING_REQUIRED) == SONY_MODE22_PAIRING_REQUIRED;
                    if pairable || (adv.mode22 & SONY_MODE22_SERVICE_BITS) != 0 {
                        return Some(SonyAdvMatch {
                            addr: Address::from_raw(report.peer_addr),
                            pairable,
                            mode22: adv.mode22,
                        });
                    }
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
/// - `client.location_data_write(&buf)` — DD11
#[nrf_softdevice::gatt_client(uuid = "8000dd00-dd00-ffff-ffff-ffffffffffff")]
struct SonyLocationClient {
    /// DD30: allow location injection (write 0x01 to enable)
    #[characteristic(uuid = "dd30", read, write)]
    allow: u8,

    /// DD31: enable location injection (write 0x01 to enable)
    #[characteristic(uuid = "dd31", read, write)]
    enable: u8,

    /// DD11: GPS/time data packet (95 bytes)
    #[characteristic(uuid = "dd11", write, write_without_response)]
    location_data: [u8; 95],
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

    let bonder = SONY_BONDER.init(SonyBonder::new());

    // Load previously bonded camera keys from SD card so reconnection
    // can encrypt silently (no pairing dialog).
    defmt::info!("[sony_gps] loading bond from SD...");
    bonder.load_from_sd().await;
    let mut bond_verified = false;
    let mut cached_camera_addr = bonder.peer_address();
    match cached_camera_addr {
        Some(addr) => {
            defmt::info!(
                "[sony_gps] cached camera address from bond: {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                addr.bytes[5],
                addr.bytes[4],
                addr.bytes[3],
                addr.bytes[2],
                addr.bytes[1],
                addr.bytes[0]
            );
        }
        None => {
            defmt::info!("[sony_gps] no cached camera address");
        }
    }

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
        let guard = ADV_SCHEDULER.acquire(AdvPriority::SonyCentral).await;
        let target_addr = match cached_camera_addr {
            Some(addr) => {
                defmt::info!(
                    "[sony_gps] using saved camera address: {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                    addr.bytes[5],
                    addr.bytes[4],
                    addr.bytes[3],
                    addr.bytes[2],
                    addr.bytes[1],
                    addr.bytes[0]
                );
                addr
            }
            None => {
                let mut camera_addr: Option<Address> = None;

                defmt::info!("[sony_gps] scanning for Sony cameras...");

                let scan_config = central::ScanConfig {
                    active: true,
                    interval: 160,                     // 100ms
                    window: 80,                        // 50ms
                    timeout: SCAN_DURATION_SECS * 100, // units of 10ms
                    ..Default::default()
                };

                let scan_result = with_timeout(
                    SCAN_WATCHDOG,
                    central::scan(sd, &scan_config, |report| {
                        if let Some(matched) = check_sony_adv(report) {
                            let addr = matched.addr;
                            defmt::info!(
                                "[sony_gps] found Sony camera: {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}, pairable={}, mode22=0x{:02x}",
                                addr.bytes[5],
                                addr.bytes[4],
                                addr.bytes[3],
                                addr.bytes[2],
                                addr.bytes[1],
                                addr.bytes[0],
                                matched.pairable,
                                matched.mode22,
                            );
                            // The closure captures `camera_addr` by mutable reference.
                            // When scan() returns, the borrow is released.
                            camera_addr = Some(addr);
                            return Some(());
                        }
                        None
                    }),
                )
                .await;

                match scan_result {
                    Ok(Ok(())) => {
                        // camera_addr was set in the scan callback
                    }
                    Ok(Err(central::ScanError::Timeout)) => {
                        defmt::info!("[sony_gps] scan timeout, no Sony camera found");
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                    Ok(Err(e)) => {
                        defmt::warn!("[sony_gps] scan error: {:?}", e);
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                    Err(_) => {
                        defmt::warn!("[sony_gps] scan watchdog timeout");
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                }

                match camera_addr {
                    Some(addr) => {
                        cached_camera_addr = Some(addr);
                        addr
                    }
                    None => {
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                }
            }
        };

        // ── Connect to camera ───────────────────────────────────────
        defmt::info!("[sony_gps] connecting to camera...");

        let conn_params = raw::ble_gap_conn_params_t {
            min_conn_interval: 12, // 15ms
            max_conn_interval: 24, // 30ms
            slave_latency: 0,
            conn_sup_timeout: 400, // 4s
        };

        let connect_config = central::ConnectConfig {
            att_mtu: if bond_verified && bonder.has_bond() {
                Some(SONY_REQUIRED_ATT_MTU)
            } else {
                Some(raw::BLE_GATT_ATT_MTU_DEFAULT as u16)
            },
            scan_config: central::ScanConfig {
                whitelist: Some(&[&target_addr]),
                ..Default::default()
            },
            conn_params,
            ..Default::default()
        };

        bonder.secured.reset();

        let conn = match with_timeout(
            CONNECT_TIMEOUT,
            central::connect_with_security(sd, &connect_config, bonder),
        )
        .await
        {
            Ok(Ok(c)) => {
                defmt::info!("[sony_gps] connected to camera");
                c
            }
            Ok(Err(e)) => {
                defmt::warn!("[sony_gps] connect error: {:?}", e);
                drop(guard);
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
            Err(_) => {
                defmt::warn!("[sony_gps] connect timeout");
                drop(guard);
                Timer::after(RECONNECT_DELAY).await;
                continue;
            }
        };

        // ── Establish encrypted link ─────────────────────────────────────
        //
        // Try re-encrypting with stored keys first. If the camera was bonded
        // in a previous session, encrypt() uses saved keys → link encrypts
        // silently (no pairing dialog).
        //
        // If no stored keys (first connection, or reboot), fall back to
        // request_pairing(). The camera shows a dialog once; subsequent
        // reconnects are seamless.
        let had_bond = bonder.has_bond();
        let encrypted = match conn.encrypt() {
            Ok(()) => {
                defmt::info!("[sony_gps] encryption started with stored bond");
                // Encryption procedure in progress, wait for completion
                match wait_for_security_update(bonder).await {
                    Some(secure) => secure,
                    None => {
                        drop_security_timeout(&conn, "stored-bond encryption").await;
                        bond_verified = false;
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                }
            }
            Err(EncryptError::PeerKeysNotFound) => {
                defmt::info!("[sony_gps] no stored keys, requesting pairing");
                if let Err(e) = conn.request_pairing() {
                    defmt::warn!("[sony_gps] pairing request failed: {:?}", e);
                    drop_failed_security(&conn, bonder, false, "pairing request failed").await;
                    bond_verified = false;
                    drop(guard);
                    Timer::after(RECONNECT_DELAY).await;
                    continue;
                }
                match wait_for_security_update(bonder).await {
                    Some(secure) => secure,
                    None => {
                        drop_security_timeout(&conn, "pairing").await;
                        bond_verified = false;
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                }
            }
            Err(e) => {
                defmt::warn!("[sony_gps] encrypt error: {:?}, falling back to pairing", e);
                if let Err(e) = conn.request_pairing() {
                    defmt::warn!("[sony_gps] pairing request failed: {:?}", e);
                    drop_failed_security(&conn, bonder, had_bond, "pairing request failed").await;
                    if had_bond {
                        cached_camera_addr = None;
                    }
                    bond_verified = false;
                    drop(guard);
                    Timer::after(RECONNECT_DELAY).await;
                    continue;
                }
                match wait_for_security_update(bonder).await {
                    Some(secure) => secure,
                    None => {
                        drop_security_timeout(&conn, "pairing fallback").await;
                        bond_verified = false;
                        drop(guard);
                        Timer::after(RECONNECT_DELAY).await;
                        continue;
                    }
                }
            }
        };

        if encrypted {
            let current_mtu = conn.att_mtu();
            defmt::info!("[sony_gps] link encrypted, mtu={}", current_mtu);
            // Bond data is set by the on_bonded callback (fires in the same
            // event batch as on_security_update). Persist to SD so reboots
            // don't require re-pairing.
            if had_bond {
                defmt::debug!("[sony_gps] existing bond verified, skip SD save");
            } else {
                bonder.save_bond_to_sd().await;
            }
            bond_verified = true;
            cached_camera_addr = bonder.peer_address().or(Some(target_addr));
            if current_mtu < SONY_REQUIRED_ATT_MTU {
                defmt::info!(
                    "[sony_gps] encrypted with mtu={}, reconnecting for mtu>={}",
                    current_mtu,
                    SONY_REQUIRED_ATT_MTU
                );
                let _ = conn.disconnect();
                drop(guard);
                Timer::after_millis(500).await;
                continue;
            }
        } else {
            bond_verified = false;
            drop_failed_security(&conn, bonder, had_bond, "link not encrypted").await;
            if had_bond {
                cached_camera_addr = None;
            }
            drop(guard);
            Timer::after(RECONNECT_DELAY).await;
            continue;
        }

        // ── Discover Location Service ───────────────────────────────
        defmt::info!("[sony_gps] discovering location service...");

        let client: SonyLocationClient =
            match with_timeout(DISCOVER_TIMEOUT, gatt_client::discover(&conn)).await {
                Ok(Ok(c)) => {
                    defmt::info!("[sony_gps] location service discovered");
                    c
                }
                Ok(Err(e)) => {
                    defmt::warn!("[sony_gps] discover error: {:?}", e);
                    let _ = conn.disconnect();
                    drop(guard);
                    Timer::after(RECONNECT_DELAY).await;
                    continue;
                }
                Err(_) => {
                    defmt::warn!("[sony_gps] discover timeout");
                    let _ = conn.disconnect();
                    drop(guard);
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

            match client.location_data_write(&packet).await {
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
        drop(guard);
        defmt::info!("[sony_gps] disconnected from camera");
        // Loop back to scanning
    }
}
