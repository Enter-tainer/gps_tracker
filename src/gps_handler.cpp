#include "gps_handler.h"
#include "config.h"
#include "display_handler.h" // Need displayInfo
#include <Arduino.h>

// Define GPS objects and state variables
TinyGPSPlus gps;
HardwareSerial &gpsSerial = GPS_SERIAL; // Use definition from config.h
unsigned long lastGpsDisplayUpdate = 0;
GpsState currentGpsState = GPS_OFF;   // Start with GPS off
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
  // Set lastFixAttemptTime initially so the first attempt starts after
  // GPS_FIX_INTERVAL We subtract the interval so the first check passes
  // immediately in the loop if needed, or simply set to 0 to wait for the first
  // interval. Let's wait.
  lastFixAttemptTime = millis();
  Serial.println("GPS Handler Initialized. Waiting for first fix interval.");
}

// Function to populate GpsInfo struct
void populateGpsInfo(TinyGPSPlus &gpsData, GpsInfo &info) {
  info.locationValid = gpsData.location.isValid();
  if (info.locationValid) {
    info.latitude = String(gpsData.location.lat(), 6);
    info.longitude = String(gpsData.location.lng(), 6);
    info.satellites = String(gpsData.satellites.value());
    info.altitude = String(gpsData.altitude.meters()) + "m";
  } else {
    info.latitude = "N/A";
    info.longitude = "N/A";
    info.satellites = "N/A";
    info.altitude = "N/A";
  }

  if (gpsData.hdop.isValid()) {
    info.hdop = String(gpsData.hdop.value() / 100.0, 1);
  } else {
    info.hdop = "N/A";
  }

  if (gpsData.speed.isValid()) {
    info.speed = String(gpsData.speed.kmph(), 1) + "km/h";
  } else {
    info.speed = "N/A";
  }

  if (gpsData.course.isValid()) {
    info.course = String(gpsData.course.deg(), 1);
  } else {
    info.course = "N/A";
  }

  info.dateTimeValid = gpsData.date.isValid() && gpsData.time.isValid();
  if (info.dateTimeValid) {
    info.date = String(gpsData.date.year()) + "-" +
                String(gpsData.date.month()) + "-" + String(gpsData.date.day());
    // Format time with leading zeros if needed (optional)
    char timeBuffer[9];
    snprintf(timeBuffer, sizeof(timeBuffer), "%02d:%02d:%02d",
             gpsData.time.hour(), gpsData.time.minute(), gpsData.time.second());
    info.time = String(timeBuffer);
  } else {
    info.date = "N/A";
    info.time = "N/A";
  }
}

// Function to format GpsInfo into display lines
int formatGpsInfoLines(const GpsInfo &info, String lines[], int maxLines) {
  int lineCount = 0;

  if (lineCount < maxLines)
    lines[lineCount++] = "Lat: " + info.latitude;
  if (lineCount < maxLines)
    lines[lineCount++] = "Lng: " + info.longitude;
  // Combine Sats and Alt
  if (lineCount < maxLines)
    lines[lineCount++] = "Sats:" + info.satellites + " Alt:" + info.altitude;
  if (lineCount < maxLines)
    lines[lineCount++] = "HDOP: " + info.hdop;
  if (lineCount < maxLines)
    lines[lineCount++] = "Spd: " + info.speed;
  if (lineCount < maxLines)
    lines[lineCount++] = "Course: " + info.course;
  if (lineCount < maxLines)
    lines[lineCount++] = "Date: " + info.date;
  if (lineCount < maxLines)
    lines[lineCount++] = "Time: " + info.time;

  return lineCount;
}

// Function to handle GPS state, data reading, parsing, power, and display
// update
void handleGPS() {
  unsigned long now = millis();

  switch (currentGpsState) {
  case GPS_OFF:
    // Check if it's time to start a new fix attempt
    if (now - lastFixAttemptTime >= GPS_FIX_INTERVAL) {
      Serial.println("Starting GPS fix attempt...");
      powerOnGPS();
      lastFixAttemptTime = now;  // Record the start time of this attempt cycle
      currentFixStartTime = now; // Record when the GPS was actually turned on
      currentGpsState = GPS_WAITING_FIX;
      // Display searching message immediately
      String searchingMsg[] = {"Searching for", "GPS signal..."};
      displayInfo(searchingMsg, 2);
      lastGpsDisplayUpdate = now; // Update display time
    }
    break;

  case GPS_WAITING_FIX:
    // Process available GPS data while powered on
    while (gpsSerial.available() > 0) {
      gps.encode(gpsSerial.read());
    }

    // Check if we have a valid location, date, AND time fix
    bool fullFix =
        gps.location.isValid() && gps.date.isValid() && gps.time.isValid();
    // Check if minimum power on time has elapsed
    bool minTimeElapsed = (now - currentFixStartTime >= GPS_MIN_POWER_ON_TIME);

    if (fullFix) {
      // We have a fix, update display regardless of min time
      // Check if it's time to update the display based on interval or if it's
      // the first fix display
      if (now - lastGpsDisplayUpdate > GPS_DISPLAY_INTERVAL ||
          currentGpsState == GPS_WAITING_FIX /* Force update on first fix */) {
        Serial.println("GPS Full Fix Acquired (Location, Date, Time)!");
        GpsInfo currentGpsInfo;
        populateGpsInfo(gps, currentGpsInfo); // Populate the struct

        const int MAX_GPS_LINES = 8;
        String gpsLines[MAX_GPS_LINES];
        int lineCount =
            formatGpsInfoLines(currentGpsInfo, gpsLines, MAX_GPS_LINES);

        displayInfo(gpsLines, lineCount); // Display the formatted lines
        lastGpsDisplayUpdate = now;
      }

      // Now check if we can power off (fix acquired AND min time elapsed)
      if (minTimeElapsed) {
        Serial.println("Minimum power on time elapsed. Turning GPS OFF.");
        powerOffGPS();             // Turn GPS off
        currentGpsState = GPS_OFF; // Go back to idle state
      } else {
        // Keep GPS ON, waiting for minimum power on time to pass
        // Serial.println("Fix acquired, but waiting for min power on time.");
        // // Optional debug message
      }

    } else if (now - currentFixStartTime >= GPS_FIX_ATTEMPT_TIMEOUT) {
      // Timeout waiting for a fix in this attempt
      Serial.println("GPS fix attempt timed out.");
      // Display timeout message along with any partial data
      GpsInfo currentGpsInfo;
      populateGpsInfo(gps,
                      currentGpsInfo); // Populate with potentially partial data

      const int MAX_GPS_LINES = 8;
      String gpsLines[MAX_GPS_LINES];
      gpsLines[0] = "GPS Timeout";
      int lineCount = 1;
      if (currentGpsInfo.locationValid) {
        gpsLines[lineCount++] = "Lat: " + currentGpsInfo.latitude;
        gpsLines[lineCount++] = "Lng: " + currentGpsInfo.longitude;
      } else {
        gpsLines[lineCount++] = "(No Fix)";
      }
      // Optionally add time/date if they became valid just before timeout
      if (currentGpsInfo.dateTimeValid) {
        if (lineCount < MAX_GPS_LINES)
          gpsLines[lineCount++] = "Time: " + currentGpsInfo.time;
      }

      displayInfo(gpsLines, lineCount);
      lastGpsDisplayUpdate = now; // Update display time

      powerOffGPS();             // Turn GPS off on timeout
      currentGpsState = GPS_OFF; // Go back to idle state

    } else {
      // Still waiting for fix or minimum power on time, no timeout yet.
      // Update display periodically to show "Searching..."
      if (now - lastGpsDisplayUpdate > GPS_DISPLAY_INTERVAL) {
        String searchingMsg[] = {"Searching...",
                                 "Satellites: " +
                                     (gps.satellites.isValid()
                                          ? String(gps.satellites.value())
                                          : "N/A")};
        displayInfo(searchingMsg, 2);
        lastGpsDisplayUpdate = now;
      }
    }
    break;
  }
}
