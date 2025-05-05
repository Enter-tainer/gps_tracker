#ifndef GPS_HANDLER_H
#define GPS_HANDLER_H

#include "system_info.h" // Include system info for GpsState and gSystemInfo
#include <TinyGPS++.h>

// GpsState Enum is now in system_info.h
// GpsInfo struct is replaced by SystemInfo

// Function Prototypes
void initGPS();
void handleGPS();
void powerOnGPS();
void powerOffGPS();
// Removed populateGpsInfo and formatGpsInfoLines

#endif // GPS_HANDLER_H
