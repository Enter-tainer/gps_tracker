#ifndef DISPLAY_HANDLER_H
#define DISPLAY_HANDLER_H

#include "system_info.h" // Include system info definition
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Wire.h>

// Declare the display object (defined in cpp)
extern Adafruit_SSD1306 display;

// Function to initialize the display
bool initDisplay();

// Function Prototypes
void updateDisplay(); // New function to render gSystemInfo

#endif // DISPLAY_HANDLER_H
