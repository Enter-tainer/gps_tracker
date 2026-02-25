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
use embassy_nrf::usb::vbus_detect::SoftwareVbusDetect;
use embassy_nrf::{bind_interrupts, buffered_uarte, peripherals, saadc, spim, twim, uarte};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::blocking_mutex::Mutex as BlockingMutex;
use embassy_sync::signal::Signal;
use embassy_time::Timer;
use static_cell::StaticCell;

use {defmt_rtt as _, panic_probe as _};
use nrf_softdevice::ble::SecurityMode;
use nrf_softdevice::{raw, RawError, SocEvent, Softdevice};

bind_interrupts!(struct Irqs {
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
    SPIM3 => spim::InterruptHandler<peripherals::SPI3>;
    SAADC => saadc::InterruptHandler;
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
    let result = RawError::convert(unsafe { raw::sd_power_gpregret_set(0, USB_BOOT_FLAG as u32) });
    match result {
        Ok(()) => defmt::info!("Set USB boot flag (sd_power_gpregret_set)"),
        Err(err) => defmt::warn!("Set USB boot flag failed: {:?}", err),
    }
}

fn take_usb_boot_flag() -> bool {
    let mut current = 0u32;
    let read = RawError::convert(unsafe { raw::sd_power_gpregret_get(0, &mut current as *mut _) });
    let current = match read {
        Ok(()) => current as u8,
        Err(err) => {
            defmt::warn!("Read USB boot flag failed: {:?}", err);
            return false;
        }
    };
    defmt::info!("Boot gpregret=0x{:02x}", current);
    if (current & USB_BOOT_FLAG) == 0 {
        defmt::info!("USB boot flag not set");
        return false;
    }
    let clear =
        RawError::convert(unsafe { raw::sd_power_gpregret_clr(0, USB_BOOT_FLAG as u32) });
    match clear {
        Ok(()) => defmt::info!("Cleared USB boot flag"),
        Err(err) => defmt::warn!("Clear USB boot flag failed: {:?}", err),
    }
    true
}

#[embassy_executor::task]
async fn softdevice_task(
    sd: &'static Softdevice,
    vbus: &'static SoftwareVbusDetect,
    usb_present: bool,
    usb_only: bool,
) {
    let mut hfclk_requested = false;
    if usb_present {
        let _ = unsafe { raw::sd_clock_hfclk_request() };
        hfclk_requested = true;
    }

    sd.run_with_callback(move |event| match event {
        SocEvent::PowerUsbDetected => {
            USB_CONNECTED.store(true, Ordering::Release);
            defmt::info!("USB detected");
            vbus.detected(true);
            if !hfclk_requested {
                let _ = unsafe { raw::sd_clock_hfclk_request() };
                hfclk_requested = true;
            }
        }
        SocEvent::PowerUsbRemoved => {
            USB_CONNECTED.store(false, Ordering::Release);
            defmt::info!("USB removed");
            vbus.detected(false);
            if hfclk_requested {
                let _ = unsafe { raw::sd_clock_hfclk_release() };
                hfclk_requested = false;
            }
            if usb_only {
                SCB::sys_reset();
            }
        }
        SocEvent::PowerUsbPowerReady => vbus.ready(),
        _ => {}
    })
    .await
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

fn init_usb_power_events(vbus: &SoftwareVbusDetect) -> bool {
    unsafe {
        let _ = raw::sd_power_usbdetected_enable(1);
        let _ = raw::sd_power_usbremoved_enable(1);
        let _ = raw::sd_power_usbpwrrdy_enable(1);
    }

    let mut regstatus = 0u32;
    if RawError::convert(unsafe { raw::sd_power_usbregstatus_get(&mut regstatus as *mut _) })
        .is_ok()
    {
        let detected = (regstatus & 0x1) != 0;
        let ready = (regstatus & 0x2) != 0;
        vbus.detected(detected);
        if detected && ready {
            vbus.ready();
        }
        return detected;
    }

    false
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    config.lfclk_source = embassy_nrf::config::LfclkSource::InternalRC;

    {
        use embassy_nrf::interrupt::Priority;

        config.gpiote_interrupt_priority = Priority::P2;
        config.time_interrupt_priority = Priority::P2;
    }

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
    } = board::Board::new(p);

    let device_name = ble::DEVICE_NAME.as_bytes();
    let sd_config = nrf_softdevice::Config {
        clock: Some(raw::nrf_clock_lf_cfg_t {
            source: raw::NRF_CLOCK_LF_SRC_RC as u8,
            rc_ctiv: 16,
            rc_temp_ctiv: 2,
            accuracy: raw::NRF_CLOCK_LF_ACCURACY_500_PPM as u8,
        }),
        conn_gap: Some(raw::ble_gap_conn_cfg_t {
            conn_count: 1,
            event_length: 24,
        }),
        conn_gatt: Some(raw::ble_gatt_conn_cfg_t { att_mtu: 247 }),
        conn_gatts: Some(raw::ble_gatts_conn_cfg_t {
            hvn_tx_queue_size: 8,
        }),
        common_vs_uuid: Some(raw::ble_common_cfg_vs_uuid_t { vs_uuid_count: 1 }),
        gap_role_count: Some(raw::ble_gap_cfg_role_count_t {
            // S140 7.3.0 supports only one advertising set handle.
            // Find My and connectable BLE must time-share this single handle.
            adv_set_count: 1,
            periph_role_count: 1,
            central_role_count: 0,
            central_sec_count: 0,
            _bitfield_1: raw::ble_gap_cfg_role_count_t::new_bitfield_1(0),
        }),
        gap_device_name: Some(raw::ble_gap_cfg_device_name_t {
            p_value: device_name.as_ptr() as *mut u8,
            current_len: device_name.len() as u16,
            max_len: device_name.len() as u16,
            write_perm: SecurityMode::NoAccess.into_raw(),
            _bitfield_1: raw::ble_gap_cfg_device_name_t::new_bitfield_1(
                raw::BLE_GATTS_VLOC_STACK as u8,
            ),
        }),
        gatts_attr_tab_size: Some(raw::ble_gatts_cfg_attr_tab_size_t {
            attr_tab_size: raw::BLE_GATTS_ATTR_TAB_SIZE_DEFAULT,
        }),
        ..Default::default()
    };
    let sd = Softdevice::enable(&sd_config);
    unsafe { raw::sd_power_dcdc_mode_set(raw::NRF_POWER_DCDC_MODES_NRF_POWER_DCDC_ENABLE as u8) };
    let vbus = usb_msc::init_vbus();
    let usb_present = init_usb_power_events(vbus);
    USB_CONNECTED.store(usb_present, Ordering::Release);
    let usb_boot_requested = take_usb_boot_flag();
    let usb_only = usb_boot_requested;
    defmt::info!(
        "Boot USB: present={} boot_flag={} usb_only={}",
        usb_present,
        usb_boot_requested,
        usb_only
    );
    let server = if usb_only {
        None
    } else {
        Some(BLE_SERVER.init(ble::init_server(sd).unwrap()))
    };
    let sd = &*sd;
    spawner
        .spawn(softdevice_task(sd, vbus, usb_present, usb_only))
        .unwrap();
    spawner.spawn(usb_mode_task()).unwrap();
    if usb_only {
        #[cfg(feature = "i2c-spi")]
        spawner.spawn(usb_msc::usb_msc_task(usbd, vbus)).unwrap();
        #[cfg(not(feature = "i2c-spi"))]
        defmt::warn!("USB MSC disabled (feature i2c-spi off)");
    }
    if let Some(server) = server {
        spawner.spawn(ble::ble_task(sd, server)).unwrap();
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
        spawner.spawn(findmy::findmy_task(sd)).unwrap();
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
        spawner.spawn(button::usb_only_button_task(button)).unwrap();
    }

    let _unused = (serial2_rx, serial2_tx);
    #[cfg(not(feature = "i2c-spi"))]
    {
        let _unused_spi = (spi3, spi_sck, spi_miso, spi_mosi, spi_cs);
        let _unused_i2c = (twispi0, i2c_sda, i2c_scl);
        let _ = (_unused_spi, _unused_i2c);
    }

    core::future::pending::<()>().await;
}
