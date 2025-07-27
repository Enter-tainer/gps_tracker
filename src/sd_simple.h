#ifndef SD_SIMPLE_H
#define SD_SIMPLE_H

#include <Arduino.h>
#include <SPI.h>
#include <SdFat.h>
#include "sd_fs_handler.h"

// 简单的SD卡功能
namespace SDSimple {
    bool initSD();
    void listRootFiles();
    bool readFile(const char* filename);
}

#endif