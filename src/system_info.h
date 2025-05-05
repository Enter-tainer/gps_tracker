#ifndef SYSTEM_INFO_H
#define SYSTEM_INFO_H

#include <Arduino.h> // For String type if needed elsewhere, or standard types like uint8_t
#include <stdint.h> // For fixed-width integer types

// GPS State Enum
enum GpsState { GPS_OFF, GPS_WAITING_FIX, GPS_FIX_ACQUIRED };

// Structure to hold all system information
struct SystemInfo {
  // GPS Data - Using numerical types now
  double latitude = 0.0;
  double longitude = 0.0;
  float altitude = 0.0f; // Meters
  uint32_t satellites = 0;
  float hdop = 99.9f;  // Horizontal Dilution of Precision
  float speed = 0.0f;  // Kilometers per hour
  float course = 0.0f; // Degrees
  uint16_t year = 0;
  uint8_t month = 0;
  uint8_t day = 0;
  uint8_t hour = 0;
  uint8_t minute = 0;
  uint8_t second = 0;
  bool locationValid = false;
  bool dateTimeValid = false;

  // System Status
  float batteryVoltage = -1.0f; // voltage, -1.0 indicates N/A
  GpsState gpsState = GPS_OFF; // Current state of the GPS module
  // String gpsStatusText = "OFF"; // Removed - will be generated in display
  // handler
};

// Declare the global instance (defined in main.cpp)
extern SystemInfo gSystemInfo;

// Function declarations
// void updateGpsStatusText(); // Removed - no longer needed globally

#endif // SYSTEM_INFO_H
