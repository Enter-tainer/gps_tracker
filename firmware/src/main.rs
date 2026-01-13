#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_time::Timer;

use {defmt_rtt as _, panic_probe as _};
use nrf_softdevice::Softdevice;

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

    let sd = Softdevice::enable(&Default::default());
    spawner.spawn(softdevice_task(sd)).unwrap();

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
