#include "Adafruit_LittleFS.h"
#include "Adafruit_TinyUSB.h" // Keep for Serial
#include "InternalFileSystem.h" // Make sure this is the correct header for InternalFS
#include "accel_analyzer.h"     // Include the AccelAnalyzer header
#include "accel_handler.h"
#include "battery.h" // Include battery functions
#include "ble_handler.h"
#include "bmp280_handler.h"
#include "button_handler.h"
#include "config.h"
#include "display_handler.h"
#include "gps_handler.h"
#include "littlefs_handler.h" // Include Internal Flash handler
#include "logger.h"           // Include Logger
#include "sd_fs_handler.h"    // Unified SD card file system
#include "sd_handler.h"       // SD card GPS logging
#include "system_info.h"      // Include system info
#include <Arduino.h>
#include <LIS3DHTR.h>
#include <Wire.h> // Keep for Wire.begin()

// Define the global SystemInfo instance
SystemInfo gSystemInfo;

// 在全局作用域添加分析器实例
AccelAnalyzer accelAnalyzer(256, 0.1f, 2.0f);
// 256 samples, thresholds 0.1g and 2.0g

const unsigned long BATTERY_UPDATE_INTERVAL_MS = 1000;

SoftwareTimer batteryCheckTimer; // Timer for battery check

void setup() {
  // Initialize Serial communication (for debugging)
  // Serial.begin(115200); // Keep this for initial boot messages if necessary,
  // or remove if Log handles all
  Log.begin(); // Initialize our logger
  delay(1000); // Wait for Serial to initialize
  Log.println("Starting GPS Tracker...");

  // Initialize SD card file system for all operations
  if (!initSDFileSystem()) {
    Log.println(
        "CRITICAL: SD card initialization failed. GPS logging and file transfer disabled.");
    // Handle error appropriately
  }

  // Initialize I2C (needed for SSD1306)
  Wire.begin();

  // Initialize Display
  if (initDisplay()) {
    Log.println("Display Initialized Successfully.");
    updateDisplay(); // Show initial empty/default state from gSystemInfo
  } else {
    // Handle display initialization failure (e.g., continue without display)
    Log.println("Display Init Failed!");
  }

  // Initialize GPS (will start in OFF state and update gSystemInfo)
  initGPS();
  Log.println("GPS Initialized.");

  // Initialize Button
  initButton();
  Log.println("Button Handler Initialized.");

  // Initialize Battery (if needed)
  initBattery();

  // Initialize BMP280
  bmp280Handler.begin(0x76); // Common I2C addresses 0x76 or 0x77
  // bmp280Handler.start(1000); // 已移除定时器

  // 初始化 LIS3DHTR
  accelHandler.begin();
  // accelHandler.start(50); // 已移除定时器

  // Initialize Internal Flash (for other uses, not GPS logging)
  initInternalFlash();
  BleHandler::setup();

  // List SD card contents for verification
  Log.println("SD card file system initialized. Root directory:");
  // Use sd_handler's list function
  extern void listSDRootContents();
  listSDRootContents();

  // No initial GPS message here, handleGPS will manage it.
  Log.println("Setup Complete. Entering loop.");
  updateBatteryInfo(NULL); // Initial battery check
  batteryCheckTimer.begin(BATTERY_UPDATE_INTERVAL_MS, updateBatteryInfo, NULL,
                          true); // Start the timer for battery check
  batteryCheckTimer.start();     // Start the timer
}

void loop() {
  handleGPS(); // Call GPS handler (updates gSystemInfo)
  bmp280Handler.update();
  accelHandler.update();
  if (accelHandler.isOk()) {
    float total = accelHandler.getTotal();
    accelAnalyzer.addSample(total);
    if (accelAnalyzer.isStill()) {
      gSystemInfo.isStationary = true;
    } else {
      gSystemInfo.isStationary = false;
    }
    if (accelAnalyzer.hasJump()) {
      Bluefruit.Advertising.setFastTimeout(5);
      Bluefruit.Advertising.start(5);
    }
  }
  // SDSimple removed - use listSDRootContents() instead
  delay(50); // 100ms delay for loop stability
}
