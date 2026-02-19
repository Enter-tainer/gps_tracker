use embassy_embedded_hal::shared_bus::blocking::i2c::I2cDevice;
use embassy_executor::task;
use embassy_nrf::twim;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_time::Timer;
use lis3dh::{Configuration, DataRate, Lis3dh, Lis3dhI2C, Mode, Range, SlaveAddr};
use libm::sqrtf;

use lis3dh::accelerometer::Accelerometer;

use crate::ble;
use crate::system_info::SYSTEM_INFO;

const ACCEL_UPDATE_INTERVAL_MS: u64 = 50;
const ALPHA_LP: f32 = 0.05;
const ALPHA_E: f32 = 0.20;
const STILL_ENTER_DYN_G: f32 = 0.04;
const STILL_EXIT_DYN_G: f32 = 0.08;
const STILL_ENTER_FRAMES: u16 = 120;
const STILL_EXIT_FRAMES: u16 = 8;
const NORM_BASE_ALPHA: f32 = 0.02;
const FREEFALL_SCALE: f32 = 0.22;
const FREEFALL_MIN_G: f32 = 0.18;
const FREEFALL_MAX_G: f32 = 0.30;
const FREEFALL_FRAMES: u8 = 2;
const BLE_COOLDOWN_FRAMES: u8 = 40;

type SharedI2c = I2cDevice<'static, NoopRawMutex, twim::Twim<'static>>;
type Lis3dhBus = Lis3dh<Lis3dhI2C<SharedI2c>>;

#[derive(Clone, Copy)]
struct MotionOutput {
    stationary: bool,
    trigger_fast_adv: bool,
}

struct MotionFilter {
    initialized: bool,
    lp_x: f32,
    lp_y: f32,
    lp_z: f32,
    e_ema: f32,
    norm_base: f32,
    stationary: bool,
    still_cnt: u16,
    move_cnt: u16,
    ff_cnt: u8,
    ble_cooldown_cnt: u8,
}

impl MotionFilter {
    const fn new() -> Self {
        Self {
            initialized: false,
            lp_x: 0.0,
            lp_y: 0.0,
            lp_z: 0.0,
            e_ema: 0.0,
            norm_base: 1.0,
            stationary: false,
            still_cnt: 0,
            move_cnt: 0,
            ff_cnt: 0,
            ble_cooldown_cnt: 0,
        }
    }

    fn update(&mut self, x: f32, y: f32, z: f32) -> MotionOutput {
        let norm = vec_norm(x, y, z);

        if !self.initialized {
            self.initialized = true;
            self.lp_x = x;
            self.lp_y = y;
            self.lp_z = z;
            self.norm_base = norm;
            self.e_ema = 0.0;
        }

        self.lp_x += ALPHA_LP * (x - self.lp_x);
        self.lp_y += ALPHA_LP * (y - self.lp_y);
        self.lp_z += ALPHA_LP * (z - self.lp_z);

        let hp_x = x - self.lp_x;
        let hp_y = y - self.lp_y;
        let hp_z = z - self.lp_z;
        let energy = hp_x * hp_x + hp_y * hp_y + hp_z * hp_z;
        self.e_ema = ALPHA_E * energy + (1.0 - ALPHA_E) * self.e_ema;
        let dyn_g = sqrtf(self.e_ema.max(0.0));

        if self.stationary {
            if dyn_g > STILL_EXIT_DYN_G {
                self.move_cnt = self.move_cnt.saturating_add(1);
            } else {
                self.move_cnt = 0;
            }

            if self.move_cnt >= STILL_EXIT_FRAMES {
                self.stationary = false;
                self.move_cnt = 0;
                self.still_cnt = 0;
            }
        } else {
            if dyn_g < STILL_ENTER_DYN_G {
                self.still_cnt = self.still_cnt.saturating_add(1);
            } else {
                self.still_cnt = 0;
            }

            if self.still_cnt >= STILL_ENTER_FRAMES {
                self.stationary = true;
                self.still_cnt = 0;
                self.move_cnt = 0;
            }
        }

        if self.stationary {
            self.norm_base += NORM_BASE_ALPHA * (norm - self.norm_base);
        }

        let ff_thr = clamp_f32(FREEFALL_SCALE * self.norm_base, FREEFALL_MIN_G, FREEFALL_MAX_G);
        if norm < ff_thr {
            self.ff_cnt = self.ff_cnt.saturating_add(1);
        } else {
            self.ff_cnt = 0;
        }

        if self.ble_cooldown_cnt > 0 {
            self.ble_cooldown_cnt -= 1;
        }

        let mut trigger_fast_adv = false;
        if self.ff_cnt >= FREEFALL_FRAMES && self.ble_cooldown_cnt == 0 {
            trigger_fast_adv = true;
            self.ff_cnt = 0;
            self.ble_cooldown_cnt = BLE_COOLDOWN_FRAMES;
        }

        MotionOutput {
            stationary: self.stationary,
            trigger_fast_adv,
        }
    }
}

fn vec_norm(x: f32, y: f32, z: f32) -> f32 {
    sqrtf(x * x + y * y + z * z)
}

fn clamp_f32(value: f32, min: f32, max: f32) -> f32 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

struct AccelHandler {
    ok: bool,
    lis: Option<Lis3dhBus>,
}

impl AccelHandler {
    fn new(i2c: SharedI2c) -> Self {
        let config = Configuration {
            mode: Mode::HighResolution,
            datarate: DataRate::Hz_50,
            ..Default::default()
        };

        let mut lis = match Lis3dh::new_i2c_with_config(i2c, SlaveAddr::Alternate, config) {
            Ok(lis) => lis,
            Err(_) => {
                defmt::warn!("LIS3DH init failed");
                return Self {
                    ok: false,
                    lis: None,
                };
            }
        };

        if lis.set_range(Range::G2).is_err() {
            defmt::warn!("LIS3DH range set failed");
        }

        defmt::info!("LIS3DH initialized");
        Self {
            ok: true,
            lis: Some(lis),
        }
    }

    fn read_xyz(&mut self) -> Option<(f32, f32, f32)> {
        if !self.ok {
            return None;
        }
        let Some(lis) = self.lis.as_mut() else {
            return None;
        };

        match lis.accel_norm() {
            Ok(vec) => Some((vec.x, vec.y, vec.z)),
            Err(_) => {
                defmt::warn!("LIS3DH read failed");
                None
            }
        }
    }
}

#[task]
pub async fn accel_task(i2c: SharedI2c) {
    let mut accel = AccelHandler::new(i2c);
    let mut filter = MotionFilter::new();

    loop {
        if let Some((x, y, z)) = accel.read_xyz() {
            let output = filter.update(x, y, z);

            {
                let mut info = SYSTEM_INFO.lock().await;
                info.is_stationary = output.stationary;
            }

            if output.trigger_fast_adv {
                ble::request_fast_advertising();
            }
        }

        Timer::after_millis(ACCEL_UPDATE_INTERVAL_MS).await;
    }
}
