use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::task;
use embassy_nrf::twim;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::Timer;
use libm::powf;

use bmp280_rs::{BMP280, Config, I2CAddress, ModeNormal, ModeSleep};

const BMP280_UPDATE_INTERVAL_MS: u64 = 50;
const BMP280_SEA_LEVEL_HPA: f32 = 1017.9;

type SharedI2c = I2cDevice<'static, NoopRawMutex, twim::Twim<'static>>;

#[derive(Clone, Copy)]
pub struct Bmp280Data {
    pub ok: bool,
    pub temperature_c: f32,
    pub pressure_pa: f32,
    pub altitude_m: f32,
}

impl Bmp280Data {
    const fn new() -> Self {
        Self {
            ok: false,
            temperature_c: 0.0,
            pressure_pa: 0.0,
            altitude_m: 0.0,
        }
    }
}

pub static BMP280_DATA: Mutex<CriticalSectionRawMutex, Bmp280Data> =
    Mutex::new(Bmp280Data::new());

#[task]
pub async fn bmp280_task(mut i2c: SharedI2c) {
    let mut ok = false;
    let mut bmp: Option<BMP280<SharedI2c, ModeNormal>> = None;

    match BMP280::<SharedI2c, ModeSleep>::new(
        &mut i2c,
        I2CAddress::SdoGrounded,
        Config::indoor_navigation(),
    ) {
        Ok(bmp_sleep) => match bmp_sleep.into_normal_mode(&mut i2c) {
            Ok(bmp_normal) => {
                bmp = Some(bmp_normal);
                ok = true;
                defmt::info!("BMP280 initialized");
            }
            Err(_) => {
                defmt::warn!("BMP280 mode set failed");
            }
        },
        Err(_) => {
            defmt::warn!("BMP280 init failed");
        }
    }

    let mut data = Bmp280Data::new();
    data.ok = ok;

    loop {
        if let Some(bmp) = bmp.as_mut() {
            if let (Ok(temp), Ok(press)) = (
                bmp.read_temperature(&mut i2c),
                bmp.read_pressure(&mut i2c),
            ) {
                let temperature_c = temp as f32 / 100.0;
                let pressure_pa = press as f32 / 256.0;
                let altitude_m = pressure_to_altitude(pressure_pa);
                data.temperature_c = temperature_c;
                data.pressure_pa = pressure_pa;
                data.altitude_m = altitude_m;
            }
        }

        {
            let mut guard = BMP280_DATA.lock().await;
            *guard = data;
        }

        Timer::after_millis(BMP280_UPDATE_INTERVAL_MS).await;
    }
}

fn pressure_to_altitude(pressure_pa: f32) -> f32 {
    let sea_level_pa = BMP280_SEA_LEVEL_HPA * 100.0;
    if pressure_pa <= 0.0 {
        return 0.0;
    }
    let ratio = pressure_pa / sea_level_pa;
    44_330.0 * (1.0 - powf(ratio, 0.1903))
}
