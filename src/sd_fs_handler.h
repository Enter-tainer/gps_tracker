#ifndef SD_FS_HANDLER_H
#define SD_FS_HANDLER_H

#include "SdFat.h"
#include <stdint.h>

// Unified SD card file system handler
// Provides consistent SdFat access across the entire codebase

// Global SdFat instance
extern SdFat sd;

// Initialize SD card file system
bool initSDFileSystem();

// Directory operations
bool listDirectory(const char *path);
bool createDirectory(const char *path);
bool removeDirectory(const char *path);

// File operations
bool fileExists(const char *path);
uint32_t getFileSize(const char *path);
bool deleteFile(const char *path);
bool renameFile(const char *oldPath, const char *newPath);

// File reading/writing
bool readFile(const char *path, uint8_t *buffer, uint32_t offset, uint32_t size);
bool writeFile(const char *path, const uint8_t *data, uint32_t size, bool append = false);

// Utility functions
void getFreeSpace(uint64_t *freeBytes, uint64_t *totalBytes);
void formatSDCard();

#endif // SD_FS_HANDLER_H