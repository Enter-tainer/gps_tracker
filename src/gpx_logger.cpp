// filepath: src/gpx_logger.cpp
#include "gpx_logger.h"
#include "littlefs_handler.h" // <--- 包含 littlefs_handler
#include "logger.h"
#include <Arduino.h> // For Serial
#include <math.h>    // For round()

/**
 * @brief 追加一个新的 GPS 点。
 *        此函数将进行数据缩放，打包并调用文件系统处理程序进行写入。
 */
uint32_t last_timestamp = 0;
uint32_t last_nrf_timestamp = 0;
bool appendGpxPoint(uint32_t timestamp, double latitude, double longitude,
                    float altitude_m) {
  if (timestamp == 0) {
    Log.println(
        "Warning: Attempted to log point with zero timestamp. Skipping.");
    return false;
  }

  // 如果timestamp - last_timestamp 与 millis() - last_nrf_timestamp
  // 的差值过大，则认为是 gps 数据异常，直接返回 false
  const auto gps_timestamp_diff =
      static_cast<int32_t>(timestamp) - static_cast<int32_t>(last_timestamp);
  const auto nrf_timestamp_diff = static_cast<int32_t>(millis() / 1000) -
                                  static_cast<int32_t>(last_nrf_timestamp);
  // check nrf timestamp diff >= 0 to avoid timestamp overflow
  if (last_timestamp != 0 && last_nrf_timestamp != 0 &&
      nrf_timestamp_diff >= 0 &&
      abs(gps_timestamp_diff - nrf_timestamp_diff) > 3600) {
    Log.printf(
        "Warning: GPS timestamp (%u) and NRF timestamp (%u) differ too much "
        "(GPS diff: %d, NRF diff: %d). Skipping point.\n",
        timestamp, millis() / 1000, gps_timestamp_diff, nrf_timestamp_diff);
    return false;
  }
  last_timestamp = timestamp;
  last_nrf_timestamp = millis() / 1000; // 记录上次写入的时间戳

  // 创建 GpxPointInternal 实例并进行缩放
  GpxPointInternal entry;
  entry.timestamp = timestamp;
  // 缩放并四舍五入到最近的整数
  entry.latitude_scaled_1e5 = static_cast<int32_t>(round(latitude * 1e5));
  entry.longitude_scaled_1e5 = static_cast<int32_t>(round(longitude * 1e5));
  entry.altitude_m_scaled_1e1 =
      static_cast<int32_t>(round(altitude_m * 10)); // 海拔缩放到分米

  // 调用 LittleFS handler 来写入数据
  return writeGpsLogData(entry); // Pass the scaled data struct
}

GpsDataEncoder::GpsDataEncoder(int full_block_interval)
    : buffer_size_(0), config_full_block_interval_(
                           (full_block_interval < 1) ? 1 : full_block_interval),
      points_since_last_full_block_(0), is_first_point_(true) {
  // previous_point_ is default constructed
}

void GpsDataEncoder::write_uint8(uint8_t val) {
  if (buffer_size_ < sizeof(buffer_)) {
    buffer_[buffer_size_++] = val;
  }
}

void GpsDataEncoder::write_uint32_le(uint32_t val) {
  if (buffer_size_ + 4 <= sizeof(buffer_)) {
    buffer_[buffer_size_++] = static_cast<uint8_t>(val & 0xFF);
    buffer_[buffer_size_++] = static_cast<uint8_t>((val >> 8) & 0xFF);
    buffer_[buffer_size_++] = static_cast<uint8_t>((val >> 16) & 0xFF);
    buffer_[buffer_size_++] = static_cast<uint8_t>((val >> 24) & 0xFF);
  }
}

void GpsDataEncoder::write_int32_le(int32_t val) {
  write_uint32_le(static_cast<uint32_t>(
      val)); // Cast to uint32_t to preserve bit pattern for negative numbers
}

void GpsDataEncoder::write_varint_s32(int32_t val) {
  // ZigZag encoding for int32_t
  uint32_t zz_val =
      (static_cast<uint32_t>(val) << 1) ^ (static_cast<uint32_t>(val >> 31));

  // Varint encoding
  while (zz_val >= 0x80 && buffer_size_ < sizeof(buffer_)) {
    buffer_[buffer_size_++] = static_cast<uint8_t>(zz_val | 0x80);
    zz_val >>= 7;
  }
  if (buffer_size_ < sizeof(buffer_)) {
    buffer_[buffer_size_++] = static_cast<uint8_t>(zz_val);
  }
}

uint32_t GpsDataEncoder::encode(const GpxPointInternal &point) {
  buffer_size_ = 0; // Reset buffer size for each append
  bool use_full_block = false;

  if (is_first_point_) {
    use_full_block = true;
  } else if (config_full_block_interval_ == 1) {
    use_full_block = true;
  } else if (points_since_last_full_block_ >= config_full_block_interval_ - 1) {
    // After config_full_block_interval_ - 1 DELTA blocks, the next one should
    // be FULL
    use_full_block = true;
  }

  if (use_full_block) {
    // Write Full Block
    write_uint8(0xFF); // Header for Full Block
    write_uint32_le(point.timestamp);
    write_int32_le(point.latitude_scaled_1e5);
    write_int32_le(point.longitude_scaled_1e5);
    write_int32_le(point.altitude_m_scaled_1e1);

    points_since_last_full_block_ = 0; // Reset delta counter
    is_first_point_ = false;
  } else {
    // Write Delta Block
    int32_t delta_timestamp =
        point.timestamp -
        previous_point_.timestamp; // Note: uint - uint could wrap, but here
                                   // it's fine for typical deltas.
    int32_t delta_latitude =
        point.latitude_scaled_1e5 - previous_point_.latitude_scaled_1e5;
    int32_t delta_longitude =
        point.longitude_scaled_1e5 - previous_point_.longitude_scaled_1e5;
    int32_t delta_altitude =
        point.altitude_m_scaled_1e1 - previous_point_.altitude_m_scaled_1e1;

    uint8_t header = 0x00; // Delta block header base (bit 7 is 0)
    // Bits: 3 (TS), 2 (Lat), 1 (Lon), 0 (Alt)
    if (delta_timestamp != 0)
      header |= (1 << 3);
    if (delta_latitude != 0)
      header |= (1 << 2);
    if (delta_longitude != 0)
      header |= (1 << 1);
    if (delta_altitude != 0)
      header |= (1 << 0);

    write_uint8(header);

    if (delta_timestamp != 0)
      write_varint_s32(delta_timestamp);
    if (delta_latitude != 0)
      write_varint_s32(delta_latitude);
    if (delta_longitude != 0)
      write_varint_s32(delta_longitude);
    if (delta_altitude != 0)
      write_varint_s32(delta_altitude);

    points_since_last_full_block_++;
  }

  previous_point_ = point;
  return buffer_size_;
}

const uint8_t *GpsDataEncoder::getBuffer() const { return buffer_; }

void GpsDataEncoder::clear() {
  *this = GpsDataEncoder(config_full_block_interval_);
}
