#ifndef GPS_HANDLER_H
#define GPS_HANDLER_H

#include <Arduino.h>
#include <HardwareSerial.h>
#include <TinyGPS++.h>

// --- GPS Info Struct ---
struct GpsInfo {
  bool locationValid = false;
  String latitude = "N/A";
  String longitude = "N/A";
  String satellites = "N/A";
  String altitude = "N/A";
  String hdop = "N/A";
  String speed = "N/A";
  String course = "N/A";
  bool dateTimeValid = false;
  String date = "N/A";
  String time = "N/A";
};
// -----------------------

// GPS State Machine
enum GpsState { GPS_OFF, GPS_WAITING_FIX };

// Declare GPS objects (defined in cpp)
extern TinyGPSPlus gps;
extern HardwareSerial &gpsSerial;
extern unsigned long lastGpsDisplayUpdate; // Keep track of last update time
extern GpsState currentGpsState;           // Current state of the GPS handler
extern unsigned long
    lastFixAttemptTime; // Time the last fix attempt was started
extern unsigned long currentFixStartTime; // Time the current fix attempt
                                          // started (when GPS was powered on)

// Function to initialize GPS communication
void initGPS();

// Function to explicitly power on the GPS module
void powerOnGPS();

// Function to explicitly power off the GPS module
void powerOffGPS();

// Function to populate GpsInfo struct
void populateGpsInfo(TinyGPSPlus &gpsData, GpsInfo &info);

// Function to format GpsInfo into display lines
int formatGpsInfoLines(const GpsInfo &info, String lines[], int maxLines);

// Function to handle GPS data reading, parsing, and display update
void handleGPS();

#endif // GPS_HANDLER_H
