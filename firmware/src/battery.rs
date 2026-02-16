use embassy_executor::task;
use embassy_nrf::saadc::Saadc;
use embassy_time::Timer;

use crate::system_info::SYSTEM_INFO;

const BATTERY_UPDATE_INTERVAL_MS: u64 = 1_000;
const BATTERY_EMA_ALPHA: f32 = 0.2;

// ADC 电压转换常量
// embassy-nrf SAADC 默认配置:
//   - 参考电压: 0.6V (INTERNAL)
//   - 增益: 1/6 (GAIN1_6)
//   - 满量程输入电压: 0.6V * 6 = 3.6V
//   - 分辨率: 12 位 (4096 级)
// 因此: mV/LSB = 3600mV / 4096 = 0.87890625
const VBAT_MV_PER_LSB: f32 = 0.87890625;

// 电池分压网络:
// BAT -> 200kΩ -> ADC -> 300kΩ -> GND
//
// 命名上不再使用 top/bottom，直接写 BAT 侧与 GND 侧，避免接线方向歧义。
// Vadc = Vbat * R_gnd / (R_bat + R_gnd)
// Vbat = Vadc / ADC_RATIO = Vadc * DIVIDER_COMP
const VBAT_R_BAT_SIDE_OHM: f32 = 200_000.0;
const VBAT_R_GND_SIDE_OHM: f32 = 300_000.0;
const VBAT_ADC_RATIO: f32 =
    VBAT_R_GND_SIDE_OHM / (VBAT_R_BAT_SIDE_OHM + VBAT_R_GND_SIDE_OHM); // 0.6
const VBAT_DIVIDER_COMP: f32 = 1.0 / VBAT_ADC_RATIO; // 1.666...

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
    const VOLTAGE_POINTS: [f32; 11] = [
        3000.0, 3300.0, 3500.0, 3600.0, 3700.0, 3800.0, 3850.0, 3900.0, 3950.0, 4100.0, 4200.0,
    ];
    const SOC_POINTS: [f32; 11] = [
        0.0, 5.0, 10.0, 20.0, 35.0, 50.0, 60.0, 70.0, 80.0, 95.0, 100.0,
    ];

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
