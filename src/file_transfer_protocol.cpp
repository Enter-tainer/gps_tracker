#include "file_transfer_protocol.h"
#include "gps_handler.h"
#include "logger.h"
#include "system_info.h"

FileTransferProtocol::FileTransferProtocol(Stream *stream)
    : _stream(stream), _fileOpened(false), _dirOpen(false),
      _listingInProgress(false), _cmdState(WAIT_CMD_ID), _bytesRead(0),
      _agnssWriteInProgress(false) {
  memset(_currentPath, 0, MAX_PATH_LENGTH);
}

void FileTransferProtocol::start() {
  Log.println("文件传输协议启动");
  resetState();
}

void FileTransferProtocol::resetState() {
  _cmdState = WAIT_CMD_ID;
  _bytesRead = 0;
  _payloadLength = 0;
  memset(_buffer, 0, sizeof(_buffer));
}

bool FileTransferProtocol::readCommandHeader() {
  while (_stream->available()) {
    uint8_t byte = _stream->read();

    switch (_cmdState) {
    case WAIT_CMD_ID:
      _cmdId = byte;
      _cmdState = WAIT_PAYLOAD_LEN_LSB;
      break;

    case WAIT_PAYLOAD_LEN_LSB:
      _payloadLength = byte;
      _cmdState = WAIT_PAYLOAD_LEN_MSB;
      break;

    case WAIT_PAYLOAD_LEN_MSB:
      _payloadLength |= (byte << 8);

      if (_payloadLength > sizeof(_buffer)) {
        Log.printf("错误：载荷长度 %d 超过缓冲区大小 %d\n", (int)_payloadLength,
                   sizeof(_buffer));
        resetState();
        return false;
      }

      if (_payloadLength == 0) {
        _cmdState = PROCESS_COMMAND;
        return true;
      } else {
        _cmdState = WAIT_PAYLOAD;
        _bytesRead = 0;
      }
      break;

    default:
      resetState();
      return false;
    }

    // 已完成头部读取
    if (_cmdState == WAIT_PAYLOAD || _cmdState == PROCESS_COMMAND) {
      return true;
    }
  }

  return false;
}

bool FileTransferProtocol::readPayload() {
  while (_stream->available() && _bytesRead < _payloadLength) {
    _buffer[_bytesRead++] = _stream->read();
  }

  if (_bytesRead == _payloadLength) {
    _cmdState = PROCESS_COMMAND;
    return true;
  }

  return false;
}

void FileTransferProtocol::sendResponse(uint8_t *payload, uint16_t length) {
  // write to buffer first
  if (length > sizeof(_buffer)) {
    Log.printf("错误：响应长度 %d 超过缓冲区大小 %d\n", (int)length,
               sizeof(_buffer));
    return;
  }
  // 发送载荷长度 (小端序)
  _buffer[0] = length & 0xFF;
  _buffer[1] = (length >> 8) & 0xFF;
  // 发送载荷数据
  if (length > 0 && payload != nullptr) {
    memcpy(&_buffer[2], payload, length);
  }
  // 发送 buffer
  _stream->write(_buffer, length + 2); // 2 bytes for length
  _stream->flush();                    // 确保数据已发送
}

void FileTransferProtocol::process() {
  // 尝试读取命令头
  if (_cmdState == WAIT_CMD_ID || _cmdState == WAIT_PAYLOAD_LEN_LSB ||
      _cmdState == WAIT_PAYLOAD_LEN_MSB) {
    if (!readCommandHeader()) {
      return; // 等待更多数据
    }
  }

  // 如果需要读取载荷数据
  if (_cmdState == WAIT_PAYLOAD) {
    if (!readPayload()) {
      return; // 等待更多数据
    }
  }

  // 处理命令
  if (_cmdState == PROCESS_COMMAND) {
    switch (_cmdId) {
    case CMD_LIST_DIR:
      processListDir();
      break;

    case CMD_OPEN_FILE:
      processOpenFile();
      break;

    case CMD_READ_CHUNK:
      processReadChunk();
      break;

    case CMD_CLOSE_FILE:
      processCloseFile();
      break;
    case CMD_DELETE_FILE:
      processDeleteFile();
      break;
    case 0x06: // CMD_GET_SYS_INFO
      processGetSysInfo();
      break;
    case CMD_START_AGNSS_WRITE:
      processStartAgnssWrite();
      break;
    case CMD_WRITE_AGNSS_CHUNK:
      processWriteAgnssChunk();
      break;
    case CMD_END_AGNSS_WRITE:
      processEndAgnssWrite();
      break;

    default:
      Log.printf("未知命令ID: 0x%02X\n", _cmdId);
      // 发送空响应表示错误
      sendResponse(nullptr, 0);
      break;
    }

    // 重置状态，准备接收下一个命令
    resetState();
  }
}

void FileTransferProtocol::processListDir() {
  uint8_t responseBuffer[128];
  uint16_t responseLength = 0;

  // 首次列目录或继续上次列目录
  if (!_listingInProgress) {
    // 这是新的LIST_DIR命令
    uint8_t pathLength = _buffer[0];

    // 释放之前可能打开的目录
    if (_dirOpen) {
      _currentDirectory.close();
      _dirOpen = false;
    }

    // 复制请求路径
    memset(_currentPath, 0, MAX_PATH_LENGTH);
    if (pathLength > 0) {
      memcpy(_currentPath, &_buffer[1], min(pathLength, MAX_PATH_LENGTH - 1));
    } else {
      // 默认为根目录
      strcpy(_currentPath, "/");
    }

    Log.printf("列目录请求: %s\n", _currentPath);

    // 打开目录
    _currentDirectory = InternalFS.open(_currentPath);
    if (!_currentDirectory || !_currentDirectory.isDirectory()) {
      Log.println("无法打开目录");
      sendResponse(nullptr, 0);
      return;
    }

    _dirOpen = true;
    _listingInProgress = true;
  }

  // 读取下一个目录项
  File entry = _currentDirectory.openNextFile();

  if (!entry) {
    // 没有更多条目，发送完成响应
    responseBuffer[responseLength++] = 0x00; // More Flag = 0
    _listingInProgress = false;
    _dirOpen = false;
    _currentDirectory.close();
  } else {
    responseBuffer[responseLength++] = 0x01; // More Flag = 1 (还有更多)

    // 设置条目类型
    responseBuffer[responseLength++] =
        entry.isDirectory() ? ENTRY_TYPE_DIRECTORY : ENTRY_TYPE_FILE;

    // 获取名称并设置名称长度
    const char *name = entry.name();
    uint8_t nameLength = strlen(name);
    Log.printf("目录项: %s, 长度: %d\n", name, (int)nameLength);
    responseBuffer[responseLength++] = nameLength;

    // 复制名称
    memcpy(&responseBuffer[responseLength], name, nameLength);
    responseLength += nameLength;

    // 如果是文件，添加文件大小
    if (!entry.isDirectory()) {
      uint32_t size = entry.size();
      memcpy(&responseBuffer[responseLength], &size, 4); // 小端序
      responseLength += 4;
    }

    entry.close();
  }

  sendResponse(responseBuffer, responseLength);
}

void FileTransferProtocol::processOpenFile() {
  uint8_t responseBuffer[4]; // 仅用于文件大小
  uint16_t responseLength = 0;

  // 检查是否已有打开的文件
  if (_fileOpened) {
    _currentOpenFile.close();
    _fileOpened = false;
  }

  // 解析路径
  uint8_t pathLength = _buffer[0];
  if (pathLength >= MAX_PATH_LENGTH) {
    Log.println("文件路径太长");
    sendResponse(nullptr, 0);
    return;
  }

  char filePath[MAX_PATH_LENGTH];
  memset(filePath, 0, MAX_PATH_LENGTH);
  memcpy(filePath, &_buffer[1], pathLength);

  Log.printf("打开文件请求: %s\n", filePath);

  // 打开文件
  _currentOpenFile = InternalFS.open(filePath, FILE_O_READ);
  if (!_currentOpenFile) {
    Log.printf("无法打开文件: %s\n", filePath);
    sendResponse(nullptr, 0);
    return;
  }

  _fileOpened = true;

  // 获取文件大小
  uint32_t fileSize = _currentOpenFile.size();
  memcpy(responseBuffer, &fileSize, 4); // 小端序
  responseLength = 4;

  sendResponse(responseBuffer, responseLength);
}

void FileTransferProtocol::processReadChunk() {
  uint8_t responseBuffer[256]; // 假设最大响应大小为 256 字节
  uint16_t actualBytesRead = 0;

  // 在响应缓冲区前两个字节预留给"Actual Bytes Read"
  uint16_t dataOffset = 2;

  if (!_fileOpened) {
    Log.println("尝试读取未打开的文件");
    responseBuffer[0] = 0;
    responseBuffer[1] = 0;
    sendResponse(responseBuffer, 2);
    return;
  }

  // 解析offset和bytesToRead
  uint32_t offset;
  uint16_t bytesToRead;

  memcpy(&offset, &_buffer[0], 4);
  memcpy(&bytesToRead, &_buffer[4], 2);

  Log.printf("读取文件块请求: offset=%lu, bytesToRead=%u\n", offset,
             bytesToRead);

  // 限制读取大小，确保不超过缓冲区
  bytesToRead =
      min(bytesToRead, (uint16_t)(sizeof(responseBuffer) - dataOffset));

  // 设置文件位置
  if (!_currentOpenFile.seek(offset)) {
    Log.println("seek操作失败");
    responseBuffer[0] = 0;
    responseBuffer[1] = 0;
    sendResponse(responseBuffer, 2);
    return;
  }

  // 读取数据
  actualBytesRead =
      _currentOpenFile.read(&responseBuffer[dataOffset], bytesToRead);

  // 在响应开头写入实际读取的字节数
  responseBuffer[0] = actualBytesRead & 0xFF;
  responseBuffer[1] = (actualBytesRead >> 8) & 0xFF;

  // 发送响应
  sendResponse(responseBuffer, actualBytesRead + dataOffset);
}

void FileTransferProtocol::processCloseFile() {
  if (_fileOpened) {
    _currentOpenFile.close();
    _fileOpened = false;
    Log.println("文件已关闭");
  } else {
    Log.println("尝试关闭未打开的文件");
  }

  // 无论如何都发送成功响应
  sendResponse(nullptr, 0);
}

void FileTransferProtocol::processDeleteFile() {
  // 检查是否有打开的文件，不能删除正在打开的文件
  if (_fileOpened) {
    Log.println("有文件正在打开，无法删除");
    sendResponse(nullptr, 0);
    return;
  }
  // 解析路径
  if (_payloadLength < 1) {
    Log.println("删除文件命令载荷长度无效");
    sendResponse(nullptr, 0);
    return;
  }
  uint8_t pathLength = _buffer[0];
  if (pathLength == 0 || pathLength >= MAX_PATH_LENGTH) {
    Log.println("删除文件路径长度无效");
    sendResponse(nullptr, 0);
    return;
  }
  char filePath[MAX_PATH_LENGTH];
  memset(filePath, 0, MAX_PATH_LENGTH);
  memcpy(filePath, &_buffer[1], pathLength);
  filePath[pathLength] = '\0';
  Log.printf("删除文件请求: %s\n", filePath);
  // 检查文件是否存在且不是目录
  File f = InternalFS.open(filePath);
  if (!f) {
    Log.println("文件不存在");
    sendResponse(nullptr, 0);
    return;
  }
  if (f.isDirectory()) {
    Log.println("不能删除目录");
    f.close();
    sendResponse(nullptr, 0);
    return;
  }
  f.close();
  // 删除文件
  bool ok = InternalFS.remove(filePath);
  if (ok) {
    Log.println("文件删除成功");
  } else {
    Log.println("文件删除失败");
  }
  sendResponse(nullptr, 0);
}

void FileTransferProtocol::processGetSysInfo() {
  uint8_t responseBuffer[64]; // 足够容纳所有字段
  uint16_t offset = 0;
  // 按协议顺序打包 SystemInfo
  // double latitude
  memcpy(&responseBuffer[offset], &gSystemInfo.latitude, 8);
  offset += 8;
  // double longitude
  memcpy(&responseBuffer[offset], &gSystemInfo.longitude, 8);
  offset += 8;
  // float altitude
  memcpy(&responseBuffer[offset], &gSystemInfo.altitude, 4);
  offset += 4;
  // uint32_t satellites
  memcpy(&responseBuffer[offset], &gSystemInfo.satellites, 4);
  offset += 4;
  // float hdop
  memcpy(&responseBuffer[offset], &gSystemInfo.hdop, 4);
  offset += 4;
  // float speed
  memcpy(&responseBuffer[offset], &gSystemInfo.speed, 4);
  offset += 4;
  // float course
  memcpy(&responseBuffer[offset], &gSystemInfo.course, 4);
  offset += 4;
  // uint16_t year
  memcpy(&responseBuffer[offset], &gSystemInfo.year, 2);
  offset += 2;
  // uint8_t month
  responseBuffer[offset++] = gSystemInfo.month;
  // uint8_t day
  responseBuffer[offset++] = gSystemInfo.day;
  // uint8_t hour
  responseBuffer[offset++] = gSystemInfo.hour;
  // uint8_t minute
  responseBuffer[offset++] = gSystemInfo.minute;
  // uint8_t second
  responseBuffer[offset++] = gSystemInfo.second;
  // uint8_t locationValid
  responseBuffer[offset++] = gSystemInfo.locationValid ? 1 : 0;
  // uint8_t dateTimeValid
  responseBuffer[offset++] = gSystemInfo.dateTimeValid ? 1 : 0;
  // float batteryVoltage
  memcpy(&responseBuffer[offset], &gSystemInfo.batteryVoltage, 4);
  offset += 4;
  // uint8_t gpsState
  responseBuffer[offset++] = (uint8_t)gSystemInfo.gpsState;

  sendResponse(responseBuffer, offset);
}

void FileTransferProtocol::processStartAgnssWrite() {
  // 开始 AGNSS 数据写入传输
  _agnssMessages.clear(); // 清空之前的数据
  _agnssWriteInProgress = true;

  Log.println("开始 AGNSS 数据写入");

  // 发送空响应表示准备就绪
  sendResponse(nullptr, 0);
}

void FileTransferProtocol::processWriteAgnssChunk() {
  if (!_agnssWriteInProgress) {
    Log.println("错误：AGNSS 写入未开始");
    sendResponse(nullptr, 0);
    return;
  }

  // 解析数据块大小
  if (_payloadLength < 2) {
    Log.println("错误：AGNSS 数据块载荷长度无效");
    sendResponse(nullptr, 0);
    return;
  }

  uint16_t chunkSize;
  memcpy(&chunkSize, &_buffer[0], 2); // 小端序

  if (chunkSize == 0 || chunkSize > _payloadLength - 2) {
    Log.printf("错误：AGNSS 数据块大小无效 %d\n", chunkSize);
    sendResponse(nullptr, 0);
    return;
  }

  // 创建新的消息向量并复制数据
  std::vector<uint8_t> message;
  message.resize(chunkSize);
  memcpy(message.data(), &_buffer[2], chunkSize);

  // 将消息添加到队列中
  _agnssMessages.push_back(message);

  Log.printf("接收 AGNSS 数据块，大小: %d，总块数: %d\n", chunkSize,
             (int)_agnssMessages.size());

  // 发送空响应表示接收成功
  sendResponse(nullptr, 0);
}

void FileTransferProtocol::processEndAgnssWrite() {
  if (!_agnssWriteInProgress) {
    Log.println("错误：AGNSS 写入未开始");
    sendResponse(nullptr, 0);
    return;
  }

  _agnssWriteInProgress = false;

  Log.printf("结束 AGNSS 数据写入，共接收 %d 个数据块\n",
             (int)_agnssMessages.size());

  // 将 AGNSS 消息队列设置到 GPS 处理器
  if (!_agnssMessages.empty()) {
    setAgnssMessageQueue(_agnssMessages);
    Log.println("AGNSS 数据已发送到 GPS 处理器");
  } else {
    Log.println("警告：没有接收到 AGNSS 数据");
  }

  // 清空消息队列
  _agnssMessages.clear();

  // 发送空响应表示完成
  sendResponse(nullptr, 0);
}
