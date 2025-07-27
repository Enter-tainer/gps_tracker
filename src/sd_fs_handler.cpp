#include "sd_fs_handler.h"
#include "logger.h"
#include "config.h"
#include <SdFat.h>

// Global SdFat instance
SdFat sd;

// Initialize SD card file system
bool initSDFileSystem() {
    Log.println("Initializing SD card file system...");
    
    // Initialize SPI
    SPI.begin();
    
    // Initialize SD card
    if (!sd.begin(LORA_CS, 100000)) {
        Log.println("SD card initialization failed!");
        return false;
    }
    
    Log.println("SD card file system initialized successfully");
    return true;
}

// Directory operations
bool listDirectory(const char *path) {
    SdFile dir;
    if (!dir.open(path, O_READ)) {
        Log.printf("Failed to open directory: %s\n", path);
        return false;
    }
    
    Log.printf("Directory listing: %s\n", path);
    SdFile file;
    int count = 0;
    
    while (file.openNext(&dir, O_READ)) {
        char filename[64];
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
    
    dir.close();
    return true;
}

bool createDirectory(const char *path) {
    if (sd.mkdir(path)) {
        Log.printf("Directory created: %s\n", path);
        return true;
    } else {
        Log.printf("Failed to create directory: %s\n", path);
        return false;
    }
}

bool removeDirectory(const char *path) {
    if (sd.rmdir(path)) {
        Log.printf("Directory removed: %s\n", path);
        return true;
    } else {
        Log.printf("Failed to remove directory: %s\n", path);
        return false;
    }
}

// File operations
bool fileExists(const char *path) {
    SdFile file;
    bool exists = file.open(path, O_READ);
    if (exists) {
        file.close();
    }
    return exists;
}

uint32_t getFileSize(const char *path) {
    SdFile file;
    if (!file.open(path, O_READ)) {
        return 0;
    }
    uint32_t size = file.fileSize();
    file.close();
    return size;
}

bool deleteFile(const char *path) {
    if (sd.remove(path)) {
        Log.printf("File deleted: %s\n", path);
        return true;
    } else {
        Log.printf("Failed to delete file: %s\n", path);
        return false;
    }
}

bool renameFile(const char *oldPath, const char *newPath) {
    if (sd.rename(oldPath, newPath)) {
        Log.printf("File renamed: %s -> %s\n", oldPath, newPath);
        return true;
    } else {
        Log.printf("Failed to rename file: %s -> %s\n", oldPath, newPath);
        return false;
    }
}

// File reading/writing
bool readFile(const char *path, uint8_t *buffer, uint32_t offset, uint32_t size) {
    SdFile file;
    if (!file.open(path, O_READ)) {
        Log.printf("Failed to open file for reading: %s\n", path);
        return false;
    }
    
    if (!file.seekSet(offset)) {
        Log.printf("Failed to seek to offset %lu in file: %s\n", offset, path);
        file.close();
        return false;
    }
    
    int bytesRead = file.read(buffer, size);
    file.close();
    
    if (bytesRead != (int)size) {
        Log.printf("Failed to read %lu bytes from file: %s\n", size, path);
        return false;
    }
    
    return true;
}

bool writeFile(const char *path, const uint8_t *data, uint32_t size, bool append) {
    SdFile file;
    uint8_t mode = O_RDWR | O_CREAT;
    if (append) {
        mode |= O_APPEND;
    } else {
        mode |= O_TRUNC;
    }
    
    if (!file.open(path, mode)) {
        Log.printf("Failed to open file for writing: %s\n", path);
        return false;
    }
    
    int bytesWritten = file.write(data, size);
    file.close();
    
    if (bytesWritten != (int)size) {
        Log.printf("Failed to write %lu bytes to file: %s\n", size, path);
        return false;
    }
    
    return true;
}

// Utility functions
void getFreeSpace(uint64_t *freeBytes, uint64_t *totalBytes) {
    uint64_t freeClusters;
    uint32_t clusterSize;
    
    if (sd.card()->type() != 0) {
        *totalBytes = (uint64_t)sd.card()->sectorCount() * 512ULL;
        freeClusters = sd.vol()->freeClusterCount();
        clusterSize = sd.vol()->sectorsPerCluster() * 512;
        *freeBytes = freeClusters * clusterSize;
    } else {
        *freeBytes = 0;
        *totalBytes = 0;
    }
}

void formatSDCard() {
    Log.println("Formatting SD card...");
    if (sd.format()) {
        Log.println("SD card formatted successfully");
    } else {
        Log.println("Failed to format SD card");
    }
}