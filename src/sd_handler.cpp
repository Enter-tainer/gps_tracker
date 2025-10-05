#include "sd_handler.h"
#include "config.h" // Include for MAX_GPX_FILES
#include "gpx_logger.h"
#include "logger.h"
#include "sd_fs_handler.h" // Use unified SD file system handler
#include <Arduino.h>
#include <SdFat.h>
#include <TimeLib.h> // Include for time functions (year, month, day)
#include <algorithm> // For std::sort
#include <cstdio>    // For sprintf
#include <string>    // Using std::string for sorting
#include <vector>    // Using vector for easier list management

// Global SdFat instance from sd_simple.cpp
extern SdFat sd;

// Global variables to keep track of the current file
static SdFile currentGpxFile;
static String currentFilename = "";
static uint32_t currentFileDate = 0; // Store date as YYYYMMDD for comparison
static bool isFileOpen = false;

static GpsDataEncoder gpsDataEncoder(64);

// 4KB缓存相关变量
static uint8_t writeCache[4096];
static size_t cachePosition = 0;
static bool cacheDirty = false;

// Helper function to manage old log files - keeps total file size below MAX_FILE_SIZE
void manageOldSDFiles() {
    std::vector<String> gpxFiles;
    
    SdFile root;
    if (!root.open("/")) {
        Log.println("Failed to open root directory for cleanup");
        return;
    }

    SdFile file;
    while (file.openNext(&root, O_READ)) {
        char filename[32];
        file.getName(filename, sizeof(filename));
        
        String name = String(filename);
        if (name.endsWith(".gpx")) {
            gpxFiles.push_back(name);
        }
        file.close();
    }
    root.close();

    // Sort files alphabetically (which is chronologically for YYYYMMDD format)
    std::sort(gpxFiles.begin(), gpxFiles.end());

    // Calculate total file size
    uint32_t totalFileSize = 0;
    std::vector<std::pair<String, uint32_t>> fileDetails;

    for (const auto &filename : gpxFiles) {
        SdFile file;
        if (file.open(filename.c_str(), O_READ)) {
            uint32_t fileSize = file.fileSize();
            totalFileSize += fileSize;
            fileDetails.push_back(std::make_pair(filename, fileSize));
            file.close();
        }
    }

    // Check if we need to delete files
    Log.printf("Total GPX file size: %lu bytes, MAX_FILE_SIZE: %lu bytes\n",
               totalFileSize, (uint32_t)MAX_FILE_SIZE);

    if (totalFileSize > MAX_FILE_SIZE) {
        // Delete oldest files until we get below the limit
        for (size_t i = 0; i < fileDetails.size(); ++i) {
            Log.printf("Deleting old log file: %s (%lu bytes)\n",
                       fileDetails[i].first.c_str(), fileDetails[i].second);

            if (!sd.remove(fileDetails[i].first.c_str())) {
                Log.printf("Failed to delete %s\n", fileDetails[i].first.c_str());
                // Continue trying to delete others even if one fails
            } else {
                totalFileSize -= fileDetails[i].second;
                Log.printf("Remaining file size: %lu bytes\n", totalFileSize);

                // Check if we're below the threshold now
                if (totalFileSize <= MAX_FILE_SIZE) {
                    Log.println("Successfully cleaned up to target size");
                    break;
                }
            }
        }
    }
}

// Function to check if the date has changed and rotate log file if needed
// Also handles opening the file initially or after an error
bool RotateSDLogFileIfNeeded(uint32_t timestamp) {
    // Extract date components from the timestamp
    int y = year(timestamp);
    int m = month(timestamp);
    int d = day(timestamp);

    // Create the date integer YYYYMMDD for comparison
    uint32_t newDate = y * 10000 + m * 100 + d;

    // Check if the date has changed or if no file is currently open
    if (newDate != currentFileDate || !isFileOpen) {
      // 文件切换前，先flush缓存中的数据
      if (isFileOpen) {
        flushCacheToSD();       // 确保缓存数据写入当前文件
        currentGpxFile.close(); // Close the previous day's file
        isFileOpen = false;     // Mark as closed
        Log.printf("Closed log file: %s\n", currentFilename.c_str());
      }

        // Format the new filename: YYYYMMDD.gpx
        char filenameBuffer[14]; // "YYYYMMDD.gpx" + null terminator
        sprintf(filenameBuffer, "%04d%02d%02d.gpx", y, m, d);
        currentFilename = String(filenameBuffer);
        currentFileDate = newDate; // Update the current date

        Log.printf("Switching to log file: %s\n", currentFilename.c_str());

        // Manage old files before opening the new one
        manageOldSDFiles();

        // Open the new file in write mode (append/create)
        if (!currentGpxFile.open(currentFilename.c_str(), O_CREAT | O_WRITE | O_APPEND)) {
            Log.printf("Failed to open log file: %s\n", currentFilename.c_str());
            currentFilename = ""; // Reset filename if open failed
            currentFileDate = 0;  // Reset date
            isFileOpen = false;   // Ensure marked as not open
            return false;         // Indicate failure
        } else {
            // Open succeeded
            isFileOpen = true; // Mark as open
            gpsDataEncoder.clear();
            Log.printf("Successfully opened log file: %s\n", currentFilename.c_str());
        }
    }

    // Return true if the file is marked as open
    return isFileOpen;
}

// Initialize SD card for GPS logging
bool initSDForGPSLogging() {
    Log.println("Initializing SD card for GPS logging...");
    
    // Use unified SD file system (already initialized in main.cpp)
    // Just perform cleanup and reset state
    manageOldSDFiles();
    
    // Reset state on initialization
    currentFilename = "";
    currentFileDate = 0;
    isFileOpen = false;
    
    Log.println("SD card ready for GPS logging");
    return true;
}

// 立即将缓存数据写入SD卡
bool flushCacheToSD() {
  if (!cacheDirty || cachePosition == 0) {
    return true; // 没有数据需要写入
  }

  if (!isFileOpen) {
    Log.println("Cannot flush cache: No file open");
    return false;
  }

  // 写入缓存数据
  size_t bytesWritten = currentGpxFile.write(writeCache, cachePosition);

  if (bytesWritten != cachePosition) {
    Log.printf("Failed to flush cache to %s. Expected %d, wrote %d\n",
               currentFilename.c_str(), (int)cachePosition, (int)bytesWritten);
    return false;
  }

  // 确保数据写入物理存储
  currentGpxFile.sync();

  Log.printf("Flushed %d bytes to SD card\n", (int)cachePosition);

  // 重置缓存
  cachePosition = 0;
  cacheDirty = false;

  return true;
}

// 获取缓存使用情况
std::size_t getCacheUsage() { return cachePosition; }

// Write GPS log data to the current daily file
bool writeGpsLogDataToSD(const GpxPointInternal &entry) {
    // Ensure the correct file is open for the entry's timestamp
    if (!RotateSDLogFileIfNeeded(entry.timestamp)) {
        Log.println("Cannot write GPS data: Log file not ready");
        return false;
    }
    // 先保存编码器与缓存状态，便于写入失败时回滚
    const auto encoder_snapshot = gpsDataEncoder;
    const auto cache_position_snapshot = cachePosition;
    const auto cache_dirty_snapshot = cacheDirty;

    const auto len = gpsDataEncoder.encode(entry);

    // 检查是否有足够空间在缓存中
    if (cachePosition + len > sizeof(writeCache)) {
      // 缓存已满，先flush
      if (!flushCacheToSD()) {
        gpsDataEncoder = encoder_snapshot;
        cachePosition = cache_position_snapshot;
        cacheDirty = cache_dirty_snapshot;
        Log.println("Failed to flush cache before writing new data");
        return false;
      }
    }

    // 将数据写入缓存
    memcpy(writeCache + cachePosition, gpsDataEncoder.getBuffer(), len);
    cachePosition += len;
    cacheDirty = true;

    // 如果缓存已满，立即写入
    if (cachePosition >= sizeof(writeCache)) {
      if (!flushCacheToSD()) {
        gpsDataEncoder = encoder_snapshot;
        cachePosition = cache_position_snapshot;
        cacheDirty = cache_dirty_snapshot;
        Log.println("Failed to flush cache after writing new data");
        return false;
      }
    }

    return true;
}

// List SD card root directory contents
void listSDRootContents() {
    Log.println("--- Listing SD Card Root Contents ---");
    
    SdFile root;
    if (!root.open("/")) {
        Log.println("Failed to open root directory");
        return;
    }

    SdFile file;
    int count = 0;
    
    while (file.openNext(&root, O_READ)) {
        char filename[32];
        file.getName(filename, sizeof(filename));
        
        if (file.isDir()) {
            Log.printf("  DIR : %s\n", filename);
        } else {
            Log.printf("  FILE: %s\tSIZE: %d bytes\n", filename, file.fileSize());
        }
        
        file.close();
        count++;
    }
    
    if (count == 0) {
        Log.println("  Directory is empty");
    }
    
    root.close();
    Log.println("-----------------------------------");
}
