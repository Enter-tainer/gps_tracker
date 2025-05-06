#include "battery.h"
#include "system_info.h"
#include "variant.h" // Includes board-specific definitions like BATTERY_PIN, REAL_VBAT_MV_PER_LSB etc.
#include <Arduino.h>
#include <timers.h>

// EMA滤波系数，值越小，平滑效果越强，但响应越慢
// 范围0.0-1.0，推荐值在0.1-0.3之间
#define BATTERY_EMA_ALPHA 0.2f

// 存储上一次EMA滤波后的电压值
static float lastFilteredVoltageMv = 0.0f;
// EMA初始化标志
static bool emaInitialized = false;

void initBattery() {
#ifdef BATTERY_PIN
  // Configure the ADC reference voltage
  analogReference(
      VBAT_AR_INTERNAL); // Use the internal reference defined in variant.h

  // Configure the ADC resolution
  analogReadResolution(
      BATTERY_SENSE_RESOLUTION_BITS); // Use the resolution defined in variant.h

  // It's good practice to ensure the pin is an input, though analogRead often
  // handles this.
  pinMode(BATTERY_PIN, INPUT);

  // Optional: A small delay to allow the ADC reference to stabilize
  delay(1);

  // 重置EMA初始化标志
  emaInitialized = false;
#endif
}

uint32_t readBatteryVoltageMv() {
#ifdef BATTERY_PIN
  // Read the raw ADC value
  uint32_t adc_raw = analogRead(BATTERY_PIN);

  // Convert the raw ADC value to millivolts using the pre-calculated factor
  // from variant.h This factor already includes the voltage divider ratio and
  // any compensation.
  uint32_t voltageMv = VBAT_RAW_TO_SCALED(adc_raw);

  // 应用EMA滤波
  if (!emaInitialized) {
    // 首次读取，直接使用当前值初始化
    lastFilteredVoltageMv = (float)voltageMv;
    emaInitialized = true;
  } else {
    // EMA公式: filteredValue = alpha * currentValue + (1 - alpha) *
    // lastFilteredValue
    lastFilteredVoltageMv = BATTERY_EMA_ALPHA * (float)voltageMv +
                            (1.0f - BATTERY_EMA_ALPHA) * lastFilteredVoltageMv;
  }

  // 返回滤波后的值（转回uint32_t）
  return (uint32_t)lastFilteredVoltageMv;

  // Or using the constant directly:
  // uint32_t voltageMv = (uint32_t)(adc_raw * REAL_VBAT_MV_PER_LSB);

#else
  // Return 0 or some indicator that battery reading is not available
  return 0;
#endif
}

float estimateBatteryLevel(float voltageMv) {
  // Piecewise linear interpolation based on provided data, with 3.2V as 0% SoC.
  // Data points derived from user input, rescaled so 3.2V=0% and 4.2V=100%.

  // Define the voltage points (mV) and corresponding rescaled SoC (%)
  const int num_points = 9;
  const float voltage_points[num_points] = {3200.0f, 3400.0f, 3500.0f,
                                            3600.0f, 3700.0f, 3800.0f,
                                            3900.0f, 4000.0f, 4200.0f};
  // Rescaled SoC points: 0, 13, 25, 38, 50, 63, 75, 88, 100
  const float soc_points[num_points] = {0.0f,  13.0f, 25.0f, 38.0f, 50.0f,
                                        63.0f, 75.0f, 88.0f, 100.0f};

  // Handle edge cases: voltage below the minimum or above the maximum
  if (voltageMv <= voltage_points[0]) { // Voltage <= 3.2V
    return soc_points[0];               // 0%
  }
  if (voltageMv >= voltage_points[num_points - 1]) { // Voltage >= 4.2V
    return soc_points[num_points - 1];               // 100%
  }

  // Find the interval where the voltage lies
  for (int i = 1; i < num_points; ++i) {
    if (voltageMv <= voltage_points[i]) {
      // Found the interval [voltage_points[i-1], voltage_points[i]]
      // Perform linear interpolation within this interval
      float v1 = voltage_points[i - 1];
      float v2 = voltage_points[i];
      float soc1 = soc_points[i - 1];
      float soc2 = soc_points[i];

      // Avoid division by zero if points are identical
      if (v2 == v1) {
        return soc1;
      }

      // Calculate the interpolated SoC using floating point arithmetic
      // Formula: soc = soc1 + (voltageMv - v1) * (soc2 - soc1) / (v2 - v1)
      float soc_interpolated =
          soc1 + ((float)voltageMv - v1) * (soc2 - soc1) / (v2 - v1);

      return soc_interpolated;
    }
  }

  // Fallback case (should ideally not be reached if logic is correct)
  return 0.0f;
}

void updateBatteryInfo(TimerHandle_t handle) {
  // 读取电池电压并使用浮点计算更新系统信息
  uint32_t voltageMv = readBatteryVoltageMv();
  if (voltageMv > 0) {
    gSystemInfo.batteryVoltage = voltageMv / 1000.0f; // 转换为伏特
  } else {
    gSystemInfo.batteryVoltage = -1.0f; // 表示无效读数
  }
}
