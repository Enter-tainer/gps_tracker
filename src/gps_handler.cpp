#include "gps_handler.h"
#include "config.h"
// #include "display_handler.h" // No longer needed here
#include "gpx_logger.h"  // <--- Add GPX Logger header
#include "logger.h"      // <--- Add Logger header
#include "system_info.h" // Include the new header
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
  // Also reset relevant fields in gSystemInfo
}

// Function to initialize GPS communication and power pin
void initGPS() {
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

  // Calculate timestamp
  uint32_t timestamp = dateTimeToUnixTimestamp(
      gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(),
      gps.time.minute(), gps.time.second());

  // Get float values directly from gps object
  double lat_float = gps.location.lat();
  double lon_float = gps.location.lng();
  double alt_m = gps.altitude.meters();

  // Append the point

  if (gps.hdop.hdop() <= GPS_HDOP_THRESHOLD) {
    appendGpxPoint(timestamp, lat_float, lon_float, alt_m);
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

  switch (gSystemInfo.gpsState) { // Use global state
  case GPS_OFF:
    // Check if it's time to start a new fix attempt
    if (now - lastFixAttemptTime >= GPS_FIX_INTERVAL ||
        lastFixAttemptTime == 0) {
      Log.println("Starting GPS fix attempt...");
      powerOnGPS();
      lastFixAttemptTime = now;  // Record the start time of this attempt cycle
      currentFixStartTime = now; // Record when the GPS was actually turned on
      gSystemInfo.gpsState = GPS_WAITING_FIX; // Update global state
    }
    break;

  case GPS_WAITING_FIX: {
    // Process available GPS data while powered on
    bool dataParsed = false;
    while (gpsSerial.available() > 0) {
      if (gps.encode(gpsSerial.read())) {
        // A new sentence was parsed, update system info immediately
        updateGpsSystemInfo(gps);
        dataParsed = true; // Mark that we processed data
      }
    }

    // Check if we have a valid location, date, AND time fix AFTER processing
    // all available data
    bool fullFix = gps.location.isValid() && gps.date.isValid() &&
                   gps.time.isValid() && gps.altitude.isValid();
    bool minTimeElapsed = (now - currentFixStartTime >= GPS_MIN_POWER_ON_TIME);

    if (fullFix) {
      // We have a full fix. Update state. Display handled in main loop.
      gSystemInfo.gpsState = GPS_FIX_ACQUIRED; // Update state
      Log.println("GPS Full Fix Acquired (Location, Date, Time, Altitude)!");

      // Update system info one last time for this fix cycle (might be redundant
      // if dataParsed was true, but safe)
      if (!dataParsed) { // If no new data was parsed just before the check,
                         // update info now
        updateGpsSystemInfo(gps);
      }

      // Check if we can power off immediately (fix acquired AND min time
      // elapsed)
      if (minTimeElapsed) {
        // *** Call the helper function ***
        logFixAndPowerOff();
      }
      // If minTimeElapsed is false, we stay in GPS_FIX_ACQUIRED until it is
      // true

    } else if (now - currentFixStartTime >= GPS_FIX_ATTEMPT_TIMEOUT) {
      // Timeout waiting for a fix in this attempt
      Log.println("GPS fix attempt timed out.");
      // Update system info with whatever partial data we might have (already
      // done in loop if dataParsed)
      if (!dataParsed) {
        updateGpsSystemInfo(gps);
      }

      // *** Power off without logging on timeout ***
      powerOffGPS();
      gSystemInfo.gpsState = GPS_OFF; // Go back to idle state
      lastFixAttemptTime = millis();  // Reset last attempt time

    } else {
      // Still waiting for fix or minimum power on time, no timeout yet.
      // System info is updated continuously as data comes in (done in
      // gps.encode loop) Display update handled in main loop
      if (gSystemInfo.gpsState != GPS_WAITING_FIX) { // Ensure state is correct
        gSystemInfo.gpsState = GPS_WAITING_FIX;
      }
    }
    break;
  }
  case GPS_FIX_ACQUIRED:
    // GPS has a fix, but we might still be waiting for min power on time
    // Process available GPS data to keep info fresh
    while (gpsSerial.available() > 0) {
      if (gps.encode(gpsSerial.read())) {
        updateGpsSystemInfo(gps);
        // NOTE: We already logged the point when the fix was first acquired.
        // We don't log again here unless the requirements change to log
        // continuously while the fix is held and power is on.
      }
    }

    // Check if minimum power on time has elapsed
    bool minTimeElapsedAfterFix =
        (now - currentFixStartTime >= GPS_MIN_POWER_ON_TIME);
    if (minTimeElapsedAfterFix) {
      // *** Call the helper function ***
      logFixAndPowerOff();
    }
    // Otherwise, just stay in this state, keep updating data, display handled
    // in main loop
    break;
  }
  // Redundant check removed: The processing loops within WAITING_FIX and
  // FIX_ACQUIRED handle serial data.
}
