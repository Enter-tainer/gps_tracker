#ifndef DISPLAY_HANDLER_H
#define DISPLAY_HANDLER_H

#include "i2c_lock.h"
#include "logger.h"
#include "system_info.h" // Include system info definition
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Wire.h>

// Declare the display object (defined in cpp)
extern Adafruit_SSD1306 display;
const unsigned long DISPLAY_UPDATE_INTERVAL_MS = 100;
extern bool isDisplayOn; // Track display state
// Function to initialize the display
bool initDisplay();

// Function Prototypes
void updateDisplay();       // New function to render gSystemInfo
void toggleDisplay();       // Function to toggle display on/off
void turnDisplayOn();       // Function to explicitly turn display on
void turnDisplayOff();      // Function to explicitly turn display off
void resetDisplayTimeout(); // Function to reset the auto-off timer
bool checkDisplayTimeout(); // Function to check the auto-off timer
inline void refreshDisplayTimerCallback(TimerHandle_t _handle) {
  if (checkDisplayTimeout()) {
    return;
  }
  updateDisplay(); // Call the update function
}
#endif // DISPLAY_HANDLER_H
