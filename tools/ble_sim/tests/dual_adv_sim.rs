use std::time::Duration;

use ble_sim::dual_adv::{
    build_dual_sets, encode_nus_adv_and_scan_data, handle_nus_write_echo, TrackerServer,
    DEVICE_NAME,
};
use ble_sim::findmy_crypto::{derive_advertisement, derive_key_at, reconstruct_public_key_x};
use ble_sim::sim_sdc::{create_sim_controller, AdvApiMode, SimController, SimSdcConfig};
use bt_hci::param::{AddrKind, BdAddr};
use trouble_host::prelude::*;

const TEST_PRIV_KEY: [u8; 28] = [0x11u8; 28];
const TEST_SK0: [u8; 32] = [0x22u8; 32];
const DEVICE_MAC: [u8; 6] = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xCE]; // static random: MSB 0xCE has top bits 11

#[tokio::test]
async fn test_dual_concurrent_advertising_independent_macs() {
    let (controller, sim) = create_sim_controller(SimSdcConfig::default());
    let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(Address::random(DEVICE_MAC))
        .build();
    let mut runner = stack.runner();
    let mut peripheral = stack.peripheral();

    let (nus_adv, nus_adv_len, nus_scan, nus_scan_len) = encode_nus_adv_and_scan_data();
    let (findmy_payload, findmy_addr, findmy_pub_x) =
        derive_advertisement(&TEST_PRIV_KEY, &TEST_SK0, 0, 95);
    assert_ne!(findmy_addr, DEVICE_MAC);

    let sets = build_dual_sets(
        &nus_adv[..nus_adv_len],
        &nus_scan[..nus_scan_len],
        &findmy_payload,
        findmy_addr,
    );
    let mut handles = AdvertisementSet::handles(&sets);

    tokio::select! {
        r = runner.run() => {
            panic!("runner exited unexpectedly: {r:?}");
        }
        _ = async {
            let advertiser = peripheral
                .advertise_ext(&sets, &mut handles)
                .await
                .expect("dual advertise_ext should succeed");

            let snapshot = sim.snapshot_adv_sets();
            assert_eq!(snapshot.len(), 2, "both Set 0 and Set 1 must be configured");
            assert_eq!(sim.used_adv_api(), Some(AdvApiMode::Extended));

            let s0 = snapshot.get(&0).expect("set 0 missing");
            let s1 = snapshot.get(&1).expect("set 1 missing");

            assert!(s0.enabled, "NUS set 0 must be enabled");
            assert!(s1.enabled, "Find My set 1 must be enabled simultaneously");
            assert_eq!(s0.props, 0x0013, "Set 0 must be Legacy ADV_IND (0x0013)");
            assert_eq!(
                s1.props, 0x0010,
                "Set 1 must be Legacy ADV_NONCONN_IND (0x0010)"
            );
            assert_eq!(s0.random_addr, Some(DEVICE_MAC));
            assert_eq!(s1.random_addr, Some(findmy_addr));
            assert_ne!(s0.random_addr, s1.random_addr);

            let air_payload: [u8; 31] = s1
                .adv_data
                .as_slice()
                .try_into()
                .expect("Find My adv payload must be 31 bytes");
            assert_eq!(air_payload, findmy_payload);

            let reconstructed = reconstruct_public_key_x(&s1.random_addr.unwrap(), &air_payload);
            assert_eq!(reconstructed, findmy_pub_x);
            assert_eq!(
                reconstructed,
                derive_key_at(&TEST_PRIV_KEY, &TEST_SK0, 0),
                "over-the-air key reconstruction must match derive_key_at"
            );

            drop(advertiser);
            tokio::time::sleep(Duration::from_millis(20)).await;
        } => {}
    }
}

#[tokio::test]
async fn test_findmy_rotation_preserves_nus_mac() {
    let (controller, sim) = create_sim_controller(SimSdcConfig::default());
    let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(Address::random(DEVICE_MAC))
        .build();
    let mut runner = stack.runner();
    let mut peripheral = stack.peripheral();

    let (nus_adv, nus_adv_len, nus_scan, nus_scan_len) = encode_nus_adv_and_scan_data();

    tokio::select! {
        r = runner.run() => {
            panic!("runner exited unexpectedly: {r:?}");
        }
        _ = async {
            let mut seen_findmy_macs = Vec::new();
            let mut seen_findmy_payloads = Vec::new();

            for counter in 0..3u32 {
                let (findmy_payload, findmy_addr, findmy_pub_x) =
                    derive_advertisement(&TEST_PRIV_KEY, &TEST_SK0, counter, 85);
                let sets = build_dual_sets(
                    &nus_adv[..nus_adv_len],
                    &nus_scan[..nus_scan_len],
                    &findmy_payload,
                    findmy_addr,
                );
                let mut handles = AdvertisementSet::handles(&sets);

                let advertiser = peripheral
                    .advertise_ext(&sets, &mut handles)
                    .await
                    .expect("advertise_ext rotation should succeed");

                let snapshot = sim.snapshot_adv_sets();
                let s0 = snapshot.get(&0).unwrap();
                let s1 = snapshot.get(&1).unwrap();
                assert!(s0.enabled && s1.enabled);
                assert_eq!(
                    s0.random_addr,
                    Some(DEVICE_MAC),
                    "Set 0 NUS MAC must remain fixed at counter {counter}"
                );
                assert_eq!(s1.random_addr, Some(findmy_addr));
                let air_payload: [u8; 31] = s1.adv_data.as_slice().try_into().unwrap();
                assert_eq!(
                    reconstruct_public_key_x(&findmy_addr, &air_payload),
                    findmy_pub_x
                );

                seen_findmy_macs.push(findmy_addr);
                seen_findmy_payloads.push(air_payload);

                drop(advertiser);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }

            assert_ne!(seen_findmy_macs[0], seen_findmy_macs[1]);
            assert_ne!(seen_findmy_macs[1], seen_findmy_macs[2]);
            assert_ne!(seen_findmy_macs[0], seen_findmy_macs[2]);
            assert_ne!(seen_findmy_payloads[0], seen_findmy_payloads[1]);
            assert_ne!(seen_findmy_payloads[1], seen_findmy_payloads[2]);
        } => {}
    }
}

#[tokio::test]
async fn test_nus_gatt_connection_while_findmy_stays_active() {
    let (controller, sim) = create_sim_controller(SimSdcConfig::default());
    let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(Address::random(DEVICE_MAC))
        .build();
    let mut runner = stack.runner();
    let mut peripheral = stack.peripheral();

    let server = TrackerServer::new_default(DEVICE_NAME).expect("TrackerServer init");
    let rx_handle = server.nus.rx.handle;
    let tx_handle = server.nus.tx.handle;
    let tx_cccd_handle = server
        .nus
        .tx
        .cccd_handle()
        .expect("TX notify characteristic must have CCCD")
        .handle();

    let (nus_adv, nus_adv_len, nus_scan, nus_scan_len) = encode_nus_adv_and_scan_data();
    let (findmy_payload, findmy_addr, _) = derive_advertisement(&TEST_PRIV_KEY, &TEST_SK0, 1, 70);
    let sets = build_dual_sets(
        &nus_adv[..nus_adv_len],
        &nus_scan[..nus_scan_len],
        &findmy_payload,
        findmy_addr,
    );
    let mut handles = AdvertisementSet::handles(&sets);

    tokio::select! {
        r = runner.run() => {
            panic!("runner exited unexpectedly: {r:?}");
        }
        _ = async {
            let advertiser = peripheral
                .advertise_ext(&sets, &mut handles)
                .await
                .expect("dual adv start");

            let peer_mac = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xC1];
            let conn_handle = 0x0040u16;
            sim.simulate_central_connect(0, conn_handle, peer_mac);

            let conn = advertiser
                .accept()
                .await
                .expect("accept simulated Central connection");

            // While NUS connection is active, Set 0 is disabled by connection, Set 1 (Find My) stays active!
            let snap_connected = sim.snapshot_adv_sets();
            assert!(!snap_connected.get(&0).unwrap().enabled);
            let s1_connected = snap_connected.get(&1).unwrap();
            assert!(
                s1_connected.enabled,
                "Find My Set 1 MUST remain enabled during GATT connection"
            );
            assert_eq!(s1_connected.random_addr, Some(findmy_addr));
            assert_eq!(s1_connected.adv_data.as_slice(), &findmy_payload);

            let gatt_conn = conn
                .with_attribute_server(&server)
                .expect("attach attribute server");

            let gatt_loop = async {
                loop {
                    match gatt_conn.next().await {
                        GattConnectionEvent::Disconnected { .. } => break,
                        GattConnectionEvent::Gatt { event } => match event {
                            GattEvent::Write(write_ev) => {
                                let handle = write_ev.handle();
                                let mut payload = Vec::new();
                                write_ev.with_data(|_, d| payload.extend_from_slice(d));
                                write_ev.accept().unwrap().send().await;
                                if handle == rx_handle {
                                    handle_nus_write_echo(&server, &gatt_conn, &payload)
                                        .await
                                        .expect("NUS TX notify");
                                }
                            }
                            other => {
                                other.accept().unwrap().send().await;
                            }
                        },
                        _ => {}
                    }
                }
            };

            let central_driver = async {
                // 1. Exchange MTU Request (0x02, MTU = 247 = 0x00F7 LE)
                sim.inject_att_pdu(conn_handle, &[0x02, 0xF7, 0x00]);
                let (_, mtu_rsp) = sim
                    .wait_tx_att_pdu(Duration::from_secs(2))
                    .await
                    .expect("Exchange MTU Response");
                assert_eq!(mtu_rsp[0], 0x03, "expected ATT Exchange MTU Response (0x03)");

                // 2. Enable notifications on TX CCCD via ATT Write Request (0x12)
                let mut cccd_req = Vec::from([0x12u8]);
                cccd_req.extend_from_slice(&tx_cccd_handle.to_le_bytes());
                cccd_req.extend_from_slice(&[0x01, 0x00]);
                sim.inject_att_pdu(conn_handle, &cccd_req);
                let (_, cccd_rsp) = sim
                    .wait_tx_att_pdu(Duration::from_secs(2))
                    .await
                    .expect("CCCD Write Response");
                assert_eq!(cccd_rsp, vec![0x13], "expected ATT Write Response (0x13)");

                // 3. Write GET_STATUS [0x06, 0x00, 0x00] to NUS RX via ATT Write Request (0x12)
                let mut rx_req = Vec::from([0x12u8]);
                rx_req.extend_from_slice(&rx_handle.to_le_bytes());
                rx_req.extend_from_slice(&[0x06, 0x00, 0x00]);
                sim.inject_att_pdu(conn_handle, &rx_req);

                let mut saw_write_rsp = false;
                let mut saw_tx_notify = false;
                for _ in 0..4 {
                    let (_, pdu) = sim
                        .wait_tx_att_pdu(Duration::from_secs(2))
                        .await
                        .expect("expected Write Rsp and TX Notification");
                    if pdu == [0x13] {
                        saw_write_rsp = true;
                    } else if pdu.first() == Some(&0x1B) {
                        let h = u16::from_le_bytes([pdu[1], pdu[2]]);
                        assert_eq!(h, tx_handle, "notification must come from NUS TX handle");
                        assert_eq!(&pdu[3..], &[0x86, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04]);
                        saw_tx_notify = true;
                    }
                    if saw_write_rsp && saw_tx_notify {
                        break;
                    }
                }
                assert!(saw_write_rsp && saw_tx_notify);

                // Set 1 still enabled after GATT traffic
                assert!(sim.snapshot_adv_sets().get(&1).unwrap().enabled);

                // 4. Disconnect
                sim.simulate_disconnect(conn_handle, 0x13);
            };

            tokio::join!(gatt_loop, central_driver);
            drop(gatt_conn);

            // Resume dual advertising and verify both Set 0 and Set 1 are enabled again
            let advertiser2 = peripheral
                .advertise_ext(&sets, &mut handles)
                .await
                .expect("resume dual advertising after disconnect");
            let snap_resumed = sim.snapshot_adv_sets();
            assert!(snap_resumed.get(&0).unwrap().enabled);
            assert!(snap_resumed.get(&1).unwrap().enabled);
            drop(advertiser2);
            tokio::time::sleep(Duration::from_millis(20)).await;
        } => {}
    }
}

#[tokio::test]
async fn test_nrf52840_controller_constraints_enforced() {
    let (nus_adv, nus_adv_len, nus_scan, nus_scan_len) = encode_nus_adv_and_scan_data();
    let (findmy_payload, findmy_addr, _) = derive_advertisement(&TEST_PRIV_KEY, &TEST_SK0, 0, 90);

    // (a) max_adv_sets = 1 must return InsufficientSpace for 2 sets
    {
        let (controller, _sim) = create_sim_controller(SimSdcConfig {
            max_adv_sets: 1,
            has_public_addr: false,
        });
        let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
        let stack = trouble_host::new(controller, &mut resources)
            .set_random_address(Address::random(DEVICE_MAC))
            .build();
        let mut runner = stack.runner();
        let mut peripheral = stack.peripheral();

        let sets = build_dual_sets(
            &nus_adv[..nus_adv_len],
            &nus_scan[..nus_scan_len],
            &findmy_payload,
            findmy_addr,
        );
        let mut handles = AdvertisementSet::handles(&sets);

        tokio::select! {
            r = runner.run() => {
                panic!("runner exited unexpectedly: {r:?}");
            }
            _ = async {
                let err = peripheral
                    .advertise_ext(&sets, &mut handles)
                    .await
                    .err()
                    .expect("expected InsufficientSpace when max_adv_sets == 1");
                assert!(
                    matches!(err, BleHostError::BleHost(Error::InsufficientSpace)),
                    "unexpected error: {err:?}"
                );
            } => {}
        }
    }

    // (b) AddrKind::PUBLIC rejected by controller when has_public_addr == false (HCI 0x12)
    {
        let (controller, _sim) = create_sim_controller(SimSdcConfig::default());
        let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
        let stack: Stack<'_, SimController, DefaultPacketPool> =
            trouble_host::new(controller, &mut resources)
                .set_random_address(Address::random(DEVICE_MAC))
                .build();
        let mut runner = stack.runner();
        let mut peripheral = stack.peripheral();

        let sets = [AdvertisementSet {
            params: AdvertisementParameters {
                own_addr_kind: Some(AddrKind::PUBLIC),
                ..Default::default()
            },
            data: Advertisement::NonconnectableNonscannableUndirected {
                adv_data: &findmy_payload,
            },
            address: Some(BdAddr::new(findmy_addr)),
        }];
        let mut handles = AdvertisementSet::handles(&sets);

        tokio::select! {
            r = runner.run() => {
                panic!("runner exited unexpectedly: {r:?}");
            }
            _ = async {
                let err = peripheral
                    .advertise_ext(&sets, &mut handles)
                    .await
                    .err()
                    .expect("expected controller rejection for AddrKind::PUBLIC");
                assert!(
                    matches!(err, BleHostError::BleHost(Error::Hci(_))),
                    "unexpected error: {err:?}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            } => {}
        }
    }

    // (c) >31-byte legacy adv payload rejected by controller (HCI 0x12)
    {
        let (controller, _sim) = create_sim_controller(SimSdcConfig::default());
        let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
        let stack = trouble_host::new(controller, &mut resources)
            .set_random_address(Address::random(DEVICE_MAC))
            .build();
        let mut runner = stack.runner();
        let mut peripheral = stack.peripheral();

        let oversized_payload = [0xAAu8; 32];
        let sets = [AdvertisementSet {
            params: AdvertisementParameters {
                own_addr_kind: Some(AddrKind::RANDOM),
                ..Default::default()
            },
            data: Advertisement::NonconnectableNonscannableUndirected {
                adv_data: &oversized_payload,
            },
            address: Some(BdAddr::new(findmy_addr)),
        }];
        let mut handles = AdvertisementSet::handles(&sets);

        tokio::select! {
            r = runner.run() => {
                panic!("runner exited unexpectedly: {r:?}");
            }
            _ = async {
                let err = peripheral
                    .advertise_ext(&sets, &mut handles)
                    .await
                    .err()
                    .expect("expected controller rejection for >31B legacy adv payload");
                assert!(
                    matches!(err, BleHostError::BleHost(Error::Hci(_))),
                    "unexpected error: {err:?}"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            } => {}
        }
    }
}
