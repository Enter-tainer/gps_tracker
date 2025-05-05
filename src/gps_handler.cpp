#include "gps_handler.h"
#include "config.h"
#include "display_handler.h" // Need displayInfo
#include <Arduino.h>

// Define GPS objects
TinyGPSPlus gps;
HardwareSerial &gpsSerial = GPS_SERIAL; // Use definition from config.h
unsigned long lastGpsDisplayUpdate = 0;

// Function to initialize GPS communication
void initGPS() {
  gpsSerial.begin(GPS_BAUD_RATE);
  Serial.println("GPS Serial Initialized");

// Optional: Enable GPS module power if PIN_GPS_EN is defined and used
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
#ifdef GPS_POWER_TOGGLE // If power needs toggling
  digitalWrite(PIN_GPS_EN, LOW);
  delay(100);
  digitalWrite(PIN_GPS_EN, HIGH);
#else // If power is just enable high
  digitalWrite(PIN_GPS_EN, HIGH); // Or LOW depending on module logic
#endif
  Serial.println("GPS Power Enabled");
#endif
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

// Function to handle GPS data reading, parsing, and display update
void handleGPS() {
  bool newData = false;
  // Process available GPS data
  while (gpsSerial.available() > 0) {
    if (gps.encode(gpsSerial.read())) {
      newData = true; // Mark that new data has been parsed
    }
  }

  // Update display periodically if new data was received or enough time has
  // passed
  unsigned long now = millis();
  if (newData && (now - lastGpsDisplayUpdate > GPS_DISPLAY_INTERVAL)) {
    lastGpsDisplayUpdate = now;

    GpsInfo currentGpsInfo;
    populateGpsInfo(gps, currentGpsInfo); // Populate the struct

    const int MAX_GPS_LINES = 8; // Max lines after combining Sats/Alt
    String gpsLines[MAX_GPS_LINES];
    int lineCount = formatGpsInfoLines(currentGpsInfo, gpsLines,
                                       MAX_GPS_LINES); // Format lines

    displayInfo(gpsLines, lineCount); // Display the formatted lines

  } else if (now > GPS_NO_FIX_TIMEOUT && gps.sentencesWithFix() == 0 &&
             (now - lastGpsDisplayUpdate > GPS_NO_FIX_MSG_INTERVAL)) {
    // If no fix after timeout, show message periodically
    lastGpsDisplayUpdate = now; // Prevent spamming the message
    String noFixMsg[] = {"No GPS fix.", "Check antenna", "and wiring."};
    displayInfo(noFixMsg, 3);
  }
}
