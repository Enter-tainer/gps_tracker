use core::cmp;
use core::sync::atomic::{AtomicU16, Ordering};

use embassy_futures::select::{select, Either};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::Duration;
use nrf_sdc::SoftdeviceController;
use trouble_host::prelude::*;

use crate::protocol::FileTransferProtocol;

pub const DEVICE_NAME: &str = "MGT GPS Tracker";
const MAX_GATT_PAYLOAD: usize = 244;
const ADV_TIMEOUT_BOOT: Duration = Duration::from_secs(30);
const ADV_TIMEOUT_FAST: Duration = Duration::from_secs(5);
const ADV_INTERVAL_MIN: Duration = Duration::from_micros(20_000);
const ADV_INTERVAL_MAX: Duration = Duration::from_micros(20_000);

static ADV_REQUEST_SIGNAL: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static ADV_REQUEST_TIMEOUT: AtomicU16 = AtomicU16::new(0);

#[gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
struct NusService {
    #[characteristic(uuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e", write, write_without_response, value = [0u8; MAX_GATT_PAYLOAD])]
    rx: [u8; MAX_GATT_PAYLOAD],
    #[characteristic(uuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e", notify, value = [0u8; MAX_GATT_PAYLOAD])]
    tx: [u8; MAX_GATT_PAYLOAD],
}

#[gatt_server]
pub struct Server {
    nus: NusService,
}

pub fn request_fast_advertising() {
    request_advertising(ADV_TIMEOUT_FAST);
}

/// Unified BLE task managing both main BLE (connectable) and FindMy (non-connectable)
/// advertisement sets via trouble-host extended advertising.
///
/// Design (Plan D):
/// 1. Both adv sets run simultaneously via `advertise_ext`
/// 2. On connection: accept and handle GATT; FindMy pauses during connection
/// 3. On disconnect: restart both adv sets
/// 4. On FindMy key rotation: restart adv sets with new FindMy data
pub async fn ble_unified_task(
    peripheral: &mut Peripheral<'_, SoftdeviceController<'_>, DefaultPacketPool>,
    server: &Server<'_>,
) {
    let mut pending_timeout = Some(ADV_TIMEOUT_BOOT);

    loop {
        let timeout = match pending_timeout.take() {
            Some(t) => t,
            None => {
                ADV_REQUEST_SIGNAL.wait().await;
                match take_adv_request() {
                    Some(t) => t,
                    None => continue,
                }
            }
        };

        // Build main BLE adv data
        let nus_uuid = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9eu128.to_le_bytes();
        let mut adv_data = [0u8; 31];
        let adv_len = AdStructure::encode_slice(
            &[
                AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
                AdStructure::ServiceUuids128(&[nus_uuid]),
            ],
            &mut adv_data,
        )
        .unwrap_or(0);

        let mut scan_data = [0u8; 31];
        let scan_len = AdStructure::encode_slice(
            &[AdStructure::CompleteLocalName(DEVICE_NAME.as_bytes())],
            &mut scan_data,
        )
        .unwrap_or(0);

        let main_params = AdvertisementParameters {
            primary_phy: PhyKind::Le1M,
            secondary_phy: PhyKind::Le1M,
            interval_min: ADV_INTERVAL_MIN,
            interval_max: ADV_INTERVAL_MAX,
            timeout: Some(timeout),
            ..Default::default()
        };

        // Build FindMy adv set if enabled
        #[cfg(feature = "findmy")]
        let findmy_data = crate::findmy::current_adv_data().await;

        #[cfg(feature = "findmy")]
        let findmy_enabled = findmy_data.is_some();
        #[cfg(not(feature = "findmy"))]
        let findmy_enabled = false;

        if findmy_enabled {
            #[cfg(feature = "findmy")]
            {
                let (payload, _addr) = findmy_data.unwrap();
                let findmy_params = AdvertisementParameters {
                    primary_phy: PhyKind::Le1M,
                    secondary_phy: PhyKind::Le1M,
                    interval_min: Duration::from_millis(2000),
                    interval_max: Duration::from_millis(2000),
                    ..Default::default()
                };

                // Ext connectable cannot be scannable per BLE spec, so no scan_data.
                // Device name is included in adv_data via ShortenedLocalName if space allows.
                let sets = [
                    AdvertisementSet {
                        params: main_params,
                        data: Advertisement::ExtConnectableNonscannableUndirected {
                            adv_data: &adv_data[..adv_len],
                        },
                    },
                    AdvertisementSet {
                        params: findmy_params,
                        data: Advertisement::ExtNonconnectableNonscannableUndirected {
                            anonymous: false,
                            adv_data: &payload,
                        },
                    },
                ];
                let mut handles = AdvertisementSet::handles(&sets);

                // TODO: Set per-adv-set random address for FindMy.
                // trouble-host sets the stack-level random address on all sets.
                // For FindMy we need `_addr` as the random address on set[1].
                // This may require sending LeSetAdvSetRandomAddr via bt-hci directly.

                let advertiser = match peripheral.advertise_ext(&sets, &mut handles).await {
                    Ok(adv) => adv,
                    Err(err) => {
                        defmt::warn!("BLE ext advertise error: {:?}", err);
                        embassy_time::Timer::after_millis(500).await;
                        pending_timeout = take_adv_request().or(Some(timeout));
                        continue;
                    }
                };

                // Wait for connection, key rotation, or new adv request
                let rotation_secs = crate::findmy::secs_until_rotation();

                match select(
                    advertiser.accept(),
                    select(
                        embassy_time::Timer::after(Duration::from_secs(rotation_secs)),
                        ADV_REQUEST_SIGNAL.wait(),
                    ),
                )
                .await
                {
                    Either::First(Ok(conn)) => {
                        handle_connection(conn, server).await;
                        pending_timeout = take_adv_request().or(Some(timeout));
                    }
                    Either::First(Err(_)) => {
                        defmt::info!("BLE advertising timeout/error");
                        pending_timeout = take_adv_request();
                    }
                    Either::Second(Either::First(())) => {
                        // Key rotation — restart adv sets with new FindMy data
                        defmt::info!("FindMy key rotation, restarting adv");
                        pending_timeout = Some(timeout);
                    }
                    Either::Second(Either::Second(())) => {
                        // New adv request
                        pending_timeout = take_adv_request();
                    }
                }
            }
        } else {
            // No FindMy — single connectable adv set (legacy, supports scan response)
            let sets = [AdvertisementSet {
                params: main_params,
                data: Advertisement::ConnectableScannableUndirected {
                    adv_data: &adv_data[..adv_len],
                    scan_data: &scan_data[..scan_len],
                },
            }];
            let mut handles = AdvertisementSet::handles(&sets);

            let advertiser = match peripheral.advertise_ext(&sets, &mut handles).await {
                Ok(adv) => adv,
                Err(err) => {
                    defmt::warn!("BLE advertise error: {:?}", err);
                    embassy_time::Timer::after_millis(500).await;
                    pending_timeout = take_adv_request().or(Some(timeout));
                    continue;
                }
            };

            match select(advertiser.accept(), ADV_REQUEST_SIGNAL.wait()).await {
                Either::First(Ok(conn)) => {
                    handle_connection(conn, server).await;
                    pending_timeout = take_adv_request().or(Some(timeout));
                }
                Either::First(Err(_)) => {
                    defmt::info!("BLE advertising timeout");
                    pending_timeout = take_adv_request();
                }
                Either::Second(()) => {
                    pending_timeout = take_adv_request();
                }
            }
        }
    }
}

async fn handle_connection(
    conn: Connection<'_, DefaultPacketPool>,
    server: &Server<'_>,
) {
    defmt::info!("BLE connected");

    let conn = match conn.with_attribute_server(server) {
        Ok(c) => c,
        Err(err) => {
            defmt::warn!("BLE GATT server attach failed: {:?}", err);
            return;
        }
    };

    let mut protocol = FileTransferProtocol::new();

    loop {
        match conn.next().await {
            GattConnectionEvent::Disconnected { reason } => {
                defmt::info!("BLE disconnected: {:?}", reason);
                break;
            }
            GattConnectionEvent::Gatt { event } => match event {
                GattEvent::Write(evt) => {
                    let handle = evt.handle();
                    if handle == server.nus.rx.handle {
                        let data = evt.data();
                        for &byte in data {
                            if let Some(len) = protocol.push_byte(byte).await {
                                let response = protocol.response(len);
                                ble_send(&conn, server, response).await;
                            }
                        }
                    }
                    if let Ok(reply) = evt.accept() {
                        reply.send().await;
                    }
                }
                GattEvent::Read(evt) => {
                    if let Ok(reply) = evt.accept() {
                        reply.send().await;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
}

async fn ble_send<P: PacketPool>(
    conn: &GattConnection<'_, '_, P>,
    server: &Server<'_>,
    data: &[u8],
) {
    let max_payload = MAX_GATT_PAYLOAD;
    if max_payload == 0 {
        return;
    }

    let mut offset = 0usize;
    while offset < data.len() {
        let chunk_len = cmp::min(max_payload, data.len() - offset);
        let mut buf = [0u8; MAX_GATT_PAYLOAD];
        buf[..chunk_len].copy_from_slice(&data[offset..offset + chunk_len]);
        if let Err(err) = server.nus.tx.notify(conn, &buf).await {
            defmt::warn!("BLE notify failed: {:?}", err);
            break;
        }
        offset += chunk_len;
    }
}

fn request_advertising(timeout: Duration) {
    let timeout_10ms = (timeout.as_millis() / 10) as u16;
    ADV_REQUEST_TIMEOUT.store(timeout_10ms, Ordering::Release);
    ADV_REQUEST_SIGNAL.signal(());
}

fn take_adv_request() -> Option<Duration> {
    let timeout_10ms = ADV_REQUEST_TIMEOUT.swap(0, Ordering::AcqRel);
    if timeout_10ms == 0 {
        None
    } else {
        Some(Duration::from_millis(timeout_10ms as u64 * 10))
    }
}
