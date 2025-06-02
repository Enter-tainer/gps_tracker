#include "casic_gps_wrapper.h"
#include <Arduino.h>

CasicGpsWrapper::CasicGpsWrapper() {
  resetParser();
  _newCasicData = false;
  memset(&_lastValidPacket, 0, sizeof(_lastValidPacket));
}

bool CasicGpsWrapper::encode(uint8_t byte) {
  bool result = false;
  unsigned long currentTime = millis();

  // 检查超时
  if (isTimeout()) {
    resetParser();
  }

  // 首先判断是否是CASIC协议的开始
  if (_state == CasicParserState::CASIC_IDLE && byte == CASIC_HEADER_1) {
    // 可能是CASIC协议包的开始
    _state = CasicParserState::CASIC_HEADER_1;
    _stateChangeTime = currentTime;
    return false; // 不传递给TinyGPS++
  }

  // 处理CASIC协议状态机
  if (_state != CasicParserState::CASIC_IDLE) {
    result = processCasicByte(byte);
    return result;
  }

  // 如果不是CASIC协议，传递给TinyGPS++处理
  return _tinyGPS.encode(byte);
}

bool CasicGpsWrapper::processCasicByte(uint8_t byte) {
  unsigned long currentTime = millis();

  switch (_state) {
  case CasicParserState::CASIC_HEADER_1:
    if (byte == CASIC_HEADER_2) {
      _state = CasicParserState::CASIC_HEADER_2;
      _stateChangeTime = currentTime;
      // 初始化数据包
      memset(&_currentPacket, 0, sizeof(_currentPacket));
      _payloadIndex = 0;
      _checksumIndex = 0;
    } else if (byte == CASIC_HEADER_1) {
      // 仍然是0xBA，保持在HEADER_1状态
      _stateChangeTime = currentTime;
    } else {
      // 不是CASIC协议，重置状态并传递给TinyGPS++
      resetParser();
      return _tinyGPS.encode(byte);
    }
    break;

  case CasicParserState::CASIC_HEADER_2:
    // 读取长度字段第1字节（小端序）
    _currentPacket.payload_length = byte;
    _state = CasicParserState::CASIC_LENGTH_1;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_LENGTH_1:
    // 读取长度字段第2字节
    _currentPacket.payload_length |= (uint16_t)byte << 8;

    // 验证长度是否合理
    if (_currentPacket.payload_length > CASIC_MAX_PAYLOAD_SIZE) {
      resetParser();
      return false;
    }

    _state = CasicParserState::CASIC_LENGTH_2;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_LENGTH_2:
    // 读取Class字段
    _currentPacket.class_id = byte;
    _state = CasicParserState::CASIC_CLASS_ID;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_CLASS_ID:
    // 读取ID字段
    _currentPacket.msg_id = byte;
    _state = CasicParserState::CASIC_MSG_ID;
    _stateChangeTime = currentTime;

    // 如果payload长度为0，直接跳到校验和
    if (_currentPacket.payload_length == 0) {
      _state = CasicParserState::CASIC_CHECKSUM_1;
    } else {
      _state = CasicParserState::CASIC_PAYLOAD;
    }
    break;

  case CasicParserState::CASIC_MSG_ID:
    // 这个状态在上一个case中已经处理
    break;

  case CasicParserState::CASIC_PAYLOAD:
    // 读取Payload数据
    if (_payloadIndex < _currentPacket.payload_length) {
      _currentPacket.payload[_payloadIndex++] = byte;
      _stateChangeTime = currentTime;

      if (_payloadIndex >= _currentPacket.payload_length) {
        _state = CasicParserState::CASIC_CHECKSUM_1;
      }
    }
    break;

  case CasicParserState::CASIC_CHECKSUM_1:
    _checksumBytes[0] = byte;
    _checksumIndex = 1;
    _state = CasicParserState::CASIC_CHECKSUM_2;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_CHECKSUM_2:
    _checksumBytes[1] = byte;
    _checksumIndex = 2;
    _state = CasicParserState::CASIC_CHECKSUM_3;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_CHECKSUM_3:
    _checksumBytes[2] = byte;
    _checksumIndex = 3;
    _state = CasicParserState::CASIC_CHECKSUM_4;
    _stateChangeTime = currentTime;
    break;

  case CasicParserState::CASIC_CHECKSUM_4:
    _checksumBytes[3] = byte;
    _checksumIndex = 4;
    _state = CasicParserState::CASIC_PACKET_COMPLETE;

    // 组装校验和（小端序）
    _currentPacket.checksum = _checksumBytes[0] | (_checksumBytes[1] << 8) |
                              (_checksumBytes[2] << 16) |
                              (_checksumBytes[3] << 24);

    // 处理完成的数据包
    processCompletedPacket();
    resetParser();
    return true;

  default:
    resetParser();
    break;
  }

  return false;
}

void CasicGpsWrapper::processCompletedPacket() {
  // 计算校验和
  _currentPacket.calculated_checksum = calculateChecksum();

  // 验证校验和
  _currentPacket.valid =
      (_currentPacket.checksum == _currentPacket.calculated_checksum);

  if (_currentPacket.valid) {
    _currentPacket.timestamp = millis();
    _lastValidPacket = _currentPacket;
    _newCasicData = true;
  }
}

uint32_t CasicGpsWrapper::calculateChecksum() {
  uint32_t checksum = (_currentPacket.msg_id << 24) +
                      (_currentPacket.class_id << 16) +
                      _currentPacket.payload_length;

  // 按4字节为单位累加Payload
  uint16_t payloadWords = _currentPacket.payload_length / 4;
  for (uint16_t i = 0; i < payloadWords; i++) {
    uint32_t word = _currentPacket.payload[i * 4] |
                    (_currentPacket.payload[i * 4 + 1] << 8) |
                    (_currentPacket.payload[i * 4 + 2] << 16) |
                    (_currentPacket.payload[i * 4 + 3] << 24);
    checksum += word;
  }

  return checksum & 0xFFFFFFFF;
}

void CasicGpsWrapper::resetParser() {
  _state = CasicParserState::CASIC_IDLE;
  _payloadIndex = 0;
  _checksumIndex = 0;
  _stateChangeTime = millis();
  memset(&_currentPacket, 0, sizeof(_currentPacket));
}

bool CasicGpsWrapper::isTimeout() {
  if (_state == CasicParserState::CASIC_IDLE) {
    return false;
  }
  return (millis() - _stateChangeTime) > CASIC_PACKET_TIMEOUT_MS;
}

TinyGPSPlus &CasicGpsWrapper::getTinyGPS() { return _tinyGPS; }

bool CasicGpsWrapper::isNewCasicData() { return _newCasicData; }

CasicPacket CasicGpsWrapper::getLastCasicPacket() { return _lastValidPacket; }

void CasicGpsWrapper::clearCasicData() { _newCasicData = false; }

CasicParserState CasicGpsWrapper::getParserState() { return _state; }

void CasicGpsWrapper::reset() {
  resetParser();
  _newCasicData = false;
  memset(&_lastValidPacket, 0, sizeof(_lastValidPacket));
  // 注意：不重置TinyGPS++实例，因为它可能包含有用的状态
}

// 便捷方法
bool CasicGpsWrapper::hasNewAck() {
  return _newCasicData && _lastValidPacket.class_id == CASIC_CLASS_ACK &&
         _lastValidPacket.msg_id == CASIC_ID_ACK;
}

bool CasicGpsWrapper::hasNewNack() {
  return _newCasicData && _lastValidPacket.class_id == CASIC_CLASS_NACK &&
         _lastValidPacket.msg_id == CASIC_ID_NACK;
}

bool CasicGpsWrapper::hasNewEphemeris() {
  return _newCasicData && _lastValidPacket.class_id == CASIC_CLASS_MSG &&
         (_lastValidPacket.msg_id == CASIC_ID_MSG_GPSEPH ||
          _lastValidPacket.msg_id == CASIC_ID_MSG_BDSEPH);
}
