#![no_std]
#![no_main]

mod board;
mod casic;
mod gps;
mod system_info;

use embassy_executor::Spawner;
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_nrf::{bind_interrupts, buffered_uarte, peripherals, spim, twim, uarte};
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::Timer;

use {defmt_rtt as _, panic_probe as _};
use nrf_softdevice::Softdevice;

bind_interrupts!(struct Irqs {
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
    SPIM3 => spim::InterruptHandler<peripherals::SPI3>;
});

// DMA buffers must live in RAM for UARTE/TWIM.
static mut GPS_RX_BUF: [u8; 512] = [0; 512];
static mut GPS_TX_BUF: [u8; 128] = [0; 128];
static mut I2C_TX_BUF: [u8; 32] = [0; 32];

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

    let sd = Softdevice::enable(&Default::default());
    spawner.spawn(softdevice_task(sd)).unwrap();

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
        let cfg = spim::Config::default();
        spim::Spim::new(spi3, Irqs, spi_sck, spi_miso, spi_mosi, cfg)
    };

    let mut _sd_cs = Output::new(spi_cs, Level::High, OutputDrive::Standard);
    let gps_en = Output::new(gps_en, Level::Low, OutputDrive::Standard);
    spawner.spawn(gps::gps_task(_gps_uart, gps_en)).unwrap();

    let _unused = (
        button,
        battery_adc,
        v3v3_en,
        serial2_rx,
        serial2_tx,
        saadc,
        _sd_cs,
        _i2c_bus,
        _spi,
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
