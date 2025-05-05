#include "Adafruit_TinyUSB.h" // Keep for Serial
#include "button_handler.h"
#include "config.h"
#include "display_handler.h"
#include "gps_handler.h"
#include <Arduino.h>
#include <Wire.h> // Keep for Wire.begin()

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
  } else {
    // Handle display initialization failure (e.g., continue without display)
  }

  // Initialize GPS
  initGPS();

  // Initialize Button
  initButton();

  String initMsg[] = {"System Initialized", "Waiting for GPS..."};
  displayInfo(initMsg, 2); // Show initial message
}

void loop() {
  handleGPS();    // Call GPS handler
  handleButton(); // Call Button handler

  // No delay needed here usually, as handlers manage their own timing/blocking
}
