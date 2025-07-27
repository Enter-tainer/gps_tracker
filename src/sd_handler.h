#ifndef SD_HANDLER_H
#define SD_HANDLER_H

#include "gpx_logger.h" // Include for GpxPointInternal definition
#include <cstdint>

// 初始化 SD 卡用于 GPS 日志记录
bool initSDForGPSLogging();

// 将准备好的 GpxPointInternal (二进制结构) 写入当天的日志文件
// 写入前会检查日期变化和管理旧文件
bool writeGpsLogDataToSD(const GpxPointInternal &entry);

// 检查日期变化并轮换日志文件
bool RotateSDLogFileIfNeeded(uint32_t timestamp);

// 列出 SD 卡根目录内容
void listSDRootContents();

// 管理旧日志文件
void manageOldSDFiles();

// 立即将缓存数据写入SD卡
bool flushCacheToSD();

// 获取缓存使用情况
std::size_t getCacheUsage();

#endif // SD_HANDLER_H
