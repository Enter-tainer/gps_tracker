#include "Adafruit_TinyUSB.h" // Keep for Serial
#include "battery.h"          // Include battery functions
#include "button_handler.h"
#include "config.h"
#include "display_handler.h"
#include "gps_handler.h"
#include "system_info.h" // Include system info
#include <Arduino.h>
#include <Wire.h> // Keep for Wire.begin()

// Define the global SystemInfo instance
SystemInfo gSystemInfo;

// Display update timing
unsigned long lastDisplayUpdateTime = 0;
const unsigned long DISPLAY_UPDATE_INTERVAL_MS =
    33; // Update display every 1 second

void setup() {
  // Initialize Serial communication (for debugging)
  Serial.begin(115200);
  // while (!Serial); // Optional: Wait for Serial connection

  Serial.println("Starting GPS Tracker...");

  // Initialize I2C (needed for SSD1306)
  Wire.begin();

  // Initialize Display
  if (initDisplay()) {
    // Display initialized successfully
    // String bootMessage[] = {"GPS Tracker", "Initializing..."}; // Removed
    // displayInfo(bootMessage, 1); // Removed - updateDisplay will handle it
    updateDisplay(); // Show initial empty/default state from gSystemInfo
    lastDisplayUpdateTime = millis(); // Set initial time
  } else {
    // Handle display initialization failure (e.g., continue without display)
    Serial.println("Display Init Failed!");
  }

  // Initialize GPS (will start in OFF state and update gSystemInfo)
  initGPS();

  // Initialize Button
  initButton();

  // Initialize Battery (if needed)
  initBattery();

  // No initial GPS message here, handleGPS will manage it.
  Serial.println("Setup Complete. Entering loop.");
}

void loop() {
  unsigned long now = millis();

  handleGPS();    // Call GPS handler (updates gSystemInfo)
  handleButton(); // Call Button handler (could potentially update gSystemInfo
                  // in the future)
  handleBattery();

  // Periodically update the display from gSystemInfo
  if (now - lastDisplayUpdateTime >= DISPLAY_UPDATE_INTERVAL_MS) {
    updateDisplay();
    lastDisplayUpdateTime = now;
  }

  // The loop runs as fast as possible.
  // handleGPS and handleButton are designed to be non-blocking.
  // Power saving is achieved by turning the GPS module off in handleGPS.
  // Display updates are now throttled.
}
