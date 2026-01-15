use core::cmp;

use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use heapless::Vec;
use nrf_softdevice::ble::advertisement_builder::{
    Flag, LegacyAdvertisementBuilder, LegacyAdvertisementPayload, ServiceList,
};
use nrf_softdevice::ble::{gatt_server, peripheral, Connection, PhySet};
use nrf_softdevice::Softdevice;

use crate::protocol::FileTransferProtocol;

pub const DEVICE_NAME: &str = "MGT GPS Tracker";
const NUS_SERVICE_UUID: u128 = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9e_u128;
const MAX_GATT_PAYLOAD: usize = 244;

static RX_CHANNEL: Channel<CriticalSectionRawMutex, Vec<u8, MAX_GATT_PAYLOAD>, 8> = Channel::new();

static ADV_DATA: LegacyAdvertisementPayload = LegacyAdvertisementBuilder::new()
    .flags(&[Flag::GeneralDiscovery, Flag::LE_Only])
    .services_128(ServiceList::Complete, &[NUS_SERVICE_UUID.to_le_bytes()])
    .build();

static SCAN_DATA: LegacyAdvertisementPayload = LegacyAdvertisementBuilder::new()
    .full_name(DEVICE_NAME)
    .build();

#[nrf_softdevice::gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
struct NusService {
    #[characteristic(
        uuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
        write,
        write_without_response,
        value = "heapless::Vec::<u8, MAX_GATT_PAYLOAD>::new()"
    )]
    rx: Vec<u8, MAX_GATT_PAYLOAD>,
    #[characteristic(
        uuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
        notify,
        value = "heapless::Vec::<u8, MAX_GATT_PAYLOAD>::new()"
    )]
    tx: Vec<u8, MAX_GATT_PAYLOAD>,
}

#[nrf_softdevice::gatt_server]
pub(crate) struct Server {
    nus: NusService,
}

pub fn init_server(sd: &mut Softdevice) -> Result<Server, gatt_server::RegisterError> {
    Server::new(sd)
}

#[task]
pub async fn ble_task(sd: &'static Softdevice, server: &'static Server) {
    loop {
        let config = peripheral::Config {
            interval: 32,
            timeout: Some(3000),
            ..Default::default()
        };
        let adv = peripheral::ConnectableAdvertisement::ScannableUndirected {
            adv_data: &ADV_DATA,
            scan_data: &SCAN_DATA,
        };

        let conn = match peripheral::advertise_connectable(sd, adv, &config).await {
            Ok(conn) => conn,
            Err(err) => {
                defmt::warn!("BLE advertise error: {:?}", err);
                continue;
            }
        };

        let mut conn = conn;
        let _ = conn.data_length_update(None);
        let _ = conn.phy_update(PhySet::M2, PhySet::M2);

        RX_CHANNEL.clear();
        let mut protocol = FileTransferProtocol::new();

        let rx_fut = async {
            loop {
                let data = RX_CHANNEL.receive().await;
                process_bytes(&mut protocol, &conn, &server, &data).await;
            }
        };

        let gatt_fut = gatt_server::run(&conn, server, |event| match event {
            ServerEvent::Nus(evt) => match evt {
                NusServiceEvent::RxWrite(data) => {
                    let _ = RX_CHANNEL.try_send(data);
                }
                NusServiceEvent::TxCccdWrite { notifications } => {
                    defmt::info!("BLE notifications enabled: {}", notifications);
                }
            },
        });

        match select(gatt_fut, rx_fut).await {
            Either::First(_) => {
                defmt::info!("BLE disconnected");
            }
            Either::Second(_) => {}
        }
    }
}

async fn process_bytes(
    protocol: &mut FileTransferProtocol,
    conn: &Connection,
    server: &Server,
    data: &[u8],
) {
    for &byte in data {
        if let Some(len) = protocol.push_byte(byte).await {
            ble_send(conn, server, protocol.response(len)).await;
        }
    }
}

async fn ble_send(conn: &Connection, server: &Server, data: &[u8]) {
    let mtu_payload = conn.att_mtu().saturating_sub(3) as usize;
    let max_payload = cmp::min(mtu_payload, MAX_GATT_PAYLOAD);
    if max_payload == 0 {
        return;
    }

    let mut offset = 0usize;
    while offset < data.len() {
        let chunk_len = cmp::min(max_payload, data.len() - offset);
        let mut chunk: Vec<u8, MAX_GATT_PAYLOAD> = Vec::new();
        if chunk.extend_from_slice(&data[offset..offset + chunk_len]).is_err() {
            break;
        }
        if let Err(err) = server.nus.tx_notify(conn, &chunk) {
            defmt::warn!("BLE notify failed: {:?}", err);
            break;
        }
        offset += chunk_len;
    }
}
