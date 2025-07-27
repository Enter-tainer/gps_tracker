#include "sd_simple.h"
#include "logger.h"

// 使用LORA_CS引脚作为SD卡CS引脚
#define SD_CS_PIN LORA_CS

// 使用全局SdFat实例
extern SdFat sd;

bool SDSimple::initSD() {
  Log.println("初始化SD卡...");

  // 初始化SPI
  SPI.begin();

  // 尝试初始化SD卡
  if (!sd.begin(SD_CS_PIN, 100000)) {
    Log.println("SD卡初始化失败!");
    return false;
  }

  Log.println("SD卡初始化成功!");
  return true;
}

void SDSimple::listRootFiles() {
  Log.println("根目录文件:");

  SdFile root;
  if (!root.open("/")) {
    Log.println("无法打开根目录");
    return;
  }

  SdFile file;
  int count = 0;

  while (file.openNext(&root, O_READ)) {
    char filename[32];
    file.getName(filename, sizeof(filename));

    if (file.isDir()) {
      Serial.printf("  DIR : %s\n", filename);
    } else {
      Serial.printf("  FILE: %s\t大小: %d 字节\n", filename, file.fileSize());
    }

    file.close();
    count++;
  }

  if (count == 0) {
    Log.println("  目录为空");
  }

  root.close();
}

bool SDSimple::readFile(const char *filename) {
  Serial.printf("读取文件: %s\n", filename);

  SdFile file;
  if (!file.open(filename, O_READ)) {
    Log.println("无法打开文件");
    return false;
  }

  Log.println("文件内容:");

  char buffer[64];
  int bytesRead;
  while ((bytesRead = file.read(buffer, sizeof(buffer))) > 0) {
    for (int i = 0; i < bytesRead; i++) {
      Serial.print(buffer[i]);
    }
  }

  Log.println("\n--- 文件结束 ---");

  file.close();
  return true;
}
