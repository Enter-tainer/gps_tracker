#![no_std]
#![no_main]

use bt_hci::cmd::le::LeSetExtAdvEnable;
use bt_hci::param::{AddrKind, BdAddr};
use defmt::{info, unwrap, warn};
use embassy_executor::Spawner;
use embassy_futures::select::{select, Either};
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_nrf::interrupt::{self, InterruptExt, Priority};
use embassy_nrf::rng::Rng;
use embassy_nrf::{bind_interrupts, peripherals};
use embassy_time::{Duration, Timer};
use heapless::Vec;
use nrf_mpsl::{raw as mpsl_raw, MultiprotocolServiceLayer, Peripherals as MpslPeripherals};
use nrf_sdc::{self as sdc, Peripherals as SdcPeripherals};
use p224::elliptic_curve::ops::Reduce;
use p224::elliptic_curve::sec1::ToEncodedPoint;
use p224::{FieldBytes, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};
use static_cell::StaticCell;
use trouble_host::prelude::*;
use {defmt_rtt as _, panic_probe as _};

/// Relocate VTOR to our vector table at 0x0002_7000 before RAM init so
/// Nordic MBR forwarding (Adafruit UF2 bootloader) does not fault `nrf-mpsl`.
#[cortex_m_rt::pre_init]
unsafe fn relocate_vtor() {
    unsafe extern "C" {
        static __vector_table: u32;
    }
    unsafe {
        let scb = &*cortex_m::peripheral::SCB::PTR;
        scb.vtor.write(&__vector_table as *const u32 as u32);
        cortex_m::asm::dsb();
        cortex_m::asm::isb();
    }
}

bind_interrupts!(struct Irqs {
    EGU0_SWI0 => nrf_mpsl::LowPrioInterruptHandler;
    CLOCK_POWER => nrf_mpsl::ClockInterruptHandler;
    RADIO => nrf_mpsl::HighPrioInterruptHandler;
    TIMER0 => nrf_mpsl::HighPrioInterruptHandler;
    RTC0 => nrf_mpsl::HighPrioInterruptHandler;
    RNG => embassy_nrf::rng::InterruptHandler<peripherals::RNG>;
});

const DEVICE_NAME: &str = "MGT GPS Tracker";
const NUS_SERVICE_UUID_BYTES: [u8; 16] = 0x6e400001_b5a3_f393_e0a9_e50e24dcca9e_u128.to_le_bytes();
const MAX_GATT_PAYLOAD: usize = 244;

const TEST_PRIV_KEY: [u8; 28] = [0x11u8; 28];
const TEST_SK0: [u8; 32] = [0x22u8; 32];
const ROTATION_SECS: u64 = 30;

#[gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
struct NusService {
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
struct TrackerServer {
    nus: NusService,
}

fn read_ficr_static_random_addr() -> [u8; 6] {
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

fn kdf_x963(input: &[u8], shared_info: &[u8], out: &mut [u8]) {
    let mut offset = 0usize;
    let mut counter: u32 = 1;
    while offset < out.len() {
        let mut sha = Sha256::new();
        sha.update(input);
        sha.update(counter.to_be_bytes());
        sha.update(shared_info);
        let digest = sha.finalize();
        let copy_len = (out.len() - offset).min(32);
        out[offset..offset + copy_len].copy_from_slice(&digest[..copy_len]);
        offset += copy_len;
        counter += 1;
    }
}

fn bytes_to_scalar_nonzero(bytes: &[u8]) -> Scalar {
    let mut buf = FieldBytes::default();
    let copy_len = bytes.len().min(28);
    buf[28 - copy_len..].copy_from_slice(&bytes[..copy_len]);
    let s = Scalar::reduce_bytes(&buf);
    if bool::from(s.is_zero()) {
        Scalar::ONE
    } else {
        s
    }
}

fn derive_findmy_adv(counter: u32, battery_pct: u8) -> ([u8; 31], [u8; 6], [u8; 28]) {
    let mut sk = TEST_SK0;
    for _ in 0..counter {
        let mut next = [0u8; 32];
        kdf_x963(&sk, b"update", &mut next);
        sk = next;
    }
    let mut div = [0u8; 72];
    kdf_x963(&sk, b"diversify", &mut div);

    let d0 = bytes_to_scalar_nonzero(&TEST_PRIV_KEY);
    let u_i = bytes_to_scalar_nonzero(&div[..36]);
    let v_i = bytes_to_scalar_nonzero(&div[36..72]);
    let d_i = d0 * u_i + v_i;

    let p_i = (ProjectivePoint::GENERATOR * d_i).to_affine();
    let encoded = p_i.to_encoded_point(false);
    let x_bytes = unwrap!(encoded.x());

    let mut pub_x = [0u8; 28];
    pub_x.copy_from_slice(x_bytes);

    let status = if battery_pct > 80 {
        0x10
    } else if battery_pct > 30 {
        0x50
    } else if battery_pct > 10 {
        0x90
    } else {
        0xD0
    };

    let mut payload = [0u8; 31];
    payload[0] = 0x1e;
    payload[1] = 0xff;
    payload[2] = 0x4c;
    payload[3] = 0x00;
    payload[4] = 0x12;
    payload[5] = 0x19;
    payload[6] = status;
    payload[7..29].copy_from_slice(&pub_x[6..28]);
    payload[29] = pub_x[0] >> 6;
    payload[30] = 0x00;

    let addr = [
        pub_x[5],
        pub_x[4],
        pub_x[3],
        pub_x[2],
        pub_x[1],
        pub_x[0] | 0xC0,
    ];

    (payload, addr, pub_x)
}

#[embassy_executor::task]
async fn mpsl_task(mpsl: &'static MultiprotocolServiceLayer<'static>) -> ! {
    mpsl.run().await
}

#[embassy_executor::task]
async fn heartbeat_task(mut led: Output<'static>) -> ! {
    let mut tick: u32 = 0;
    loop {
        led.set_high();
        Timer::after_millis(100).await;
        led.set_low();
        Timer::after_millis(900).await;
        tick += 1;
        if tick % 10 == 0 {
            info!("heartbeat tick={}s", tick);
        }
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    config.lfclk_source = embassy_nrf::config::LfclkSource::InternalRC;
    config.gpiote_interrupt_priority = Priority::P2;
    config.time_interrupt_priority = Priority::P2;

    let p = embassy_nrf::init(config);
    interrupt::RNG.set_priority(Priority::P3);
    nrf_pac::POWER.dcdcen().write(|w| w.set_dcdcen(true));

    info!(
        "ble-dual-adv-test booted cleanly! VTOR=0x{:08x}",
        unsafe { (*cortex_m::peripheral::SCB::PTR).vtor.read() }
    );

    let led = Output::new(p.P0_15, Level::Low, OutputDrive::Standard);
    spawner.spawn(unwrap!(heartbeat_task(led)));

    let lfclk_cfg = mpsl_raw::mpsl_clock_lfclk_cfg_t {
        source: mpsl_raw::MPSL_CLOCK_LF_SRC_RC as u8,
        rc_ctiv: 16,
        rc_temp_ctiv: 2,
        accuracy_ppm: 500,
        skip_wait_lfclk_started: false,
    };

    let mpsl_p = MpslPeripherals::new(
        p.RTC0,
        p.TIMER0,
        p.TEMP,
        p.PPI_CH19,
        p.PPI_CH30,
        p.PPI_CH31,
    );

    static MPSL: StaticCell<MultiprotocolServiceLayer<'static>> = StaticCell::new();
    let mpsl = MPSL.init(unwrap!(MultiprotocolServiceLayer::new(mpsl_p, Irqs, lfclk_cfg)));
    info!("MPSL initialized successfully!");
    spawner.spawn(unwrap!(mpsl_task(mpsl)));

    let sdc_p = SdcPeripherals::new(
        p.PPI_CH17,
        p.PPI_CH18,
        p.PPI_CH20,
        p.PPI_CH21,
        p.PPI_CH22,
        p.PPI_CH23,
        p.PPI_CH24,
        p.PPI_CH25,
        p.PPI_CH26,
        p.PPI_CH27,
        p.PPI_CH28,
        p.PPI_CH29,
    );

    static RNG: StaticCell<Rng<'static, embassy_nrf::mode::Async>> = StaticCell::new();
    let rng = RNG.init(Rng::new(p.RNG, Irqs));

    let builder = unwrap!(sdc::Builder::new())
        .support_adv()
        .support_ext_adv()
        .support_peripheral()
        .support_dle_peripheral()
        .support_le_2m_phy()
        .support_phy_update_peripheral();
    let builder = unwrap!(builder.peripheral_count(1));
    let builder = unwrap!(builder.adv_count(2));
    let builder = unwrap!(builder.adv_buffer_cfg(64));
    let builder = unwrap!(builder.buffer_cfg(251, 251, 4, 4));
    let req_mem = unwrap!(builder.required_memory());
    info!("SDC required_memory={} bytes", req_mem);

    const SDC_MEM_SIZE: usize = 6256;
    static SDC_MEM: StaticCell<sdc::Mem<SDC_MEM_SIZE>> = StaticCell::new();
    let sdc = unwrap!(builder.build(sdc_p, rng, mpsl, SDC_MEM.init(sdc::Mem::new())));
    info!("SDC initialized successfully!");

    let device_mac = read_ficr_static_random_addr();
    info!(
        "Device fixed NUS MAC (BE): {:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        device_mac[5], device_mac[4], device_mac[3], device_mac[2], device_mac[1], device_mac[0]
    );

    let mut resources: HostResources<DefaultPacketPool, 1, 2, 2> = HostResources::new();
    let stack = trouble_host::new(sdc, &mut resources)
        .set_random_address(Address::random(device_mac))
        .build();
    let mut runner = stack.runner();
    let mut peripheral = stack.peripheral();

    let server = unwrap!(TrackerServer::new_default(DEVICE_NAME).map_err(|_| ()));
    let rx_handle = server.nus.rx.handle;

    let mut adv_buf = [0u8; 31];
    let adv_len = unwrap!(AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteServiceUuids128(&[NUS_SERVICE_UUID_BYTES]),
        ],
        &mut adv_buf,
    ));
    let mut scan_buf = [0u8; 31];
    let scan_len = unwrap!(AdStructure::encode_slice(
        &[AdStructure::CompleteLocalName(DEVICE_NAME.as_bytes())],
        &mut scan_buf,
    ));

    let nus_params = AdvertisementParameters {
        interval_min: Duration::from_millis(40),
        interval_max: Duration::from_millis(40),
        own_addr_kind: Some(AddrKind::RANDOM),
        ..Default::default()
    };
    let findmy_params = AdvertisementParameters {
        interval_min: Duration::from_millis(500),
        interval_max: Duration::from_millis(500),
        own_addr_kind: Some(AddrKind::RANDOM),
        ..Default::default()
    };

    let host_fut = runner.run();
    let ble_fut = async {
        let mut counter: u32 = 0;
        loop {
            let (findmy_payload, findmy_addr, pub_x) = derive_findmy_adv(counter, 95);
            info!(
                "Dual adv start: counter={} FindMy MAC (BE)={:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X} pub_x[0..4]={:02x}{:02x}{:02x}{:02x}",
                counter,
                findmy_addr[5],
                findmy_addr[4],
                findmy_addr[3],
                findmy_addr[2],
                findmy_addr[1],
                findmy_addr[0],
                pub_x[0],
                pub_x[1],
                pub_x[2],
                pub_x[3]
            );

            let sets = [
                AdvertisementSet {
                    params: nus_params,
                    data: Advertisement::ConnectableScannableUndirected {
                        adv_data: &adv_buf[..adv_len],
                        scan_data: &scan_buf[..scan_len],
                    },
                    address: None,
                },
                AdvertisementSet {
                    params: findmy_params,
                    data: Advertisement::NonconnectableNonscannableUndirected {
                        adv_data: &findmy_payload,
                    },
                    address: Some(BdAddr::new(findmy_addr)),
                },
            ];
            let mut handles = AdvertisementSet::handles(&sets);

            // If another advertising set (e.g. Find My Set 1) stayed active while Set 0 connected,
            // disable all sets first so LeSetExtAdvParams never returns Command Disallowed (0x0C).
            let _ = stack.command(LeSetExtAdvEnable::new(false, &[])).await;

            let advertiser = match peripheral.advertise_ext(&sets, &mut handles).await {
                Ok(adv) => adv,
                Err(e) => {
                    warn!("advertise_ext error: {:?}", e);
                    Timer::after_secs(2).await;
                    continue;
                }
            };

            info!("Dual adv active on both handles!");

            let conn = match select(advertiser.accept(), Timer::after_secs(ROTATION_SECS)).await {
                Either::First(Ok(conn)) => conn,
                Either::First(Err(e)) => {
                    warn!("advertiser.accept error: {:?}", e);
                    continue;
                }
                Either::Second(()) => {
                    counter = counter.wrapping_add(1);
                    info!("30s FindMy rotation -> counter={}", counter);
                    continue;
                }
            };

            info!("NUS Central connected! (FindMy Set 1 stays active in SDC)");
            let gatt_conn = match conn.with_attribute_server(&server) {
                Ok(gc) => gc,
                Err(e) => {
                    warn!("with_attribute_server error: {:?}", e);
                    continue;
                }
            };

            loop {
                match gatt_conn.next().await {
                    GattConnectionEvent::Disconnected { reason } => {
                        info!("NUS disconnected: {:?}", reason);
                        break;
                    }
                    GattConnectionEvent::Gatt { event } => match event {
                        GattEvent::Write(write_ev) => {
                            let handle = write_ev.handle();
                            let mut payload = Vec::<u8, MAX_GATT_PAYLOAD>::new();
                            write_ev.with_data(|_, d| {
                                let _ = payload.extend_from_slice(d);
                            });
                            if let Ok(reply) = write_ev.accept() {
                                reply.send().await;
                            }
                            if handle == rx_handle {
                                info!("NUS RX write {} bytes: {:02x}", payload.len(), payload.as_slice());
                                let mut resp = Vec::<u8, MAX_GATT_PAYLOAD>::new();
                                if payload.as_slice() == [0x06, 0x00, 0x00] {
                                    let _ = resp.extend_from_slice(&[
                                        0x86, 0x00, 0x04, 0xCA, 0xFE, 0xBA, 0xBE,
                                    ]);
                                } else {
                                    let _ = resp.extend_from_slice(payload.as_slice());
                                }
                                if let Err(e) = server.nus.tx.notify(&gatt_conn, &resp, false).await {
                                    warn!("NUS TX notify error: {:?}", e);
                                }
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
        }
    };

    embassy_futures::join::join(host_fut, ble_fut).await;
}
