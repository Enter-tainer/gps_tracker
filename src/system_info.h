#ifndef SYSTEM_INFO_H
#define SYSTEM_INFO_H

#include <Arduino.h> // For String type if needed elsewhere, or standard types like uint8_t
#include <stdint.h> // For fixed-width integer types

// GPS State definitions based on state_spec.md
typedef enum {
  S0_INITIALIZING,
  S1_GPS_SEARCHING_FIX,
  S2_IDLE_GPS_OFF,
  S3_TRACKING_FIXED,
  S4_ANALYZING_STILLNESS
} GpsState_t;

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
  GpsState_t gpsState;          // Current GPS state machine state

  // Stationary (静止) Info
  bool isStationary = false; // 是否静止 (由加速度计模块更新，表示已确认静止)
};

// Declare the global instance (defined in main.cpp)
extern SystemInfo gSystemInfo;

// Function declarations
void initializeSystemInfo();

#endif // SYSTEM_INFO_H
