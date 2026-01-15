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

const ACCEL_HISTORY_SIZE: usize = 256;
const ACCEL_STILL_THRESHOLD: f32 = 0.1;
const ACCEL_JUMP_THRESHOLD: f32 = 2.0;
const ACCEL_UPDATE_INTERVAL_MS: u64 = 50;

type SharedI2c = I2cDevice<'static, NoopRawMutex, twim::Twim<'static>>;
type Lis3dhBus = Lis3dh<Lis3dhI2C<SharedI2c>>;

#[derive(Clone, Copy)]
struct RingBuffer<const N: usize> {
    data: [f32; N],
    len: usize,
    head: usize,
}

impl<const N: usize> RingBuffer<N> {
    const fn new() -> Self {
        Self {
            data: [0.0; N],
            len: 0,
            head: 0,
        }
    }

    fn push(&mut self, value: f32) {
        self.data[self.head] = value;
        if self.len < N {
            self.len += 1;
        }
        self.head = (self.head + 1) % N;
    }

    fn len(&self) -> usize {
        self.len
    }

    fn last(&self) -> Option<f32> {
        if self.len == 0 {
            return None;
        }
        let idx = (self.head + N - 1) % N;
        Some(self.data[idx])
    }

    fn second_last(&self) -> Option<f32> {
        if self.len < 2 {
            return None;
        }
        let idx = (self.head + N - 2) % N;
        Some(self.data[idx])
    }

    fn min_max(&self) -> Option<(f32, f32)> {
        if self.len == 0 {
            return None;
        }
        let mut min_val = self.data[0];
        let mut max_val = self.data[0];
        for i in 1..self.len {
            let value = self.data[i];
            if value < min_val {
                min_val = value;
            }
            if value > max_val {
                max_val = value;
            }
        }
        Some((min_val, max_val))
    }
}

struct AccelAnalyzer {
    history: RingBuffer<ACCEL_HISTORY_SIZE>,
    still_threshold: f32,
    jump_threshold: f32,
}

impl AccelAnalyzer {
    fn new() -> Self {
        Self {
            history: RingBuffer::new(),
            still_threshold: ACCEL_STILL_THRESHOLD,
            jump_threshold: ACCEL_JUMP_THRESHOLD,
        }
    }

    fn add_sample(&mut self, total: f32) {
        self.history.push(total);
    }

    fn is_still(&self) -> bool {
        let Some((min_val, max_val)) = self.history.min_max() else {
            return false;
        };
        (max_val - min_val) < self.still_threshold
    }

    fn has_jump(&self) -> bool {
        let (Some(last), Some(prev)) = (self.history.last(), self.history.second_last()) else {
            return false;
        };
        let diff = (last - prev).abs();
        diff > self.jump_threshold || last < 0.2
    }
}

struct AccelHandler {
    ok: bool,
    last_x: f32,
    last_y: f32,
    last_z: f32,
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
                    last_x: 0.0,
                    last_y: 0.0,
                    last_z: 0.0,
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
            last_x: 0.0,
            last_y: 0.0,
            last_z: 0.0,
            lis: Some(lis),
        }
    }

    fn update(&mut self) -> bool {
        if !self.ok {
            return false;
        }
        let Some(lis) = self.lis.as_mut() else {
            return false;
        };

        match lis.accel_norm() {
            Ok(vec) => {
                self.last_x = vec.x;
                self.last_y = vec.y;
                self.last_z = vec.z;
                true
            }
            Err(_) => {
                defmt::warn!("LIS3DH read failed");
                false
            }
        }
    }

    fn total(&self) -> f32 {
        sqrtf(self.last_x * self.last_x + self.last_y * self.last_y + self.last_z * self.last_z)
    }
}

#[task]
pub async fn accel_task(i2c: SharedI2c) {
    let mut accel = AccelHandler::new(i2c);
    let mut analyzer = AccelAnalyzer::new();

    loop {
        if accel.update() {
            let total = accel.total();
            analyzer.add_sample(total);

            let still = analyzer.is_still();
            {
                let mut info = SYSTEM_INFO.lock().await;
                info.is_stationary = still;
            }

            if analyzer.has_jump() {
                ble::request_fast_advertising();
            }
        }

        Timer::after_millis(ACCEL_UPDATE_INTERVAL_MS).await;
    }
}
