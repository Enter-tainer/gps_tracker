// filepath: src/gpx_logger.cpp
#include "gpx_logger.h"
#include "littlefs_handler.h" // <--- 包含 littlefs_handler
#include <Arduino.h>          // For Serial
#include <math.h>             // For round()

/**
 * @brief 追加一个新的 GPS 点。
 *        此函数将进行数据缩放，打包并调用文件系统处理程序进行写入。
 */
bool appendGpxPoint(uint32_t timestamp, double latitude, double longitude,
                    float altitude_m) {
  if (timestamp == 0) {
    Serial.println(
        "Warning: Attempted to log point with zero timestamp. Skipping.");
    return false;
  }

  // 创建 GpxPointInternal 实例并进行缩放
  GpxPointInternal entry;
  entry.timestamp = timestamp;
  // 缩放并四舍五入到最近的整数
  entry.latitude_scaled_1e7 = static_cast<int32_t>(round(latitude * 1e7));
  entry.longitude_scaled_1e7 = static_cast<int32_t>(round(longitude * 1e7));
  entry.altitude_m_scaled_1e2 =
      static_cast<int32_t>(round(altitude_m * 100)); // 海拔缩放到厘米

  // 调用 LittleFS handler 来写入数据
  return writeGpsLogData(entry); // Pass the scaled data struct
}
