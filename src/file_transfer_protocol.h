#pragma once
#include "Adafruit_LittleFS.h"
#include "InternalFileSystem.h"
#include "Stream.h"
#include <Arduino.h>

using namespace Adafruit_LittleFS_Namespace;

// 命令 ID 常量定义
#define CMD_LIST_DIR 0x01
#define CMD_OPEN_FILE 0x02
#define CMD_READ_CHUNK 0x03
#define CMD_CLOSE_FILE 0x04
#define CMD_GET_FILE_INFO 0x05

// 目录项类型
#define ENTRY_TYPE_FILE 0x00
#define ENTRY_TYPE_DIRECTORY 0x01

// 最大路径和文件名长度
#define MAX_PATH_LENGTH 64

class FileTransferProtocol {
public:
  FileTransferProtocol(Stream *stream);
  void start();
  void process(); // 处理接收到的命令

private:
  Stream *_stream;
  File _currentOpenFile{InternalFS};
  File _currentDirectory{InternalFS};
  bool _fileOpened;
  uint8_t _buffer[570]; // 命令接收缓冲区
  uint8_t _cmdId;
  uint16_t _payloadLength;
  uint8_t _cmdState;
  uint16_t _bytesRead;
  char _currentPath[MAX_PATH_LENGTH];
  bool _dirOpen;
  bool _listingInProgress;

  // 命令解析状态
  enum CommandState {
    WAIT_CMD_ID,
    WAIT_PAYLOAD_LEN_LSB,
    WAIT_PAYLOAD_LEN_MSB,
    WAIT_PAYLOAD,
    PROCESS_COMMAND
  };

  // 协议处理方法
  void processListDir();
  void processOpenFile();
  void processReadChunk();
  void processCloseFile();

  // 辅助方法
  void sendResponse(uint8_t *payload, uint16_t length);
  void resetState();
  bool readCommandHeader();
  bool readPayload();
};
