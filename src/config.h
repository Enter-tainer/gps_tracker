#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h> // Include Arduino core for pin definitions if needed

// OLED display settings
#define SCREEN_WIDTH 128    // OLED display width, in pixels
#define SCREEN_HEIGHT 64    // OLED display height, in pixels
#define OLED_RESET -1       // Reset pin # (or -1 if sharing Arduino reset pin)
#define SCREEN_ADDRESS 0x3C // I2C address for 128x64 SSD1306
#define DISPLAY_TIMEOUT_MS                                                     \
  30000 // Auto screen off timeout in milliseconds (30 seconds)

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
    60000; // Max time to wait for a fix within an attempt (30 seconds in ms)

// --- GPS Handler Configuration ---
// Constants from state_spec.md
#define T_ACTIVE_SAMPLING_INTERVAL_MS (10 * 1000)              // 10 seconds
#define T_STILLNESS_CONFIRM_DURATION_MS (60 * 1000)            // 60 seconds
#define GPS_SPEED_VEHICLE_THRESHOLD_KMPH (5.0)                 // km/h
#define T_GPS_QUERY_TIMEOUT_FOR_STILLNESS_MS (5 * 1000)        // 5 seconds
#define T_GPS_COLD_START_FIX_TIMEOUT_MS (90 * 1000)            // 90 seconds
#define T_GPS_REACQUIRE_FIX_TIMEOUT_MS (30 * 1000)             // 30 seconds
#define T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL_MS (15 * 60 * 1000) // 15 minutes
#define GPS_HDOP_THRESHOLD                                                     \
  2.5 // Example: HDOP threshold for a good fix, used by old logic, might be
      // replaced or reused.
#define MIN_HDOP_FOR_VALID_FIX                                                 \
  2.0 // HDOP value less than this is considered a valid fix, from state_spec
#define MAX_CONSECUTIVE_FIX_FAILURES (16) // Increased from 5 to 16 as per spec

// Initial state after S0_INITIALIZING
// Set to S1_GPS_SEARCHING_FIX to start GPS immediately,
// or S2_IDLE_GPS_OFF to wait for motion or periodic wake.
#define GPS_INITIAL_STATE_AFTER_INIT S2_IDLE_GPS_OFF

// LittleFS settings
#define MAX_FILE_SIZE 520 * 1024 // Maximum total file size in bytes (520 KB)
// Optional: GPS Power Enable Pin (if used) - Commented out as we define
// PIN_GPS_EN above #define PIN_GPS_EN YOUR_GPS_ENABLE_PIN #define
// GPS_POWER_TOGGLE // Uncomment if power needs toggling (LOW->HIGH) instead of
// just HIGH

#endif // CONFIG_H
