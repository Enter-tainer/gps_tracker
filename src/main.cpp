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
    String bootMessage[] = {"GPS Tracker", "Initializing..."};
    displayInfo(bootMessage, 1); // Show a simple boot message
  } else {
    // Handle display initialization failure (e.g., continue without display)
    Serial.println("Display Init Failed!");
  }

  // Initialize GPS (will start in OFF state)
  initGPS();

  // Initialize Button
  initButton();

  // No initial GPS message here, handleGPS will manage it.
  Serial.println("Setup Complete. Entering loop.");
}

void loop() {
  handleGPS();    // Call GPS handler (manages state, power, timing)
  handleButton(); // Call Button handler

  // The loop runs as fast as possible.
  // handleGPS and handleButton are designed to be non-blocking.
  // Power saving is achieved by turning the GPS module off in handleGPS.
}
