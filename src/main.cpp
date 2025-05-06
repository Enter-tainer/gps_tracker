#include "Adafruit_TinyUSB.h" // Keep for Serial
#include "battery.h"          // Include battery functions
#include "button_handler.h"
#include "config.h"
#include "display_handler.h"
#include "gps_handler.h"
#include "littlefs_handler.h" // Include Internal Flash handler
#include "logger.h"           // Include Logger
#include "system_info.h"      // Include system info
#include <Arduino.h>
#include <Wire.h> // Keep for Wire.begin()

// Define the global SystemInfo instance
SystemInfo gSystemInfo;

const unsigned long BATTERY_UPDATE_INTERVAL_MS = 10000;

SoftwareTimer batteryCheckTimer;   // Timer for battery check
void setup() {
  // Initialize Serial communication (for debugging)
  // Serial.begin(115200); // Keep this for initial boot messages if necessary,
  // or remove if Log handles all
  Log.begin(); // Initialize our logger

  Log.println("Starting GPS Tracker...");

  // Initialize Internal Flash first
  if (!initInternalFlash()) { // Call renamed function
    Log.println(
        "CRITICAL: Internal Flash initialization failed. Logging disabled.");
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

  initInternalFlash();

  // No initial GPS message here, handleGPS will manage it.
  Log.println("Setup Complete. Entering loop.");
  updateBatteryInfo(NULL); // Initial battery check
  batteryCheckTimer.begin(BATTERY_UPDATE_INTERVAL_MS, updateBatteryInfo, NULL,
                          true); // Start the timer for battery check
  batteryCheckTimer.start();     // Start the timer
}

void loop() {
  handleGPS(); // Call GPS handler (updates gSystemInfo)
  delay(50);
}
