#include "display_handler.h"
#include "battery.h" // Include battery functions
#include "config.h"
#include "system_info.h" // Include global system info
#include <Arduino.h>     // For Serial
#include <Wire.h>        // Include Wire for display

// Define the display object
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Function to initialize the display
bool initDisplay() {
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("SSD1306 allocation failed"));
    return false;
  }
  Serial.println(F("SSD1306 Initialized"));
  display.display(); // show splash screen (Adafruit logo)
  delay(500);        // Pause
  display.clearDisplay();
  display.setTextSize(1);              // Default text size
  display.setTextColor(SSD1306_WHITE); // Default text color
  display.setCursor(0, 0);             // Default cursor position
  // display.println("OLED Initialized"); // Don't show this, let first update
  // handle it display.display(); delay(500);
  return true;
}

// Function to update the display based on the global gSystemInfo
void updateDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);

  char buffer[32]; // Buffer for formatting strings

  // Line 1: Speed / Course
  display.print("Spd:");
  if (gSystemInfo.speed >= 0.0f) {
    snprintf(buffer, sizeof(buffer), "%.1f", gSystemInfo.speed); // Use snprintf
    display.print(buffer);
    // display.print("km/h"); // Remove unit to save space if needed, or keep
  } else {
    display.print("N/A");
  }

  // Calculate position for Course
  String courseLabel = " Crs:";
  String courseValueStr;
  if (gSystemInfo.course >= 0.0f) {
    snprintf(buffer, sizeof(buffer), "%.0f",
             gSystemInfo.course); // Use snprintf
    courseValueStr = buffer;
  } else {
    courseValueStr = "N/A";
  }

  int16_t x1, y1;
  uint16_t w, h;
  // Calculate width needed for label + value
  display.getTextBounds(courseLabel + courseValueStr, 0, 0, &x1, &y1, &w, &h);
  int courseX = SCREEN_WIDTH - w - 1; // Position cursor for right alignment
  // Ensure it doesn't overlap speed too much
  if (courseX < display.getCursorX() + 5) {
    courseX = display.getCursorX() + 5;
  }
  int16_t currentY = display.getCursorY(); // Get Y before potential wrap
  display.setCursor(courseX, currentY);
  display.print(courseLabel);
  display.println(courseValueStr); // Use println to move to next line

  // Line 2: Date
  display.print("Date: ");
  if (gSystemInfo.dateTimeValid) {
    snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d", gSystemInfo.year,
             gSystemInfo.month, gSystemInfo.day);
    display.println(buffer);
  } else {
    display.println("N/A");
  }

  // Line 3: Time
  display.print("Time: ");
  if (gSystemInfo.dateTimeValid) {
    snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d", gSystemInfo.hour,
             gSystemInfo.minute, gSystemInfo.second);
    display.println(buffer);
  } else {
    display.println("N/A");
  }

  // Line 4: Lat
  display.print("Lat:");
  if (gSystemInfo.locationValid) {
    snprintf(buffer, sizeof(buffer), "%.6f",
             gSystemInfo.latitude); // Use snprintf
    display.println(buffer);
  } else {
    display.println("N/A");
  }

  // Line 5: Lng
  display.print("Lng:");
  if (gSystemInfo.locationValid) {
    snprintf(buffer, sizeof(buffer), "%.6f",
             gSystemInfo.longitude); // Use snprintf
    display.println(buffer);
  } else {
    display.println("N/A");
  }

  // Line 6: Alt / Sats / HDOP
  display.print("A:");
  if (gSystemInfo.locationValid) {
    snprintf(buffer, sizeof(buffer), "%.1f",
             gSystemInfo.altitude); // Use snprintf
    display.print(buffer);
    display.print("m");
  } else {
    display.print("N/A");
  }

  display.print(" S:");
  display.print(gSystemInfo.satellites);

  display.print(" H:");
  if (gSystemInfo.hdop < 99.0f) { // Check against the invalid value
    snprintf(buffer, sizeof(buffer), "%.1f", gSystemInfo.hdop); // Use snprintf
    display.println(buffer);
  } else {
    display.println("N/A");
  }

  // Line 7: GPS Status (Left)
  display.print("GPS: ");
  switch (gSystemInfo.gpsState) {
  case GPS_OFF:
    display.print("OFF");
    break;
  case GPS_WAITING_FIX:
    display.print("Searching");
    break;
  case GPS_FIX_ACQUIRED:
    display.print("FIX");
    break;
  default:
    display.print("Unknown");
    break;
  }

  // Line 8: Battery (Placeholder) - Bottom right corner
  String battLabel = "Bat:";
  String battValueStr;
  if (gSystemInfo.batteryVoltage >= 0.0f) {
    snprintf(buffer, sizeof(buffer), "%.2f",
             gSystemInfo.batteryVoltage); // Use snprintf
    battValueStr = buffer;                // Assuming it's percentage or voltage
    battValueStr += "V";                  // Add unit if needed
    battValueStr += "/";
    snprintf(buffer, sizeof(buffer), "%.0f",
             estimateBatteryLevel(gSystemInfo.batteryVoltage *
                                  1000)); // Use snprintf
    battValueStr += buffer;               // Append battery level
    battValueStr += "%";                  // Add percentage sign
  } else {
    battValueStr = "N/A";
  }

  // Get text bounds for battery info to calculate width
  display.getTextBounds(battLabel + battValueStr, 0, 0, &x1, &y1, &w, &h);
  // Set cursor to bottom right corner
  display.setCursor(SCREEN_WIDTH - w - 1, SCREEN_HEIGHT - h);
  display.print(battLabel);
  display.print(battValueStr);

  display.display();
}
