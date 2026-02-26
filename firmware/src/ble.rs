use core::cmp;
use core::sync::atomic::{AtomicU16, Ordering};

use embassy_executor::task;
use embassy_futures::select::{select, Either};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_sync::signal::Signal;
use heapless::Vec;
use nrf_softdevice::ble::advertisement_builder::{
    Flag, LegacyAdvertisementBuilder, LegacyAdvertisementPayload, ServiceList,
};
use nrf_softdevice::ble::{gatt_server, peripheral, Connection, PhySet};
use nrf_softdevice::Softdevice;

use crate::adv_scheduler::{AdvPriority, ADV_SCHEDULER};
use crate::protocol::FileTransferProtocol;

pub const DEVICE_NAME: &str = "MGT GPS Tracker";
const NUS_SERVICE_UUID: u128 = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9e_u128;
const MAX_GATT_PAYLOAD: usize = 244;
const ADV_INTERVAL_UNITS: u32 = 32; // 20ms (units of 0.625ms).
const ADV_TIMEOUT_BOOT_10MS: u16 = 3000; // 30s (units of 10ms).
const ADV_TIMEOUT_FAST_10MS: u16 = 500; // 5s (units of 10ms).
const CONN_MIN_INTERVAL: u16 = 6; // 7.5ms (units of 1.25ms).
const CONN_MAX_INTERVAL: u16 = 12; // 15ms (units of 1.25ms).
const CONN_SLAVE_LATENCY: u16 = 0;
const CONN_SUP_TIMEOUT: u16 = 400; // 4s (units of 10ms).

static RX_CHANNEL: Channel<CriticalSectionRawMutex, Vec<u8, MAX_GATT_PAYLOAD>, 8> = Channel::new();
static ADV_REQUEST_SIGNAL: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static ADV_REQUEST_TIMEOUT: AtomicU16 = AtomicU16::new(0);

static ADV_DATA: LegacyAdvertisementPayload = LegacyAdvertisementBuilder::new()
    .flags(&[Flag::GeneralDiscovery, Flag::LE_Only])
    .services_128(ServiceList::Complete, &[NUS_SERVICE_UUID.to_le_bytes()])
    .build();

static SCAN_DATA: LegacyAdvertisementPayload = LegacyAdvertisementBuilder::new()
    .full_name(DEVICE_NAME)
    .build();

#[nrf_softdevice::gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
pub(crate) struct NusService {
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

pub fn request_fast_advertising() {
    request_advertising(ADV_TIMEOUT_FAST_10MS);
}

#[task]
pub async fn ble_task(sd: &'static Softdevice, server: &'static Server) {
    let mut pending_timeout = Some(ADV_TIMEOUT_BOOT_10MS);

    loop {
        let timeout = match pending_timeout.take() {
            Some(timeout) => timeout,
            None => {
                ADV_REQUEST_SIGNAL.wait().await;
                match take_adv_request() {
                    Some(timeout) => timeout,
                    None => continue,
                }
            }
        };

        // Acquire the advertising resource (preempts FindMy if active).
        let guard = ADV_SCHEDULER.acquire(AdvPriority::MainAdv).await;

        let config = peripheral::Config {
            interval: ADV_INTERVAL_UNITS,
            timeout: Some(timeout),
            ..Default::default()
        };
        let adv = peripheral::ConnectableAdvertisement::ScannableUndirected {
            adv_data: &ADV_DATA,
            scan_data: &SCAN_DATA,
        };

        let conn = match select(
            peripheral::advertise_connectable(sd, adv, &config),
            ADV_REQUEST_SIGNAL.wait(),
        )
        .await
        {
            Either::First(Ok(conn)) => conn,
            Either::First(Err(peripheral::AdvertiseError::Timeout)) => {
                defmt::info!("BLE advertising timeout");
                drop(guard);
                continue;
            }
            Either::First(Err(err)) => {
                defmt::warn!("BLE advertise error: {:?}", err);
                drop(guard);
                continue;
            }
            Either::Second(()) => {
                drop(guard);
                pending_timeout = take_adv_request();
                continue;
            }
        };

        // Connection established — adv handle is free, release for FindMy.
        drop(guard);

        let mut conn = conn;
        let _ = conn.data_length_update(None);
        let _ = conn.phy_update(PhySet::M2, PhySet::M2);
        let mut conn_params = conn.conn_params();
        conn_params.min_conn_interval = CONN_MIN_INTERVAL;
        conn_params.max_conn_interval = CONN_MAX_INTERVAL;
        conn_params.slave_latency = CONN_SLAVE_LATENCY;
        conn_params.conn_sup_timeout = CONN_SUP_TIMEOUT;
        if let Err(err) = conn.set_conn_params(conn_params) {
            defmt::warn!("BLE conn params update failed: {:?}", err);
        }

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

        pending_timeout = take_adv_request().or(Some(timeout));
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

fn request_advertising(timeout_10ms: u16) {
    ADV_REQUEST_TIMEOUT.store(timeout_10ms, Ordering::Release);
    ADV_REQUEST_SIGNAL.signal(());
}

fn take_adv_request() -> Option<u16> {
    let timeout = ADV_REQUEST_TIMEOUT.swap(0, Ordering::AcqRel);
    if timeout == 0 {
        None
    } else {
        Some(timeout)
    }
}
