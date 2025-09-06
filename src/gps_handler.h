#ifndef GPS_HANDLER_H
#define GPS_HANDLER_H

#include "casic_gps_wrapper.h" // For CASIC GPS wrapper
#include "system_info.h"       // For GpsState_t and gSystemInfo
#include <vector>              // For AGNSS message queue

// Function to initialize GPS communication and power pin
void initGPS();

// Function to handle GPS state, data reading, parsing, power, and updating
// gSystemInfo
void handleGPS();

// Function to explicitly power on the GPS module
void powerOnGPS();

// Function to explicitly power off the GPS module
void powerOffGPS();

// Helper function to update the global gSystemInfo struct from GPS wrapper
void updateGpsSystemInfo();

// Helper function to convert GPS date/time to an approximate Unix timestamp
uint32_t dateTimeToUnixTimestamp(uint16_t year, uint8_t month, uint8_t day,
                                 uint8_t hour, uint8_t minute, uint8_t second);

// AGNSS related functions
void setAgnssMessageQueue(const std::vector<std::vector<uint8_t>> &messages);
void triggerAgnssProcessing();

// GPS wakeup function to simulate motion detection
void triggerGpsWakeup();

#endif // GPS_HANDLER_H
