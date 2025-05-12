#include "gps_handler.h"
#include "config.h"
// #include "display_handler.h" // No longer needed here
#include "gps_scheduler.h" // <--- Add GpsScheduler header
#include "gpx_logger.h"    // <--- Add GPX Logger header
#include "logger.h"        // <--- Add Logger header
#include "system_info.h"   // Include the new header
#include <Arduino.h>
#include <stdint.h> // For uint32_t, int32_t

// Define GPS objects and state variables
TinyGPSPlus gps;
HardwareSerial &gpsSerial = GPS_SERIAL; // Use definition from config.h
// unsigned long lastGpsDisplayUpdate = 0; // Removed - display updated
// centrally GpsState currentGpsState = GPS_OFF; // State now managed in
// gSystemInfo
unsigned long lastFixAttemptTime = 0; // Initialize to 0
unsigned long currentFixStartTime = 0;

struct PositionResult {
  uint32_t timestamp{0};
  double latitude{0};
  double longitude{0};
  double altitude_m{0};
  double hdop{1e9};
};

PositionResult last_successful_position = PositionResult{};
// Track if a fix was acquired in the current session
bool gpsFixAcquiredInSession = false;

GpsScheduler gpsScheduler; // <--- Add GpsScheduler instance

// Function to explicitly power on the GPS module
void powerOnGPS() {
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  digitalWrite(PIN_GPS_EN, HIGH); // Assuming HIGH turns GPS ON
  Log.println("GPS Power ON");
  // Optional: Add a small delay if the module needs time to stabilize after
  // power on delay(100);
#else
  Log.println("Warning: PIN_GPS_EN not defined. Cannot control GPS power.");
#endif
}

// Function to explicitly power off the GPS module
void powerOffGPS() {
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  digitalWrite(PIN_GPS_EN, LOW); // Assuming LOW turns GPS OFF
  Log.println("GPS Power OFF");
#endif
  // Reset GPS data when turning off to avoid showing stale data
  gps = TinyGPSPlus();
  last_successful_position = {};   // Reset last successful
                                   // position
  gpsFixAcquiredInSession = false; // Reset session state
  // Also reset relevant fields in gSystemInfo
}

// Function to initialize GPS communication and power pin
void initGPS() {
  pinMode(LORA_RESET, OUTPUT);
  digitalWrite(LORA_RESET, LOW);  // Reset GPS module
  delay(100);                     // Wait for reset to complete
  digitalWrite(LORA_RESET, HIGH); // Release reset
  gpsSerial.begin(GPS_BAUD_RATE);
  Log.println("GPS Serial Initialized");

#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  powerOffGPS(); // Ensure GPS is off initially
#else
  Log.println("Warning: PIN_GPS_EN not defined. GPS power control disabled.");
#endif
  gSystemInfo.gpsState = GPS_OFF; // Set initial state in global struct
  Log.println("GPS Handler Initialized. Waiting for first fix interval.");
}

// Function to update the global gSystemInfo struct from TinyGPSPlus data
void updateGpsSystemInfo(TinyGPSPlus &gpsData) {
  gSystemInfo.locationValid = gpsData.location.isValid();
  if (gSystemInfo.locationValid) {
    gSystemInfo.latitude = gpsData.location.lat();       // Store as double
    gSystemInfo.longitude = gpsData.location.lng();      // Store as double
    gSystemInfo.satellites = gpsData.satellites.value(); // Store as uint32_t
    gSystemInfo.altitude = gpsData.altitude.meters();    // Store as float
  } else {
    // Reset numerical values if location is invalid
    gSystemInfo.latitude = 0.0;
    gSystemInfo.longitude = 0.0;
    gSystemInfo.satellites =
        gpsData.satellites.isValid() ? gpsData.satellites.value() : 0;
    gSystemInfo.altitude = 0.0f;
  }

  if (gpsData.hdop.isValid()) {
    gSystemInfo.hdop = gpsData.hdop.value() / 100.0f; // Store as float
  } else {
    gSystemInfo.hdop = 99.9f; // Use a default invalid value
  }

  if (gpsData.speed.isValid()) {
    gSystemInfo.speed = gpsData.speed.kmph(); // Store as float
  } else {
    gSystemInfo.speed = -1.0f; // Use -1.0 to indicate invalid speed
  }

  if (gpsData.course.isValid()) {
    gSystemInfo.course = gpsData.course.deg(); // Store as float
  } else {
    gSystemInfo.course = -1.0f; // Use -1.0 to indicate invalid course
  }

  gSystemInfo.dateTimeValid = gpsData.date.isValid() && gpsData.time.isValid();
  if (gSystemInfo.dateTimeValid) {
    gSystemInfo.year = gpsData.date.year();
    gSystemInfo.month = gpsData.date.month();
    gSystemInfo.day = gpsData.date.day();
    gSystemInfo.hour = gpsData.time.hour();
    gSystemInfo.minute = gpsData.time.minute();
    gSystemInfo.second = gpsData.time.second();
  } else {
    // Reset date/time values if invalid
    gSystemInfo.year = 0;
    gSystemInfo.month = 0;
    gSystemInfo.day = 0;
    gSystemInfo.hour = 0;
    gSystemInfo.minute = 0;
    gSystemInfo.second = 0;
  }
}

// Helper function to convert GPS date/time to an approximate Unix timestamp
// NOTE: This is a simplified calculation and doesn't account for leap seconds
// or time zones. For accurate timestamps, consider using TimeLib.h or an RTC.
uint32_t dateTimeToUnixTimestamp(uint16_t year, uint8_t month, uint8_t day,
                                 uint8_t hour, uint8_t minute, uint8_t second) {
  if (year < 1970 || year > 2038)
    return 0; // Basic validity check

  // Number of days from 1970 to the beginning of the given year (ignoring leap
  // years for simplicity in calculation start)
  uint32_t days = (year - 1970) * 365;

  // Add leap year days
  for (uint16_t y = 1972; y < year;
       y += 4) { // Start from 1972, the first leap year after 1970
    days++;
  }
  // Check if the current year is a leap year and if the date is after Feb 28
  bool isLeap = (year % 4 == 0); // Simplified leap year check
  if (isLeap && month > 2) {
    days++;
  }

  // Days in months (non-leap year)
  const uint8_t daysInMonth[] = {0,  31, 28, 31, 30, 31, 30,
                                 31, 31, 30, 31, 30, 31};

  // Add days for the months passed in the current year
  for (uint8_t m = 1; m < month; m++) {
    days += daysInMonth[m];
  }

  // Add days in the current month
  days += (day - 1);

  // Calculate total seconds
  uint32_t seconds = days * 86400UL; // 86400 seconds in a day
  seconds += hour * 3600UL;
  seconds += minute * 60UL;
  seconds += second;

  return seconds;
}

// --- Helper Function to Log Point and Power Off ---
static void logFixAndPowerOff() {
  Log.println("Logging GPX point and turning GPS OFF...");

  if (last_successful_position.hdop <= GPS_HDOP_THRESHOLD) {
    appendGpxPoint(last_successful_position.timestamp,
                   last_successful_position.latitude,
                   last_successful_position.longitude,
                   last_successful_position.altitude_m);
  }
  Log.println("GPX Point logged.");

  // Power off and reset state
  powerOffGPS();
  gSystemInfo.gpsState = GPS_OFF;
}
// --------------------------------------------------

// Function to handle GPS state, data reading, parsing, power, and updating
// gSystemInfo
void handleGPS() {
  unsigned long now = millis();
  // Common data processing for states where GPS is ON (GPS_WAITING_FIX or
  // GPS_FIX_ACQUIRED)
  if (gSystemInfo.gpsState == GPS_WAITING_FIX ||
      gSystemInfo.gpsState == GPS_FIX_ACQUIRED) {
    while (gpsSerial.available() > 0) {
      if (gps.encode(gpsSerial.read())) {
        // Since 'gps' object is updated by gps.encode(), update gSystemInfo
        // immediately
        updateGpsSystemInfo(gps);
        Log.printf(
            "GPS Data Updated in gSystemInfo. Lat: %.6lf, "
            "Lng: %.6lf, Alt: %.2f m, Sat: %u, HDOP: %.2f time: %d:%d:%d\n",
            gSystemInfo.latitude, gSystemInfo.longitude, gSystemInfo.altitude,
            gSystemInfo.satellites, gSystemInfo.hdop, (int)gSystemInfo.hour,
            (int)gSystemInfo.minute, (int)gSystemInfo.second);
        // And then update scheduler speed based on the new gSystemInfo
        if (gSystemInfo.locationValid && gSystemInfo.speed >= 0.0f) {
          gpsScheduler.updateSpeed(gSystemInfo.speed);
        }
      }
    }
  }

  switch (gSystemInfo.gpsState) {
  case GPS_OFF:
    // Check if it's time to start a new fix attempt
    if (now - lastFixAttemptTime >= gpsScheduler.getFixInterval() ||
        lastFixAttemptTime ==
            0) { // lastFixAttemptTime == 0 for the very first attempt
      Log.println("Starting GPS fix attempt...");
      powerOnGPS();
      currentFixStartTime = now; // Record when the GPS was actually turned on
      gSystemInfo.gpsState = GPS_WAITING_FIX; // Update global state
      // lastFixAttemptTime is NOT updated here; it marks the end of the
      // previous cycle or 0 if first run.
    }
    break;

  case GPS_WAITING_FIX: {
    // Decisions are based on the 'gps' object primarily.
    bool fullFix = gps.location.isValid() && gps.date.isValid() &&
                   gps.time.isValid() && gps.altitude.isValid();
    bool attemptTimedOut =
        (now - currentFixStartTime >= gpsScheduler.getFixAttemptTimeout());

    if (fullFix) {
      // gSystemInfo is already updated by the processing loop or the
      // conditional update above.
      Log.println("GPS Full Fix Acquired (Location, Date, Time, Altitude)!");
      gSystemInfo.gpsState = GPS_FIX_ACQUIRED;
      gpsFixAcquiredInSession = true; // Mark that a fix was acquired
      last_successful_position.timestamp = dateTimeToUnixTimestamp(
          gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(),
          gps.time.minute(), gps.time.second());
      last_successful_position.latitude = gps.location.lat();
      last_successful_position.longitude = gps.location.lng();
      last_successful_position.altitude_m = gps.altitude.meters();
      last_successful_position.hdop = gps.hdop.hdop();
    } else if (attemptTimedOut) {
      Log.println("GPS fix attempt timed out.");
      // gSystemInfo is now up-to-date from the conditional block above,
      // reflecting partial data if any. Speed scheduler also updated if
      // applicable.
      powerOffGPS();
      gSystemInfo.gpsState = GPS_OFF; // Go back to idle state
      lastFixAttemptTime = now;       // Mark end of timed-out attempt cycle
      gpsScheduler.reportFixStatus(false);
    }
    break;
  }

  case GPS_FIX_ACQUIRED: {
    bool fullFix = gps.location.isValid() && gps.date.isValid() &&
                   gps.time.isValid() && gps.altitude.isValid();
    if (fullFix) {
      gpsFixAcquiredInSession = true; // Mark that a fix was acquired
      last_successful_position.timestamp = dateTimeToUnixTimestamp(
          gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(),
          gps.time.minute(), gps.time.second());
      last_successful_position.latitude = gps.location.lat();
      last_successful_position.longitude = gps.location.lng();
      last_successful_position.altitude_m = gps.altitude.meters();
      last_successful_position.hdop = gps.hdop.hdop();
    }

    bool minTimeElapsed =
        (now - currentFixStartTime >= gpsScheduler.getMinPowerOnTime());

    if (minTimeElapsed) {
      // Min power on time now met. Log the fix data and power off.
      Log.println(
          "Minimum GPS power-on time elapsed. Logging final fix and powering "
          "off.");
      logFixAndPowerOff(); // Uses global 'gps', logs, powers off, and sets
                           // state to GPS_OFF
      gpsScheduler.reportFixStatus(true); // Report fix was successful
      lastFixAttemptTime = now; // Mark end of successful attempt cycle
    }
    break;
  }
  }
}
