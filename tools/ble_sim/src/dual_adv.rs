//! Dual concurrent BLE advertising + Nordic UART Service (NUS) server using `trouble-host`.
//!
//! Set 0: Connectable Legacy `ADV_IND` on the fixed host random MAC (`address: None`).
//! Set 1: Non-connectable Legacy `ADV_NONCONN_IND` on the rotating Apple Find My MAC (`address: Some(...)`).

use bt_hci::param::{AddrKind, BdAddr};
use embassy_time::Duration;
use trouble_host::prelude::*;

pub const DEVICE_NAME: &str = "MGT GPS Tracker";
pub const NUS_SERVICE_UUID_BYTES: [u8; 16] = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9e_u128.to_le_bytes();
pub const MAX_GATT_PAYLOAD: usize = 244;

#[gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
pub struct NusService {
    #[characteristic(
        uuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
        write,
        write_without_response
    )]
    pub rx: heapless::Vec<u8, MAX_GATT_PAYLOAD>,
    #[characteristic(uuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e", notify)]
    pub tx: heapless::Vec<u8, MAX_GATT_PAYLOAD>,
}

#[gatt_server]
pub struct TrackerServer {
    pub nus: NusService,
}

/// Encode NUS advertising and scan response payloads (each guaranteed <= 31 bytes).
pub fn encode_nus_adv_and_scan_data() -> ([u8; 31], usize, [u8; 31], usize) {
    let mut adv_buf = [0u8; 31];
    let adv_len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids128(&[NUS_SERVICE_UUID_BYTES]),
        ],
        &mut adv_buf,
    )
    .expect("NUS adv_data fits within 31 bytes");

    let mut scan_buf = [0u8; 31];
    let scan_len = AdStructure::encode_slice(
        &[AdStructure::CompleteLocalName(DEVICE_NAME.as_bytes())],
        &mut scan_buf,
    )
    .expect("NUS scan_data fits within 31 bytes");

    (adv_buf, adv_len, scan_buf, scan_len)
}

/// Build the two concurrent Legacy advertising sets:
/// - Set 0 (handle 0): NUS connectable `ADV_IND` using the host's default static random MAC (`address: None`).
/// - Set 1 (handle 1): Apple Find My non-connectable `ADV_NONCONN_IND` using `findmy_addr` (`address: Some(...)`).
pub fn build_dual_sets<'a>(
    nus_adv: &'a [u8],
    nus_scan: &'a [u8],
    findmy_payload: &'a [u8; 31],
    findmy_addr: [u8; 6],
) -> [AdvertisementSet<'a>; 2] {
    let nus_params = AdvertisementParameters {
        interval_min: Duration::from_millis(20),
        interval_max: Duration::from_millis(20),
        own_addr_kind: Some(AddrKind::RANDOM),
        ..Default::default()
    };

    let findmy_params = AdvertisementParameters {
        interval_min: Duration::from_millis(2000),
        interval_max: Duration::from_millis(2000),
        own_addr_kind: Some(AddrKind::RANDOM),
        ..Default::default()
    };

    [
        AdvertisementSet {
            params: nus_params,
            data: Advertisement::ConnectableScannableUndirected {
                adv_data: nus_adv,
                scan_data: nus_scan,
            },
            address: None,
        },
        AdvertisementSet {
            params: findmy_params,
            data: Advertisement::NonconnectableNonscannableUndirected {
                adv_data: findmy_payload,
            },
            address: Some(BdAddr::new(findmy_addr)),
        },
    ]
}

/// Process an incoming NUS RX write frame in simulation; replies via TX notify for GET_STATUS (`[0x06, 0x00, 0x00]`).
pub async fn handle_nus_write_echo<P: PacketPool>(
    server: &TrackerServer<'_>,
    gatt_conn: &GattConnection<'_, '_, P>,
    data: &[u8],
) -> Result<(), Error> {
    if data == [0x06, 0x00, 0x00] {
        let mut resp = heapless::Vec::<u8, MAX_GATT_PAYLOAD>::new();
        let _ = resp.extend_from_slice(&[0x86, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04]);
        server.nus.tx.notify(gatt_conn, &resp, false).await?;
    }
    Ok(())
}
