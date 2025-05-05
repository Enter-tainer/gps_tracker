#include "gps_handler.h"
#include "config.h"
// #include "display_handler.h" // No longer needed here
#include "system_info.h" // Include the new header
#include <Arduino.h>

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
  Serial.println("GPS Power ON");
  // Optional: Add a small delay if the module needs time to stabilize after
  // power on delay(100);
#else
  Serial.println("Warning: PIN_GPS_EN not defined. Cannot control GPS power.");
#endif
}

// Function to explicitly power off the GPS module
void powerOffGPS() {
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  digitalWrite(PIN_GPS_EN, LOW); // Assuming LOW turns GPS OFF
  Serial.println("GPS Power OFF");
#endif
  // Reset GPS data when turning off to avoid showing stale data
  gps = TinyGPSPlus();
  // Also reset relevant fields in gSystemInfo
}

// Function to initialize GPS communication and power pin
void initGPS() {
  gpsSerial.begin(GPS_BAUD_RATE);
  Serial.println("GPS Serial Initialized");

#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  powerOffGPS(); // Ensure GPS is off initially
#else
  Serial.println(
      "Warning: PIN_GPS_EN not defined. GPS power control disabled.");
#endif
  gSystemInfo.gpsState = GPS_OFF; // Set initial state in global struct
  lastFixAttemptTime = millis();
  Serial.println("GPS Handler Initialized. Waiting for first fix interval.");
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

// Function to handle GPS state, data reading, parsing, power, and updating
// gSystemInfo
void handleGPS() {
  unsigned long now = millis();

  switch (gSystemInfo.gpsState) { // Use global state
  case GPS_OFF:
    // Check if it's time to start a new fix attempt
    if (now - lastFixAttemptTime >= GPS_FIX_INTERVAL ||
        lastFixAttemptTime == 0) {
      Serial.println("Starting GPS fix attempt...");
      powerOnGPS();
      lastFixAttemptTime = now;  // Record the start time of this attempt cycle
      currentFixStartTime = now; // Record when the GPS was actually turned on
      gSystemInfo.gpsState = GPS_WAITING_FIX; // Update global state
    }
    break;

  case GPS_WAITING_FIX: { // Process available GPS data while powered on
    while (gpsSerial.available() > 0) {
      if (gps.encode(gpsSerial.read())) {
        // A new sentence was parsed, update system info immediately
        updateGpsSystemInfo(gps);
      }
    }

    // Check if we have a valid location, date, AND time fix
    bool fullFix =
        gps.location.isValid() && gps.date.isValid() && gps.time.isValid();
    // Check if minimum power on time has elapsed
    bool minTimeElapsed = (now - currentFixStartTime >= GPS_MIN_POWER_ON_TIME);

    if (fullFix) {
      // We have a full fix. Update state. Display handled in main loop.
      gSystemInfo.gpsState = GPS_FIX_ACQUIRED; // Update state
      Serial.println("GPS Full Fix Acquired (Location, Date, Time)!");
      // Update system info one last time for this fix cycle
      updateGpsSystemInfo(gps);

      // Now check if we can power off (fix acquired AND min time elapsed)
      if (minTimeElapsed) {
        Serial.println("Minimum power on time elapsed. Turning GPS OFF.");
        powerOffGPS(); // Turn GPS off (also resets gps object and info)
        gSystemInfo.gpsState = GPS_OFF; // Go back to idle state
      }

    } else if (now - currentFixStartTime >= GPS_FIX_ATTEMPT_TIMEOUT) {
      // Timeout waiting for a fix in this attempt
      Serial.println("GPS fix attempt timed out.");
      // Update system info with whatever partial data we might have
      updateGpsSystemInfo(gps);

      powerOffGPS(); // Turn GPS off on timeout (also resets gps object and
                     // info)
      gSystemInfo.gpsState = GPS_OFF; // Go back to idle state

    } else {
      // Still waiting for fix or minimum power on time, no timeout yet.
      // Update system info continuously as data comes in (done in gps.encode
      // loop) Display update handled in main loop
      if (gSystemInfo.gpsState != GPS_WAITING_FIX) {
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
      }
    }

    // Check if minimum power on time has elapsed
    bool minTimeElapsedAfterFix =
        (now - currentFixStartTime >= GPS_MIN_POWER_ON_TIME);
    if (minTimeElapsedAfterFix) {
      Serial.println(
          "Minimum power on time elapsed after fix. Turning GPS OFF.");
      powerOffGPS(); // Turn GPS off (also resets gps object and info)
      gSystemInfo.gpsState = GPS_OFF; // Go back to idle state
    }
    // Otherwise, just stay in this state, keep updating data, display handled
    // in main loop
    break;
  }
  // Process serial data regardless of state if GPS is potentially on
  // (WAITING_FIX or FIX_ACQUIRED)
  if (gSystemInfo.gpsState == GPS_WAITING_FIX ||
      gSystemInfo.gpsState == GPS_FIX_ACQUIRED) {
    while (gpsSerial.available() > 0) {
      if (gps.encode(gpsSerial.read())) {
        updateGpsSystemInfo(gps);
      }
    }
  }
}
