#ifndef CASIC_GPS_WRAPPER_H
#define CASIC_GPS_WRAPPER_H

#include <TinyGPS++.h>
#include <stdint.h>

// CASIC协议相关常量
constexpr uint8_t CASIC_HEADER_1 = 0xBA;
constexpr uint8_t CASIC_HEADER_2 = 0xCE;
constexpr uint8_t CASIC_MAX_PAYLOAD_SIZE = 256;
constexpr uint8_t CASIC_PACKET_TIMEOUT_MS = 1000;

// CASIC消息类型定义
constexpr uint8_t CASIC_CLASS_ACK = 0x05;
constexpr uint8_t CASIC_CLASS_NACK = 0x05;
constexpr uint8_t CASIC_CLASS_AID = 0x0B;
constexpr uint8_t CASIC_CLASS_MSG = 0x08;

constexpr uint8_t CASIC_ID_ACK = 0x01;
constexpr uint8_t CASIC_ID_NACK = 0x00;
constexpr uint8_t CASIC_ID_AID_INI = 0x01;
constexpr uint8_t CASIC_ID_MSG_BDSUTC = 0x00;
constexpr uint8_t CASIC_ID_MSG_BDSION = 0x01;
constexpr uint8_t CASIC_ID_MSG_BDSEPH = 0x02;
constexpr uint8_t CASIC_ID_MSG_GPSUTC = 0x05;
constexpr uint8_t CASIC_ID_MSG_GPSION = 0x06;
constexpr uint8_t CASIC_ID_MSG_GPSEPH = 0x07;

// CASIC解析器状态机状态
enum class CasicParserState {
  CASIC_IDLE = 0,       // 空闲状态，等待数据包开始
  CASIC_HEADER_1,       // 接收到0xBA，等待0xCE
  CASIC_HEADER_2,       // 接收到0xBA 0xCE，开始读取长度
  CASIC_LENGTH_1,       // 读取长度字段第1字节（小端序）
  CASIC_LENGTH_2,       // 读取长度字段第2字节
  CASIC_CLASS_ID,       // 读取Class字段
  CASIC_MSG_ID,         // 读取ID字段
  CASIC_PAYLOAD,        // 读取Payload数据
  CASIC_CHECKSUM_1,     // 读取校验和第1字节
  CASIC_CHECKSUM_2,     // 读取校验和第2字节
  CASIC_CHECKSUM_3,     // 读取校验和第3字节
  CASIC_CHECKSUM_4,     // 读取校验和第4字节
  CASIC_PACKET_COMPLETE // 数据包接收完成
};

// CASIC数据包结构
struct CasicPacket {
  uint8_t class_id;                        // 消息类别
  uint8_t msg_id;                          // 消息ID
  uint16_t payload_length;                 // Payload长度
  uint8_t payload[CASIC_MAX_PAYLOAD_SIZE]; // Payload数据
  uint32_t checksum;                       // 接收到的校验和
  uint32_t calculated_checksum;            // 计算的校验和
  bool valid;                              // 数据包是否有效
  unsigned long timestamp;                 // 接收时间戳
};

// CASIC GPS包装器类
class CasicGpsWrapper {
private:
  TinyGPSPlus _tinyGPS;           // 内部TinyGPS++实例
  CasicParserState _state;        // 当前解析状态
  CasicPacket _currentPacket;     // 当前正在解析的数据包
  uint16_t _payloadIndex;         // Payload数据索引
  uint8_t _checksumBytes[4];      // 校验和字节数组
  uint8_t _checksumIndex;         // 校验和字节索引
  unsigned long _stateChangeTime; // 状态改变时间（用于超时检测）
  bool _newCasicData;             // 是否有新的CASIC数据
  CasicPacket _lastValidPacket;   // 最后一个有效的CASIC数据包

  // 内部方法
  void resetParser();                  // 重置解析器状态
  bool isTimeout();                    // 检查是否超时
  uint32_t calculateChecksum();        // 计算校验和
  void processCompletedPacket();       // 处理完成的数据包
  bool processCasicByte(uint8_t byte); // 处理CASIC协议字节

public:
  CasicGpsWrapper();

  // 主要接口
  bool encode(uint8_t byte); // 处理单个字节（兼容TinyGPS++接口）
  TinyGPSPlus &getTinyGPS(); // 获取内部TinyGPS++实例

  // CASIC相关接口
  bool isNewCasicData();            // 是否有新的CASIC数据
  CasicPacket getLastCasicPacket(); // 获取最后接收的CASIC包
  void clearCasicData();            // 清除CASIC数据标志

  // 调试和状态接口
  CasicParserState getParserState(); // 获取当前解析状态
  void reset();                      // 完全重置解析器

  // 便捷方法 - 检查特定类型的CASIC消息
  bool hasNewAck();       // 是否收到新的ACK
  bool hasNewNack();      // 是否收到新的NACK
  bool hasNewEphemeris(); // 是否收到新的星历数据
};

#endif // CASIC_GPS_WRAPPER_H
