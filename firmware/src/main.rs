#![no_std]
#![no_main]

mod ble;
mod board;
mod casic;
mod gps;
mod protocol;
mod storage;
mod system_info;

use core::mem;

use embassy_executor::Spawner;
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_nrf::{bind_interrupts, buffered_uarte, peripherals, spim, twim, uarte};
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::Timer;
use static_cell::StaticCell;

use {defmt_rtt as _, panic_probe as _};
use nrf_softdevice::{raw, Softdevice};

bind_interrupts!(struct Irqs {
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
    SPIM3 => spim::InterruptHandler<peripherals::SPI3>;
});

// DMA buffers must live in RAM for UARTE/TWIM.
static mut GPS_RX_BUF: [u8; 512] = [0; 512];
static mut GPS_TX_BUF: [u8; 128] = [0; 128];
static mut I2C_TX_BUF: [u8; 32] = [0; 32];
static BLE_SERVER: StaticCell<ble::Server> = StaticCell::new();

#[embassy_executor::task]
async fn softdevice_task(sd: &'static Softdevice) {
    sd.run().await
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
        button,
        gps_uart_rx,
        gps_uart_tx,
        gps_en,
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
        saadc,
        timer0,
        ppi_ch0,
        ppi_ch1,
        ppi_group0,
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
            write_perm: unsafe { mem::zeroed() },
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
    let server = BLE_SERVER.init(ble::init_server(sd).unwrap());
    let sd = &*sd;
    spawner.spawn(softdevice_task(sd)).unwrap();
    spawner.spawn(ble::ble_task(sd, server)).unwrap();

    // LED is on P0.15 per promicro_diy variant.
    let mut led = Output::new(led, Level::Low, OutputDrive::Standard);

    // Phase 2 bring-up: create core drivers.
    let mut _gps_uart = unsafe {
        let mut cfg = uarte::Config::default();
        cfg.baudrate = uarte::Baudrate::BAUD115200;
        let rx_buf = &mut *core::ptr::addr_of_mut!(GPS_RX_BUF);
        let tx_buf = &mut *core::ptr::addr_of_mut!(GPS_TX_BUF);
        buffered_uarte::BufferedUarte::new(
            uarte0,
            timer0,
            ppi_ch0,
            ppi_ch1,
            ppi_group0,
            gps_uart_rx,
            gps_uart_tx,
            Irqs,
            cfg,
            rx_buf,
            tx_buf,
        )
    };

    let i2c = unsafe {
        let cfg = twim::Config::default();
        let tx_buf = &mut *core::ptr::addr_of_mut!(I2C_TX_BUF);
        twim::Twim::new(twispi0, Irqs, i2c_sda, i2c_scl, cfg, tx_buf)
    };
    let _i2c_bus: Mutex<NoopRawMutex, twim::Twim<'static>> = Mutex::new(i2c);

    let mut _spi = {
        let mut cfg = spim::Config::default();
        cfg.frequency = spim::Frequency::K250;
        cfg.orc = 0xFF;
        spim::Spim::new(spi3, Irqs, spi_sck, spi_miso, spi_mosi, cfg)
    };

    let _sd_cs = Output::new(spi_cs, Level::High, OutputDrive::Standard);
    if !storage::init_sd_logger(_spi, _sd_cs) {
        defmt::warn!("SD logger init failed");
    }
    let gps_en = Output::new(gps_en, Level::Low, OutputDrive::Standard);
    let (gps_rx, gps_tx) = _gps_uart.split();
    spawner.spawn(gps::gps_rx_task(gps_rx)).unwrap();
    spawner.spawn(gps::gps_state_task(gps_tx, gps_en)).unwrap();

    let _unused = (
        button,
        battery_adc,
        v3v3_en,
        serial2_rx,
        serial2_tx,
        saadc,
        _i2c_bus,
    );

    loop {
        led.set_high();
        defmt::info!("LED ON");
        Timer::after_millis(100).await;
        led.set_low();
        defmt::info!("LED OFF");
        Timer::after_millis(100).await;
    }
}
