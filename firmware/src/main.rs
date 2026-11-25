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
use defmt::unwrap;
#[cfg(feature = "i2c-spi")]
use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::Spawner;
use embassy_nrf::gpio::{Input, Level, Output, OutputDrive, Pull};
use embassy_nrf::interrupt::{self, InterruptExt, Priority};
use embassy_nrf::rng::Rng;
use embassy_nrf::usb::vbus_detect::SoftwareVbusDetect;
use embassy_nrf::{bind_interrupts, buffered_uarte, peripherals, saadc, spim, twim, uarte};
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::blocking_mutex::raw::{CriticalSectionRawMutex, NoopRawMutex};
use embassy_sync::signal::Signal;
use embassy_time::Timer;
use nrf_mpsl::{MultiprotocolServiceLayer, raw as mpsl_raw};
use nrf_sdc as sdc;
use static_cell::StaticCell;
use trouble_host::prelude::{Address, HostResources};
use {defmt_rtt as _, panic_probe as _};

/// Relocate VTOR to our vector table at 0x0002_7000 before RAM init so
/// Nordic MBR forwarding (Adafruit UF2 bootloader) does not fault `nrf-mpsl`.
#[cortex_m_rt::pre_init]
unsafe fn relocate_vtor() {
    unsafe extern "C" {
        static __vector_table: u32;
    }
    unsafe {
        let scb = &*SCB::PTR;
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
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
    SPIM3 => spim::InterruptHandler<peripherals::SPI3>;
    SAADC => saadc::InterruptHandler;
});

const SDC_MEM_SIZE: usize = 6256;
const SD_SPI_INIT_FREQ: spim::Frequency = spim::Frequency::K250;
const SD_SPI_RUN_FREQ: spim::Frequency = spim::Frequency::M16;
const USB_BOOT_FLAG: u8 = 0x01;

// DMA buffers and static system resources placed in .bss rather than the stack.
static GPS_RX_BUF: StaticCell<[u8; 512]> = StaticCell::new();
static GPS_TX_BUF: StaticCell<[u8; 128]> = StaticCell::new();
static I2C_TX_BUF: StaticCell<[u8; 32]> = StaticCell::new();
static MPSL: StaticCell<MultiprotocolServiceLayer<'static>> = StaticCell::new();
static RNG_CELL: StaticCell<Rng<'static, embassy_nrf::mode::Async>> = StaticCell::new();
static SDC_MEM: StaticCell<sdc::Mem<SDC_MEM_SIZE>> = StaticCell::new();
static BLE_RESOURCES: StaticCell<ble::BleResources> = StaticCell::new();
static BLE_STACK: StaticCell<ble::BleStack> = StaticCell::new();
static BLE_SERVER: StaticCell<ble::Server<'static>> = StaticCell::new();
static I2C_BUS: StaticCell<BlockingMutex<NoopRawMutex, RefCell<twim::Twim<'static>>>> =
    StaticCell::new();
static USB_MODE_SIGNAL: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static USB_MODE_REQUESTED: AtomicBool = AtomicBool::new(false);
static USB_CONNECTED: AtomicBool = AtomicBool::new(false);

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
    nrf_pac::POWER.gpregret().modify(|w| {
        let cur = w.gpregret();
        w.set_gpregret(cur | USB_BOOT_FLAG);
    });
    defmt::info!("Set USB boot flag (GPREGRET)");
}

fn take_usb_boot_flag() -> bool {
    let current = nrf_pac::POWER.gpregret().read().gpregret();
    defmt::info!("Boot gpregret=0x{:02x}", current);
    if (current & USB_BOOT_FLAG) == 0 {
        defmt::info!("USB boot flag not set");
        return false;
    }
    nrf_pac::POWER.gpregret().modify(|w| {
        let cur = w.gpregret();
        w.set_gpregret(cur & !USB_BOOT_FLAG);
    });
    defmt::info!("Cleared USB boot flag");
    true
}

fn read_usb_power_status() -> (bool, bool) {
    let status = nrf_pac::POWER.usbregstatus().read();
    (status.vbusdetect(), status.outputrdy())
}

#[embassy_executor::task]
async fn mpsl_task(mpsl: &'static MultiprotocolServiceLayer<'static>) -> ! {
    mpsl.run().await
}

#[embassy_executor::task]
async fn usb_power_monitor_task(
    mpsl: &'static MultiprotocolServiceLayer<'static>,
    vbus: &'static SoftwareVbusDetect,
    usb_only: bool,
) -> ! {
    let (mut prev_detected, mut prev_ready) = read_usb_power_status();
    USB_CONNECTED.store(prev_detected, Ordering::Release);
    vbus.detected(prev_detected);
    if prev_detected && prev_ready {
        vbus.ready();
    }

    let mut hfclk: Option<nrf_mpsl::Hfclk> = if prev_detected {
        match mpsl.request_hfclk().await {
            Ok(guard) => Some(guard),
            Err(err) => {
                defmt::warn!("USB HFCLK request failed: {:?}", err);
                None
            }
        }
    } else {
        None
    };

    let poll_ms = if usb_only { 50 } else { 200 };
    loop {
        Timer::after_millis(poll_ms).await;
        let (detected, ready) = read_usb_power_status();
        if detected != prev_detected {
            USB_CONNECTED.store(detected, Ordering::Release);
            vbus.detected(detected);
            if detected {
                defmt::info!("USB detected");
                if hfclk.is_none() {
                    match mpsl.request_hfclk().await {
                        Ok(guard) => hfclk = Some(guard),
                        Err(err) => defmt::warn!("USB HFCLK request failed: {:?}", err),
                    }
                }
            } else {
                defmt::info!("USB removed");
                drop(hfclk.take());
                if usb_only {
                    SCB::sys_reset();
                }
            }
            prev_detected = detected;
        }
        if detected && ready && !prev_ready {
            vbus.ready();
        }
        prev_ready = ready;
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

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    config.lfclk_source = embassy_nrf::config::LfclkSource::InternalRC;
    // App interrupts stay at P2/P3 so they never preempt MPSL high-prio (P0) or low-prio (P4).
    config.gpiote_interrupt_priority = Priority::P2;
    config.time_interrupt_priority = Priority::P2;

    let p = embassy_nrf::init(config);
    interrupt::RNG.set_priority(Priority::P3);
    interrupt::UARTE0.set_priority(Priority::P3);
    interrupt::TWISPI0.set_priority(Priority::P3);
    interrupt::SPIM3.set_priority(Priority::P3);
    interrupt::SAADC.set_priority(Priority::P3);

    nrf_pac::POWER.dcdcen().write(|w| w.set_dcdcen(true));

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
        rng: rng_peripheral,
        mpsl: mpsl_p,
        sdc: sdc_p,
    } = board::Board::new(p);

    let vtor = unsafe { (*SCB::PTR).vtor.read() };
    defmt::info!("Firmware boot VTOR=0x{:08x}", vtor);

    let lfclk_cfg = mpsl_raw::mpsl_clock_lfclk_cfg_t {
        source: mpsl_raw::MPSL_CLOCK_LF_SRC_RC as u8,
        rc_ctiv: 16,
        rc_temp_ctiv: 2,
        accuracy_ppm: 500,
        skip_wait_lfclk_started: false,
    };
    let mpsl = MPSL.init(unwrap!(MultiprotocolServiceLayer::new(mpsl_p, Irqs, lfclk_cfg)));
    spawner.spawn(unwrap!(mpsl_task(mpsl)));

    let vbus = usb_msc::init_vbus();
    let (usb_present, _) = read_usb_power_status();
    USB_CONNECTED.store(usb_present, Ordering::Release);
    let usb_boot_requested = take_usb_boot_flag();
    let usb_only = usb_boot_requested;
    defmt::info!(
        "Boot USB: present={} boot_flag={} usb_only={}",
        usb_present,
        usb_boot_requested,
        usb_only
    );

    spawner.spawn(unwrap!(usb_power_monitor_task(mpsl, vbus, usb_only)));
    spawner.spawn(unwrap!(usb_mode_task()));

    if usb_only {
        drop((sdc_p, rng_peripheral));
        #[cfg(feature = "i2c-spi")]
        spawner.spawn(unwrap!(usb_msc::usb_msc_task(usbd, vbus)));
        #[cfg(not(feature = "i2c-spi"))]
        {
            drop(usbd);
            defmt::warn!("USB MSC disabled (feature i2c-spi off)");
        }
    } else {
        drop(usbd);
        let rng = RNG_CELL.init(Rng::new(rng_peripheral, Irqs));
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
        defmt::info!("SDC required_memory={} bytes", req_mem);
        let sdc = unwrap!(builder.build(sdc_p, rng, mpsl, SDC_MEM.init(sdc::Mem::new())));

        let device_mac = ble::read_ficr_static_random_addr();
        defmt::info!(
            "BLE NUS MAC (BE): {:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            device_mac[5],
            device_mac[4],
            device_mac[3],
            device_mac[2],
            device_mac[1],
            device_mac[0]
        );

        let resources = BLE_RESOURCES.init(HostResources::new());
        let stack = BLE_STACK.init(
            trouble_host::new(sdc, resources)
                .set_random_address(Address::random(device_mac))
                .build(),
        );
        let server = BLE_SERVER.init(ble::init_server());
        spawner.spawn(unwrap!(ble::ble_runner_task(stack.runner())));
        spawner.spawn(unwrap!(ble::ble_task(stack, server)));
    }

    // LED is on P0.15 per promicro_diy variant.
    let _led = Output::new(led, Level::Low, OutputDrive::Standard);
    let _v3v3_en = Output::new(v3v3_en, Level::High, OutputDrive::Standard);

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
    if !usb_only {
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
        spawner.spawn(unwrap!(findmy::findmy_task()));
    }

    let gps_en = Output::new(gps_en_pin, Level::Low, OutputDrive::Standard);
    if !usb_only {
        let gps_uart = {
            let mut cfg = uarte::Config::default();
            cfg.baudrate = uarte::Baudrate::Baud115200;
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
        spawner.spawn(unwrap!(gps::gps_rx_task(gps_rx)));
        spawner.spawn(unwrap!(gps::gps_state_task(gps_tx, gps_en)));

        let button = Input::new(button_pin, Pull::Up);
        let mut saadc_config = saadc::Config::default();
        saadc_config.oversample = saadc::Oversample::Over8x;
        let mut saadc_channel = saadc::ChannelConfig::single_ended(battery_adc);
        saadc_channel.time = saadc::Time::_40US;
        let saadc = saadc::Saadc::new(saadc_peripheral, Irqs, saadc_config, [saadc_channel]);

        spawner.spawn(unwrap!(battery::battery_task(saadc)));
        spawner.spawn(unwrap!(button::button_task(button)));

        #[cfg(feature = "i2c-spi")]
        {
            let i2c = {
                let mut cfg = twim::Config::default();
                cfg.sda_pullup = true;
                cfg.scl_pullup = true;
                let tx_buf = I2C_TX_BUF.init([0; 32]);
                twim::Twim::new(twispi0, Irqs, i2c_sda, i2c_scl, cfg, tx_buf)
            };
            let i2c_bus = I2C_BUS.init(BlockingMutex::new(RefCell::new(i2c)));
            let i2c_accel = I2cDevice::new(i2c_bus);
            let i2c_bmp = I2cDevice::new(i2c_bus);
            let i2c_display = I2cDevice::new(i2c_bus);

            spawner.spawn(unwrap!(accel::accel_task(i2c_accel)));
            spawner.spawn(unwrap!(bmp280::bmp280_task(i2c_bmp)));
            spawner.spawn(unwrap!(display::display_task(i2c_display)));
        }
    } else {
        drop((
            gps_en,
            uarte0,
            timer1,
            ppi_ch8,
            ppi_ch9,
            ppi_group1,
            gps_uart_rx,
            gps_uart_tx,
            saadc_peripheral,
            battery_adc,
        ));
        #[cfg(feature = "i2c-spi")]
        drop((twispi0, i2c_sda, i2c_scl));
        let button = Input::new(button_pin, Pull::Up);
        spawner.spawn(unwrap!(button::usb_only_button_task(button)));
    }

    drop((serial2_rx, serial2_tx));
    #[cfg(not(feature = "i2c-spi"))]
    drop((
        spi3, spi_sck, spi_miso, spi_mosi, spi_cs, twispi0, i2c_sda, i2c_scl,
    ));

    core::future::pending::<()>().await;
}
