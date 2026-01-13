#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_time::Timer;

use {defmt_rtt as _, panic_probe as _};

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    config.lfclk_source = embassy_nrf::config::LfclkSource::InternalRC;
    let p = embassy_nrf::init(config);

    // LED is on P0.15 per promicro_diy variant.
    let mut led = Output::new(p.P0_15, Level::Low, OutputDrive::Standard);

    loop {
        led.set_high();
        defmt::info!("LED ON");
        Timer::after_millis(100).await;
        led.set_low();
        defmt::info!("LED OFF");
        Timer::after_millis(100).await;
    }
}
