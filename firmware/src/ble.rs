use core::cell::RefCell;
use core::cmp;
use core::sync::atomic::{AtomicBool, Ordering};

use bt_hci::cmd::le::LeSetExtAdvEnable;
use bt_hci::param::{AddrKind, BdAddr};
use embassy_executor::task;
use embassy_futures::select::{select3, Either3};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::channel::Channel;
use embassy_sync::mutex::Mutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Instant, Timer};
use heapless::Vec;
use nrf_sdc::SoftdeviceController;
use trouble_host::prelude::*;

use crate::protocol::FileTransferProtocol;

pub const DEVICE_NAME: &str = "MGT GPS Tracker";
const NUS_SERVICE_UUID_BYTES: [u8; 16] = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9e_u128.to_le_bytes();
const MAX_GATT_PAYLOAD: usize = 244;
const NUS_ADV_FAST_INTERVAL_MS: u64 = 40;
const NUS_ADV_SLOW_INTERVAL_MS: u64 = 1285;
const FINDMY_ADV_INTERVAL_MS: u64 = 2000;
const FAST_ADV_BOOT_SECS: u64 = 30;
const FAST_ADV_TRIGGER_SECS: u64 = 10;

pub type BleController = SoftdeviceController<'static>;
pub type BleResources = HostResources<DefaultPacketPool, 1, 2, 2>;
pub type BleStack = Stack<'static, BleController, DefaultPacketPool>;

#[derive(Clone, Copy)]
pub struct FindMyAdvData {
    pub payload: [u8; 31],
    pub addr: [u8; 6],
}

static RX_CHANNEL: Channel<CriticalSectionRawMutex, Vec<u8, MAX_GATT_PAYLOAD>, 8> = Channel::new();
static FINDMY_ADV: BlockingMutex<CriticalSectionRawMutex, RefCell<Option<FindMyAdvData>>> =
    BlockingMutex::new(RefCell::new(None));
static BLE_RECONFIG_SIGNAL: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static FAST_ADV_REQUESTED: AtomicBool = AtomicBool::new(false);
// Kept in .bss so the ~40 KB AGNSS buffer inside FileTransferProtocol never touches the call stack.
static PROTOCOL: Mutex<CriticalSectionRawMutex, FileTransferProtocol> =
    Mutex::new(FileTransferProtocol::new());

#[gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
pub(crate) struct NusService {
    #[characteristic(
        uuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
        write,
        write_without_response
    )]
    rx: Vec<u8, MAX_GATT_PAYLOAD>,
    #[characteristic(uuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e", notify)]
    tx: Vec<u8, MAX_GATT_PAYLOAD>,
}

#[gatt_server]
pub(crate) struct Server {
    nus: NusService,
}

pub fn init_server() -> Server<'static> {
    Server::new_default(DEVICE_NAME).expect("GATT server init")
}

pub fn read_ficr_static_random_addr() -> [u8; 6] {
    let low = nrf_pac::FICR.deviceaddr(0).read();
    let high = nrf_pac::FICR.deviceaddr(1).read();
    let mut addr = [
        (low & 0xFF) as u8,
        ((low >> 8) & 0xFF) as u8,
        ((low >> 16) & 0xFF) as u8,
        ((low >> 24) & 0xFF) as u8,
        (high & 0xFF) as u8,
        ((high >> 8) & 0xFF) as u8,
    ];
    addr[5] |= 0xC0;
    addr
}

#[allow(dead_code)]
pub fn set_findmy_adv(data: Option<FindMyAdvData>) {
    FINDMY_ADV.lock(|cell| {
        *cell.borrow_mut() = data;
    });
    BLE_RECONFIG_SIGNAL.signal(());
}

pub fn request_fast_advertising() {
    FAST_ADV_REQUESTED.store(true, Ordering::Release);
    BLE_RECONFIG_SIGNAL.signal(());
}

#[task]
pub async fn ble_runner_task(mut runner: Runner<'static, BleController, DefaultPacketPool>) -> ! {
    loop {
        if let Err(err) = runner.run().await {
            defmt::warn!("BLE runner error: {:?}", err);
        }
    }
}

#[task]
pub async fn ble_task(stack: &'static BleStack, server: &'static Server<'static>) -> ! {
    let mut adv_buf = [0u8; 31];
    let adv_len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids128(&[NUS_SERVICE_UUID_BYTES]),
        ],
        &mut adv_buf,
    )
    .expect("NUS adv encode");
    let mut scan_buf = [0u8; 31];
    let scan_len = AdStructure::encode_slice(
        &[AdStructure::CompleteLocalName(DEVICE_NAME.as_bytes())],
        &mut scan_buf,
    )
    .expect("NUS scan encode");

    let mut peripheral = stack.peripheral();
    let rx_handle = server.nus.rx.handle;
    let findmy_params = AdvertisementParameters {
        interval_min: Duration::from_millis(FINDMY_ADV_INTERVAL_MS),
        interval_max: Duration::from_millis(FINDMY_ADV_INTERVAL_MS),
        own_addr_kind: Some(AddrKind::RANDOM),
        ..Default::default()
    };

    let mut fast_deadline = Some(Instant::now() + Duration::from_secs(FAST_ADV_BOOT_SECS));

    loop {
        BLE_RECONFIG_SIGNAL.reset();
        if FAST_ADV_REQUESTED.swap(false, Ordering::AcqRel) {
            fast_deadline = Some(Instant::now() + Duration::from_secs(FAST_ADV_TRIGGER_SECS));
        }

        let in_fast = match fast_deadline {
            Some(deadline) if Instant::now() < deadline => true,
            _ => {
                fast_deadline = None;
                false
            }
        };

        let nus_interval_ms = if in_fast {
            NUS_ADV_FAST_INTERVAL_MS
        } else {
            NUS_ADV_SLOW_INTERVAL_MS
        };
        let nus_params = AdvertisementParameters {
            interval_min: Duration::from_millis(nus_interval_ms),
            interval_max: Duration::from_millis(nus_interval_ms),
            own_addr_kind: Some(AddrKind::RANDOM),
            ..Default::default()
        };

        let nus_set = AdvertisementSet {
            params: nus_params,
            data: Advertisement::ConnectableScannableUndirected {
                adv_data: &adv_buf[..adv_len],
                scan_data: &scan_buf[..scan_len],
            },
            address: None,
        };

        let findmy_opt = FINDMY_ADV.lock(|cell| *cell.borrow());

        // Clear any lingering extended-adv set (e.g. Find My Set 1 while Set 0 connected)
        // so LeSetExtAdvParams never fails with Command Disallowed (0x0C).
        let _ = stack.command(LeSetExtAdvEnable::new(false, &[])).await;

        let advertiser = if let Some(fm) = findmy_opt {
            let sets = [
                nus_set,
                AdvertisementSet {
                    params: findmy_params,
                    data: Advertisement::NonconnectableNonscannableUndirected {
                        adv_data: &fm.payload,
                    },
                    address: Some(BdAddr::new(fm.addr)),
                },
            ];
            let mut handles = AdvertisementSet::handles(&sets);
            peripheral.advertise_ext(&sets, &mut handles).await
        } else {
            let sets = [nus_set];
            let mut handles = AdvertisementSet::handles(&sets);
            peripheral.advertise_ext(&sets, &mut handles).await
        };

        let advertiser = match advertiser {
            Ok(adv) => adv,
            Err(err) => {
                defmt::warn!("BLE advertise_ext error: {:?}", err);
                Timer::after_secs(1).await;
                continue;
            }
        };
        defmt::debug!(
            "BLE advertise_ext active: fast={} findmy={}",
            in_fast,
            findmy_opt.is_some()
        );

        let deadline_fut = async {
            if let Some(deadline) = fast_deadline {
                Timer::at(deadline).await;
            } else {
                core::future::pending::<()>().await;
            }
        };

        let conn = match select3(advertiser.accept(), BLE_RECONFIG_SIGNAL.wait(), deadline_fut).await
        {
            Either3::First(Ok(conn)) => conn,
            Either3::First(Err(err)) => {
                defmt::warn!("BLE accept error: {:?}", err);
                continue;
            }
            Either3::Second(()) | Either3::Third(()) => continue,
        };

        defmt::info!("BLE client connected");
        let gatt_conn = match conn.with_attribute_server(server) {
            Ok(gc) => gc,
            Err(err) => {
                defmt::warn!("BLE attribute server attach error: {:?}", err);
                continue;
            }
        };

        RX_CHANNEL.clear();
        {
            let mut protocol = PROTOCOL.lock().await;
            protocol.reset();
        }

        let gatt_fut = async {
            loop {
                match gatt_conn.next().await {
                    GattConnectionEvent::Disconnected { reason } => {
                        defmt::info!("BLE disconnected: {:?}", reason);
                        break;
                    }
                    GattConnectionEvent::Gatt { event } => match event {
                        GattEvent::Write(write_ev) => {
                            let handle = write_ev.handle();
                            let mut payload = Vec::<u8, MAX_GATT_PAYLOAD>::new();
                            write_ev.with_data(|_, data| {
                                let _ = payload.extend_from_slice(data);
                            });
                            if let Ok(reply) = write_ev.accept() {
                                reply.send().await;
                            }
                            if handle == rx_handle && !payload.is_empty() {
                                let _ = RX_CHANNEL.try_send(payload);
                            }
                        }
                        other => {
                            if let Ok(reply) = other.accept() {
                                reply.send().await;
                            }
                        }
                    },
                    _ => {}
                }
            }
        };

        let rx_fut = async {
            loop {
                let data = RX_CHANNEL.receive().await;
                let mut protocol = PROTOCOL.lock().await;
                process_bytes(&mut protocol, &gatt_conn, server, &data).await;
            }
        };

        let link_opt_fut = async {
            Timer::after_millis(600).await;
            let raw_conn = gatt_conn.raw();
            let _ = with_timeout(
                Duration::from_millis(500),
                raw_conn.update_data_length(stack, 251, 2120),
            )
            .await;
            let _ = with_timeout(
                Duration::from_millis(500),
                raw_conn.set_phy(stack, PhyKind::Le2M),
            )
            .await;
            let conn_params = RequestedConnParams {
                min_connection_interval: Duration::from_micros(7500),
                max_connection_interval: Duration::from_millis(15),
                max_latency: 0,
                min_event_length: Duration::from_secs(0),
                max_event_length: Duration::from_secs(0),
                supervision_timeout: Duration::from_secs(4),
            };
            let _ = with_timeout(
                Duration::from_millis(500),
                raw_conn.update_connection_params(stack, &conn_params),
            )
            .await;
            core::future::pending::<()>().await
        };

        let _ = select3(gatt_fut, rx_fut, link_opt_fut).await;
        fast_deadline = Some(Instant::now() + Duration::from_secs(FAST_ADV_TRIGGER_SECS));
    }
}

async fn process_bytes(
    protocol: &mut FileTransferProtocol,
    gatt_conn: &GattConnection<'_, '_, DefaultPacketPool>,
    server: &Server<'_>,
    data: &[u8],
) {
    for &byte in data {
        if let Some(len) = protocol.push_byte(byte).await {
            ble_send(gatt_conn, server, protocol.response(len)).await;
        }
    }
}

async fn ble_send(
    gatt_conn: &GattConnection<'_, '_, DefaultPacketPool>,
    server: &Server<'_>,
    data: &[u8],
) {
    let mtu_payload = gatt_conn.raw().att_mtu().saturating_sub(3) as usize;
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
        if let Err(err) = server.nus.tx.notify(gatt_conn, &chunk, false).await {
            defmt::warn!("BLE notify failed: {:?}", err);
            break;
        }
        offset += chunk_len;
    }
}
