#ifndef GPX_LOGGER_H
#define GPX_LOGGER_H

#include <stdint.h>

// 内部存储的 GPS 航迹点的数据结构 (使用缩放后的整数) - 恢复这个结构体
#pragma pack(push, 1)
typedef struct {
  uint32_t timestamp;            // Unix 时间戳 (秒)
  int32_t latitude_scaled_1e5;   // 纬度 (度 * 10^5)
  int32_t longitude_scaled_1e5;  // 经度 (度 * 10^5)
  int32_t altitude_m_scaled_1e1; // 海拔 (米 * 10)
} GpxPointInternal;
#pragma pack(pop)

class GpsDataEncoder {
public:
  /**
   * @brief Constructs a GpsDataEncoder.
   * @param full_block_interval How many points between full blocks.
   * 1 means every point is a full block.
   * N means 1 full block, then N-1 delta blocks, then 1 full block.
   * Defaults to 10.
   */
  GpsDataEncoder(int full_block_interval = 64);

  /**
   * @brief Appends a GPS point to the internal buffer, encoding it.
   * @param point The GpxPoint data to append.
   * @return The number of bytes written to the buffer for this point.
   */
  uint32_t encode(const GpxPointInternal &point);

  /**
   * @brief Gets a constant reference to the internal byte buffer.
   * @return Const reference to the buffer.
   */
  const uint8_t *getBuffer() const;

  /**
   * @brief Clears the internal buffer and resets the encoder's state.
   */
  void clear();

private:
  // Helper methods for writing data in little-endian format
  void write_uint8(uint8_t val);
  void write_uint32_le(uint32_t val);
  void write_int32_le(int32_t val);

  // Helper for ZigZag encoding then Varint encoding an int32_t
  void write_varint_s32(int32_t val);

  uint8_t buffer_[64];
  uint32_t buffer_size_{0};
  GpxPointInternal previous_point_;
  int config_full_block_interval_;
  int points_since_last_full_block_; // Counts DELTA blocks written since last
                                     // FULL block
  bool is_first_point_;
};

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
