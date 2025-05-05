#ifndef LITTLEFS_HANDLER_H
#define LITTLEFS_HANDLER_H

#include "gpx_logger.h" // Include for GpxPointInternal definition
#include <stdint.h>

// 初始化 Internal Flash 文件系统
bool initInternalFlash();

// 将准备好的 GpxPointInternal (二进制结构) 写入当天的日志文件
// 写入前会检查日期变化和管理旧文件
bool writeGpsLogData(const GpxPointInternal &entry);

void RotateLogFileIfNeeded();

void listInternalFlashContents();

#endif // LITTLEFS_HANDLER_H
