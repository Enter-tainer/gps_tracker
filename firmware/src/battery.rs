use embassy_executor::task;
use embassy_nrf::saadc::Saadc;
use embassy_time::Timer;

use crate::system_info::SYSTEM_INFO;

const BATTERY_UPDATE_INTERVAL_MS: u64 = 1_000;
const BATTERY_EMA_ALPHA: f32 = 0.2;
const VBAT_MV_PER_LSB: f32 = 0.73242188;
const VBAT_DIVIDER_COMP: f32 = 1.67;
const REAL_VBAT_MV_PER_LSB: f32 = VBAT_MV_PER_LSB * VBAT_DIVIDER_COMP;

#[task]
pub async fn battery_task(mut saadc: Saadc<'static, 1>) {
    let mut ema_initialized = false;
    let mut last_filtered_mv = 0.0f32;
    let mut sample = [0i16; 1];

    loop {
        saadc.sample(&mut sample).await;
        let raw = sample[0].max(0) as u16;
        let voltage_mv = raw as f32 * REAL_VBAT_MV_PER_LSB;

        if voltage_mv > 0.0 {
            if !ema_initialized {
                last_filtered_mv = voltage_mv;
                ema_initialized = true;
            } else {
                last_filtered_mv =
                    BATTERY_EMA_ALPHA * voltage_mv + (1.0 - BATTERY_EMA_ALPHA) * last_filtered_mv;
            }

            let mut info = SYSTEM_INFO.lock().await;
            info.battery_voltage = last_filtered_mv / 1000.0;
        } else {
            let mut info = SYSTEM_INFO.lock().await;
            info.battery_voltage = -1.0;
        }

        Timer::after_millis(BATTERY_UPDATE_INTERVAL_MS).await;
    }
}

pub fn estimate_battery_level(voltage_mv: f32) -> f32 {
    const VOLTAGE_POINTS: [f32; 9] = [
        2500.0, 3050.0, 3600.0, 3700.0, 3780.0, 3900.0, 3980.0, 4080.0, 4200.0,
    ];
    const SOC_POINTS: [f32; 9] = [0.0, 13.0, 25.0, 38.0, 50.0, 63.0, 75.0, 88.0, 100.0];

    if voltage_mv <= VOLTAGE_POINTS[0] {
        return SOC_POINTS[0];
    }
    if voltage_mv >= VOLTAGE_POINTS[VOLTAGE_POINTS.len() - 1] {
        return SOC_POINTS[SOC_POINTS.len() - 1];
    }

    for idx in 1..VOLTAGE_POINTS.len() {
        if voltage_mv <= VOLTAGE_POINTS[idx] {
            let v1 = VOLTAGE_POINTS[idx - 1];
            let v2 = VOLTAGE_POINTS[idx];
            let soc1 = SOC_POINTS[idx - 1];
            let soc2 = SOC_POINTS[idx];
            if (v2 - v1).abs() < f32::EPSILON {
                return soc1;
            }
            return soc1 + (voltage_mv - v1) * (soc2 - soc1) / (v2 - v1);
        }
    }

    0.0
}
