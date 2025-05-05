#ifndef GPX_LOGGER_H
#define GPX_LOGGER_H

#include <stdint.h>

// 内部存储的 GPS 航迹点的数据结构 (使用缩放后的整数) - 恢复这个结构体
#pragma pack(push, 1)
typedef struct {
  uint32_t timestamp;           // Unix 时间戳 (秒)
  int32_t latitude_scaled_1e7;  // 纬度 (度 * 10^7)
  int32_t longitude_scaled_1e7; // 经度 (度 * 10^7)
  float altitude_m;             // 海拔 (米)
} GpxPointInternal;
#pragma pack(pop)

/**
 * @brief 追加一个新的 GPS 点。
 *        此函数将进行数据缩放，打包并调用文件系统处理程序进行写入。
 *
 * @param timestamp Unix 时间戳 (秒)。
 * @param latitude 纬度 (度)。
 * @param longitude 经度 (度)。
 * @param altitude_m 海拔 (米)。
 * @return true 如果成功调用写入, false 如果失败。
 */
bool appendGpxPoint(uint32_t timestamp, double latitude, double longitude,
                    float altitude_m);

#endif // GPX_LOGGER_H
