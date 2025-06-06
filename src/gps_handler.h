#ifndef GPS_HANDLER_H
#define GPS_HANDLER_H

#include "system_info.h" // For GpsState_t and gSystemInfo
#include <TinyGPS++.h>   // For TinyGPSPlus object

// Function to initialize GPS communication and power pin
void initGPS();

// Function to handle GPS state, data reading, parsing, power, and updating
// gSystemInfo
void handleGPS();

// Function to explicitly power on the GPS module
void powerOnGPS();

// Function to explicitly power off the GPS module
void powerOffGPS();

// Helper function to update the global gSystemInfo struct from TinyGPSPlus data
void updateGpsSystemInfo(TinyGPSPlus &gpsData);

// Helper function to convert GPS date/time to an approximate Unix timestamp
uint32_t dateTimeToUnixTimestamp(uint16_t year, uint8_t month, uint8_t day,
                                 uint8_t hour, uint8_t minute, uint8_t second);

#endif // GPS_HANDLER_H
