#ifndef DISPLAY_HANDLER_H
#define DISPLAY_HANDLER_H

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Wire.h>

// Declare the display object (defined in cpp)
extern Adafruit_SSD1306 display;

// Function to initialize the display
bool initDisplay();

// Helper function to print multiple lines to OLED and Serial
void displayInfo(const String lines[], int numLines);

#endif // DISPLAY_HANDLER_H
