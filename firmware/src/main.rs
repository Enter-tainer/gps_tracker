#![no_std]
#![no_main]

mod accel;
mod battery;
mod ble;
mod bmp280;
mod board;
mod button;
mod casic;
mod display;
#[cfg(feature = "findmy")]
mod findmy;
mod gps;
mod protocol;
mod storage;
mod system_info;
mod timezone;
mod usb_msc;

use core::cell::RefCell;
use core::sync::atomic::{AtomicBool, Ordering};

use cortex_m::peripheral::SCB;
use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::Spawner;
use embassy_nrf::gpio::{Input, Level, Output, OutputDrive, Pull};
use embassy_nrf::interrupt::Priority;
use embassy_nrf::usb::vbus_detect::SoftwareVbusDetect;
use embassy_nrf::{bind_interrupts, buffered_uarte, peripherals, rng, saadc, spim, twim, uarte};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::signal::Signal;
use embassy_time::Timer;
use nrf_pac as pac;
use nrf_sdc::mpsl::MultiprotocolServiceLayer;
use static_cell::StaticCell;
use trouble_host::prelude::*;

use {defmt_rtt as _, panic_probe as _};

bind_interrupts!(struct Irqs {
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
    SPIM3 => spim::InterruptHandler<peripherals::SPI3>;
    SAADC => saadc::InterruptHandler;
    RNG => rng::InterruptHandler<peripherals::RNG>;
    EGU0_SWI0 => nrf_sdc::mpsl::LowPrioInterruptHandler;
    CLOCK_POWER => nrf_sdc::mpsl::ClockInterruptHandler;
    RADIO => nrf_sdc::mpsl::HighPrioInterruptHandler;
    TIMER0 => nrf_sdc::mpsl::HighPrioInterruptHandler;
    RTC0 => nrf_sdc::mpsl::HighPrioInterruptHandler;
});

// DMA buffers must live in RAM for UARTE/TWIM.
static GPS_RX_BUF: StaticCell<[u8; 512]> = StaticCell::new();
static GPS_TX_BUF: StaticCell<[u8; 128]> = StaticCell::new();
static I2C_TX_BUF: StaticCell<[u8; 32]> = StaticCell::new();
static BLE_SERVER: StaticCell<ble::Server> = StaticCell::new();
static I2C_BUS: StaticCell<BlockingMutex<NoopRawMutex, RefCell<twim::Twim<'static>>>> =
    StaticCell::new();
static USB_MODE_SIGNAL: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static USB_MODE_REQUESTED: AtomicBool = AtomicBool::new(false);
static USB_CONNECTED: AtomicBool = AtomicBool::new(false);
const SD_SPI_INIT_FREQ: spim::Frequency = spim::Frequency::K250;
const SD_SPI_RUN_FREQ: spim::Frequency = spim::Frequency::M16;
const USB_BOOT_FLAG: u8 = 0x01;

pub(crate) fn request_usb_mode_transition() {
    if !USB_MODE_REQUESTED.swap(true, Ordering::AcqRel) {
        defmt::info!("USB mode requested");
        USB_MODE_SIGNAL.signal(());
    } else {
        defmt::info!("USB mode request already pending");
    }
}

pub(crate) fn usb_connected() -> bool {
    USB_CONNECTED.load(Ordering::Acquire)
}

fn set_usb_boot_flag() {
    let power = pac::POWER;
    let current = power.gpregret().read().gpregret();
    power
        .gpregret()
        .write(|w| w.set_gpregret(current | USB_BOOT_FLAG));
    defmt::info!("Set USB boot flag (PAC)");
}

fn take_usb_boot_flag() -> bool {
    let power = pac::POWER;
    let current = power.gpregret().read().gpregret();
    defmt::info!("Boot gpregret=0x{:02x}", current);
    if (current & USB_BOOT_FLAG) == 0 {
        defmt::info!("USB boot flag not set");
        return false;
    }
    power
        .gpregret()
        .write(|w| w.set_gpregret(current & !USB_BOOT_FLAG));
    defmt::info!("Cleared USB boot flag");
    true
}

/// Poll USB power register status (replaces SoftDevice SocEvent callback).
///
/// CLOCK_POWER interrupt is occupied by MPSL ClockInterruptHandler,
/// so we poll USBREGSTATUS at 100ms intervals instead.
#[embassy_executor::task]
async fn usb_power_task(
    vbus: &'static SoftwareVbusDetect,
    initial_detected: bool,
    usb_only: bool,
) {
    let power = pac::POWER;
    let clock = pac::CLOCK;
    let mut last_detected = initial_detected;
    let mut hfclk_requested = initial_detected;

    if initial_detected {
        clock
            .tasks_hfclkstart()
            .write_value(1);
    }

    loop {
        Timer::after_millis(100).await;

        let regstatus = power.usbregstatus().read();
        let detected = regstatus.vbusdetect();
        let ready = regstatus.outputrdy();

        if detected && !last_detected {
            USB_CONNECTED.store(true, Ordering::Release);
            defmt::info!("USB detected");
            vbus.detected(true);
            if !hfclk_requested {
                clock
                    .tasks_hfclkstart()
                    .write_value(1);
                hfclk_requested = true;
            }
            if ready {
                vbus.ready();
            }
        } else if !detected && last_detected {
            USB_CONNECTED.store(false, Ordering::Release);
            defmt::info!("USB removed");
            vbus.detected(false);
            if hfclk_requested {
                clock
                    .tasks_hfclkstop()
                    .write_value(1);
                hfclk_requested = false;
            }
            if usb_only {
                SCB::sys_reset();
            }
        } else if detected && ready && last_detected {
            vbus.ready();
        }

        last_detected = detected;
    }
}

#[embassy_executor::task]
async fn usb_mode_task() {
    loop {
        USB_MODE_SIGNAL.wait().await;
        if !usb_connected() {
            defmt::warn!("USB mode requested but USB not connected");
            USB_MODE_REQUESTED.store(false, Ordering::Release);
            continue;
        }

        display::send_command(display::DisplayCommand::UsbMode);
        #[cfg(feature = "i2c-spi")]
        let prep_ok = storage::enter_usb_mode().await;
        #[cfg(not(feature = "i2c-spi"))]
        let prep_ok = {
            defmt::warn!("USB mode prep skipped (feature i2c-spi off)");
            true
        };

        if prep_ok {
            defmt::info!("USB mode prep OK, setting boot flag");
            set_usb_boot_flag();
            Timer::after_millis(100).await;
            defmt::info!("USB mode reset now");
            SCB::sys_reset();
        } else {
            defmt::warn!("USB mode prep failed");
            USB_MODE_REQUESTED.store(false, Ordering::Release);
        }
    }
}

#[embassy_executor::task]
async fn mpsl_task(mpsl: &'static MultiprotocolServiceLayer<'static>) -> ! {
    mpsl.run().await
}

fn detect_usb_present(vbus: &SoftwareVbusDetect) -> bool {
    let power = pac::POWER;
    let regstatus = power.usbregstatus().read();
    let detected = regstatus.vbusdetect();
    let ready = regstatus.outputrdy();
    vbus.detected(detected);
    if detected && ready {
        vbus.ready();
    }
    detected
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    config.lfclk_source = embassy_nrf::config::LfclkSource::InternalRC;

    config.gpiote_interrupt_priority = Priority::P2;
    config.time_interrupt_priority = Priority::P2;

    let p = embassy_nrf::init(config);
    let board::Board {
        led,
        button: button_pin,
        gps_uart_rx,
        gps_uart_tx,
        gps_en: gps_en_pin,
        i2c_sda,
        i2c_scl,
        spi_miso,
        spi_mosi,
        spi_sck,
        spi_cs,
        battery_adc,
        v3v3_en,
        serial2_rx,
        serial2_tx,
        uarte0,
        twispi0,
        spi3,
        usbd,
        saadc: saadc_peripheral,
        timer1,
        ppi_ch8,
        ppi_ch9,
        ppi_group1,
        // MPSL
        rtc0,
        timer0,
        temp,
        ppi_ch19,
        ppi_ch30,
        ppi_ch31,
        // SDC
        rng: rng_periph,
        ppi_ch17,
        ppi_ch18,
        ppi_ch20,
        ppi_ch21,
        ppi_ch22,
        ppi_ch23,
        ppi_ch24,
        ppi_ch25,
        ppi_ch26,
        ppi_ch27,
        ppi_ch28,
        ppi_ch29,
    } = board::Board::new(p);

    // Enable DC/DC converter via PAC (replaces sd_power_dcdc_mode_set)
    pac::POWER.dcdcen().write(|w| w.set_dcdcen(true));

    // Initialize MPSL
    let mpsl_p = nrf_sdc::mpsl::Peripherals::new(rtc0, timer0, temp, ppi_ch19, ppi_ch30, ppi_ch31);
    let lfclk_cfg = nrf_sdc::mpsl::raw::mpsl_clock_lfclk_cfg_t {
        source: nrf_sdc::mpsl::raw::MPSL_CLOCK_LF_SRC_RC as u8,
        rc_ctiv: nrf_sdc::mpsl::raw::MPSL_RECOMMENDED_RC_CTIV as u8,
        rc_temp_ctiv: nrf_sdc::mpsl::raw::MPSL_RECOMMENDED_RC_TEMP_CTIV as u8,
        accuracy_ppm: nrf_sdc::mpsl::raw::MPSL_DEFAULT_CLOCK_ACCURACY_PPM as u16,
        skip_wait_lfclk_started: nrf_sdc::mpsl::raw::MPSL_DEFAULT_SKIP_WAIT_LFCLK_STARTED != 0,
    };
    static MPSL: StaticCell<MultiprotocolServiceLayer> = StaticCell::new();
    let mpsl = MPSL.init(
        nrf_sdc::mpsl::MultiprotocolServiceLayer::new(mpsl_p, Irqs, lfclk_cfg)
            .expect("MPSL init failed"),
    );
    spawner.spawn(mpsl_task(mpsl)).unwrap();

    // Build SDC (SoftDevice Controller) with 2 adv sets
    let sdc_p = nrf_sdc::Peripherals::new(
        ppi_ch17, ppi_ch18, ppi_ch20, ppi_ch21, ppi_ch22, ppi_ch23, ppi_ch24, ppi_ch25, ppi_ch26,
        ppi_ch27, ppi_ch28, ppi_ch29,
    );
    let mut sdc_rng = rng::Rng::new(rng_periph, Irqs);
    static SDC_MEM: StaticCell<nrf_sdc::Mem<14000>> = StaticCell::new();
    let sdc_mem = SDC_MEM.init(nrf_sdc::Mem::new());
    defmt::info!("SDC: building (ext_adv only, no legacy adv)");
    let sdc = nrf_sdc::Builder::new().unwrap();
    // Only ext_adv — covers both legacy and extended HCI commands.
    // Do NOT call support_adv() together with support_ext_adv() (Nordic docs: either/or).
    let sdc = sdc.support_ext_adv();
    let sdc = sdc.support_peripheral();
    let sdc = sdc.peripheral_count(1).unwrap();
    let sdc = sdc.adv_count(2).unwrap();
    let sdc = sdc.buffer_cfg(247, 247, 3, 3).unwrap();
    let sdc = sdc.build(sdc_p, &mut sdc_rng, mpsl, sdc_mem).unwrap();
    defmt::info!("SDC: build OK");

    // USB detection via PAC (replaces init_usb_power_events + SocEvent)
    let vbus = usb_msc::init_vbus();
    let usb_present = detect_usb_present(vbus);
    USB_CONNECTED.store(usb_present, Ordering::Release);
    let usb_boot_requested = take_usb_boot_flag();
    let usb_only = usb_boot_requested;
    defmt::info!(
        "Boot USB: present={} boot_flag={} usb_only={}",
        usb_present,
        usb_boot_requested,
        usb_only
    );

    spawner
        .spawn(usb_power_task(vbus, usb_present, usb_only))
        .unwrap();
    spawner.spawn(usb_mode_task()).unwrap();

    if usb_only {
        #[cfg(feature = "i2c-spi")]
        spawner.spawn(usb_msc::usb_msc_task(usbd, vbus)).unwrap();
        #[cfg(not(feature = "i2c-spi"))]
        defmt::warn!("USB MSC disabled (feature i2c-spi off)");
    }

    // Build trouble-host BLE stack
    defmt::info!("trouble-host: building stack");
    let address = Address::random([0xff, 0x8f, 0x1a, 0x05, 0xe4, 0xff]);
    // HostResources<PacketPool, CONNS, CHANNELS, ADV_SETS>
    static HOST_RESOURCES: StaticCell<HostResources<DefaultPacketPool, 1, 0, 2>> = StaticCell::new();
    let host_resources = HOST_RESOURCES.init(HostResources::new());
    let stack = trouble_host::new(sdc, host_resources).set_random_address(address);
    let Host {
        mut peripheral,
        mut runner,
        ..
    } = stack.build();
    defmt::info!("trouble-host: stack built OK");

    let server = if usb_only {
        None
    } else {
        Some(BLE_SERVER.init(ble::Server::new_with_config(
            GapConfig::Peripheral(PeripheralConfig {
                name: ble::DEVICE_NAME,
                appearance: &appearance::UNKNOWN,
            }),
        ).expect("GATT server init")))
    };

    defmt::info!("GATT server init OK, enabling LED + V3.3");
    // LED is on P0.15 per promicro_diy variant.
    let _led = Output::new(led, Level::Low, OutputDrive::Standard);
    let _v3v3_en = Output::new(v3v3_en, Level::High, OutputDrive::Standard);
    defmt::info!("V3.3 enabled, starting peripherals");

    // Phase 2 bring-up: create core drivers.
    #[cfg(feature = "i2c-spi")]
    {
        let mut sd_spi_config = spim::Config::default();
        sd_spi_config.frequency = SD_SPI_INIT_FREQ;
        sd_spi_config.orc = 0xFF;
        let sd_spi = spim::Spim::new(
            spi3,
            Irqs,
            spi_sck,
            spi_miso,
            spi_mosi,
            sd_spi_config.clone(),
        );

        let sd_cs = Output::new(spi_cs, Level::High, OutputDrive::Standard);
        if !storage::init_sd_logger(sd_spi, sd_cs, sd_spi_config, SD_SPI_RUN_FREQ) {
            defmt::warn!("SD logger init failed");
        }
    }
    #[cfg(not(feature = "i2c-spi"))]
    {
        defmt::warn!("i2c-spi feature disabled: skipping SD init and sensors/display");
    }

    #[cfg(feature = "findmy")]
    {
        // Load keys from SD card only after SD logger is initialized.
        if let Some(keys) = storage::read_findmy_keys().await {
            let mut pk = [0u8; 28];
            let mut sk = [0u8; 32];
            pk.copy_from_slice(&keys[..28]);
            sk.copy_from_slice(&keys[28..60]);
            let epoch = u64::from_le_bytes({
                let mut b = [0u8; 8];
                b.copy_from_slice(&keys[60..68]);
                b
            });
            findmy::init(&pk, &sk, epoch);
            findmy::load_sk_cache().await;
            findmy::set_enabled(true);
            defmt::info!("FindMy: loaded keys from SD, epoch={}", epoch);
        } else {
            defmt::info!("FindMy: no keys on SD, waiting for provisioning via BLE");
        }
    }

    let gps_en = Output::new(gps_en_pin, Level::Low, OutputDrive::Standard);
    if !usb_only {
        let gps_uart = {
            let mut cfg = uarte::Config::default();
            cfg.baudrate = uarte::Baudrate::BAUD115200;
            let rx_buf = GPS_RX_BUF.init([0; 512]);
            let tx_buf = GPS_TX_BUF.init([0; 128]);
            buffered_uarte::BufferedUarte::new(
                uarte0,
                timer1,
                ppi_ch8,
                ppi_ch9,
                ppi_group1,
                gps_uart_rx,
                gps_uart_tx,
                Irqs,
                cfg,
                rx_buf,
                tx_buf,
            )
        };

        let (gps_rx, gps_tx) = gps_uart.split();
        spawner.spawn(gps::gps_rx_task(gps_rx)).unwrap();
        spawner.spawn(gps::gps_state_task(gps_tx, gps_en)).unwrap();

        let button = Input::new(button_pin, Pull::Up);
        let mut saadc_config = saadc::Config::default();
        saadc_config.oversample = saadc::Oversample::OVER8X;
        let mut saadc_channel = saadc::ChannelConfig::single_ended(battery_adc);
        saadc_channel.time = saadc::Time::_40US;
        let saadc = saadc::Saadc::new(saadc_peripheral, Irqs, saadc_config, [saadc_channel]);

        spawner.spawn(battery::battery_task(saadc)).unwrap();
        spawner.spawn(button::button_task(button)).unwrap();

        #[cfg(feature = "i2c-spi")]
        {
            let i2c = {
                let cfg = twim::Config::default();
                let tx_buf = I2C_TX_BUF.init([0; 32]);
                twim::Twim::new(twispi0, Irqs, i2c_sda, i2c_scl, cfg, tx_buf)
            };
            let i2c_bus = I2C_BUS.init(BlockingMutex::new(RefCell::new(i2c)));
            let i2c_accel = I2cDevice::new(i2c_bus);
            let i2c_bmp = I2cDevice::new(i2c_bus);
            let i2c_display = I2cDevice::new(i2c_bus);

            spawner.spawn(accel::accel_task(i2c_accel)).unwrap();
            spawner.spawn(bmp280::bmp280_task(i2c_bmp)).unwrap();
            spawner.spawn(display::display_task(i2c_display)).unwrap();
        }
    } else {
        let button = Input::new(button_pin, Pull::Up);
        spawner
            .spawn(button::usb_only_button_task(button))
            .unwrap();
    }

    drop((serial2_rx, serial2_tx));
    #[cfg(not(feature = "i2c-spi"))]
    drop((spi3, spi_sck, spi_miso, spi_mosi, spi_cs, twispi0, i2c_sda, i2c_scl));

    defmt::info!("All tasks spawned, entering BLE join loop");
    // Run BLE host runner and unified BLE task concurrently.
    // peripheral has a non-'static lifetime tied to host_resources,
    // so we run it inline rather than spawning a task.
    if let Some(server) = server {
        embassy_futures::join::join(
            async { runner.run().await.unwrap() },
            ble::ble_unified_task(&mut peripheral, server),
        )
        .await;
    } else {
        // USB-only mode: just run the BLE runner (keeps stack alive for future use)
        runner.run().await.unwrap();
    }
}
