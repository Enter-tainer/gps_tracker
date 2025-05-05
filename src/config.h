#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h> // Include Arduino core for pin definitions if needed

// OLED display settings
#define SCREEN_WIDTH 128    // OLED display width, in pixels
#define SCREEN_HEIGHT 64    // OLED display height, in pixels
#define OLED_RESET -1       // Reset pin # (or -1 if sharing Arduino reset pin)
#define SCREEN_ADDRESS 0x3C // I2C address for 128x64 SSD1306

// GPS settings
#define GPS_SERIAL Serial1 // HardwareSerial port for GPS (e.g., Serial1)
#define GPS_BAUD_RATE 9600 // GPS module baud rate
const unsigned long GPS_DISPLAY_INTERVAL =
    1000; // Update display every second if data is available
const unsigned long GPS_NO_FIX_TIMEOUT =
    5000; // Time in ms before showing "No GPS fix"
const unsigned long GPS_NO_FIX_MSG_INTERVAL =
    2000; // Interval to show "No GPS fix" message

// Button settings (BUTTON_PIN is often defined in variant.h for specific
// boards) If not defined in variant.h, define it here: #define BUTTON_PIN
// YOUR_BUTTON_PIN_NUMBER
const unsigned long DEBOUNCE_DELAY = 50; // Debounce time in milliseconds
const unsigned long HOLD_DURATION = 50;  // Required hold duration in ms

// GPS Power and Timing Settings
const unsigned long GPS_FIX_INTERVAL =
    10000; // Interval between GPS fix attempts (10 seconds in ms)
const unsigned long GPS_FIX_ATTEMPT_TIMEOUT =
    30000; // Max time to wait for a fix within an attempt (30 seconds in ms)
const unsigned long GPS_MIN_POWER_ON_TIME =
    1000; // Minimum time GPS stays powered on after starting an attempt (1
          // second in ms)

// Optional: GPS Power Enable Pin (if used) - Commented out as we define
// PIN_GPS_EN above #define PIN_GPS_EN YOUR_GPS_ENABLE_PIN #define
// GPS_POWER_TOGGLE // Uncomment if power needs toggling (LOW->HIGH) instead of
// just HIGH

#endif // CONFIG_H
