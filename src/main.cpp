#include "Adafruit_TinyUSB.h"
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <HardwareSerial.h> // Include for HardwareSerial
#include <TinyGPS++.h>      // Include TinyGPS++ library
#include <Wire.h>

// OLED display settings
#define SCREEN_WIDTH 128    // OLED display width, in pixels
#define SCREEN_HEIGHT 64    // OLED display height, in pixels
#define OLED_RESET -1       // Reset pin # (or -1 if sharing Arduino reset pin)
#define SCREEN_ADDRESS 0x3C // I2C address for 128x64 SSD1306

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// GPS settings
TinyGPSPlus gps;
HardwareSerial &gpsSerial = Serial1; // Use Serial1 for GPS communication
unsigned long lastGpsDisplayUpdate = 0;
const unsigned long GPS_DISPLAY_INTERVAL =
    1000; // Update display every second if data is available

// Button settings
// Button pin defined in variant.h
// #define BUTTON_PIN (32 + 0) // P1.00
unsigned long lastButtonCheckTime = 0;
bool lastButtonState = HIGH;    // Assuming INPUT_PULLUP, HIGH is released
bool currentButtonState = HIGH; // Debounced state
const unsigned long DEBOUNCE_DELAY = 50; // Debounce time in milliseconds
unsigned long pressStartTime =
    0; // Time when the button press started (after debounce)
bool actionTriggeredForPress =
    false; // Flag to ensure action triggers only once per press
const unsigned long HOLD_DURATION = 50; // Required hold duration in ms

// Helper function to print multiple lines to OLED and Serial
void displayInfo(const String lines[], int numLines) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);

  Serial.println("--- Display Update ---");
  for (int i = 0; i < numLines; ++i) {
    display.println(lines[i]);
    Serial.println(lines[i]);
  }
  Serial.println("----------------------");

  display.display();
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

    // Increase array size for HDOP, Speed, Course
    String gpsLines[9]; // Max lines: Lat, Lng, Sats, Alt, HDOP, Speed, Course,
                        // Date, Time
    int lineCount = 0;

    if (gps.location.isValid()) {
      gpsLines[lineCount++] = "Lat: " + String(gps.location.lat(), 6);
      gpsLines[lineCount++] = "Lng: " + String(gps.location.lng(), 6);
      gpsLines[lineCount++] = "Sats: " + String(gps.satellites.value());
      gpsLines[lineCount++] = "Alt: " + String(gps.altitude.meters()) + "m";

      // Add HDOP if available
      if (gps.hdop.isValid()) {
        gpsLines[lineCount++] = "HDOP: " + String(gps.hdop.value() / 100.0, 1);
      } else {
        gpsLines[lineCount++] = "HDOP: N/A";
      }

      // Add Speed if available
      if (gps.speed.isValid()) {
        gpsLines[lineCount++] = "Spd: " + String(gps.speed.kmph(), 1) + "km/h";
      } else {
        gpsLines[lineCount++] = "Spd: N/A";
      }

      // Add Course if available
      if (gps.course.isValid()) {
        gpsLines[lineCount++] = "Course: " + String(gps.course.deg(), 1);
      } else {
        gpsLines[lineCount++] = "Course: N/A";
      }

    } else {
      gpsLines[lineCount++] = "Lat: N/A";
      gpsLines[lineCount++] = "Lng: N/A";
      gpsLines[lineCount++] = "Sats: N/A";
      gpsLines[lineCount++] = "Alt: N/A";
      gpsLines[lineCount++] =
          "HDOP: N/A"; // Also show N/A if location is invalid
      gpsLines[lineCount++] = "Spd: N/A";
      gpsLines[lineCount++] = "Course: N/A";
    }

    if (gps.date.isValid() && gps.time.isValid()) {
      // Ensure we don't exceed array bounds if date/time is valid but other
      // fields pushed it
      if (lineCount < 8)
        gpsLines[lineCount++] = "Date: " + String(gps.date.year()) + "-" +
                                String(gps.date.month()) + "-" +
                                String(gps.date.day());
      if (lineCount < 9)
        gpsLines[lineCount++] = "Time: " + String(gps.time.hour()) + ":" +
                                String(gps.time.minute()) + ":" +
                                String(gps.time.second());
    } else {
      // Ensure we don't exceed array bounds if date/time is also invalid
      if (lineCount < 8)
        gpsLines[lineCount++] = "Date: N/A";
      if (lineCount < 9)
        gpsLines[lineCount++] = "Time: N/A";
    }

    displayInfo(gpsLines, lineCount);
  } else if (now > 5000 && gps.sentencesWithFix() == 0 &&
             (now - lastGpsDisplayUpdate > 2000)) {
    // If no fix after 5 seconds, show message periodically
    lastGpsDisplayUpdate = now; // Prevent spamming the message
    String noFixMsg[] = {"No GPS fix.", "Check antenna", "and wiring."};
    displayInfo(noFixMsg, 3);
  }
}

// --- Button Action Handler ---
// This function is called when a valid button hold is detected.
void onButtonHeld() {
  Serial.println("Button Held Action Triggered!");
  // --- Add your button press action here ---
  String btnMsg[] = {"Button Held!"};
  displayInfo(btnMsg, 1);
  delay(500); // Show message briefly (consider making this non-blocking if
              // needed)
  lastGpsDisplayUpdate = 0; // Force GPS display update after button message
  // ----------------------------------------
}
// ---------------------------

// Forward declaration for button handler
void onButtonHeld();

// Function to handle button press with debounce and hold duration requirement
void handleButton() {
  int reading = digitalRead(BUTTON_PIN);
  bool stateChanged = false; // Declare stateChanged here

  // --- Debounce Logic ---
  // If the reading is different than the last reading, reset the debounce timer
  if (reading != lastButtonState) {
    lastButtonCheckTime = millis();
  }

  // Check if the state has been stable for longer than the debounce delay
  if ((millis() - lastButtonCheckTime) > DEBOUNCE_DELAY) {
    // If the stable reading is different from the current debounced state
    if (reading != currentButtonState) {
      currentButtonState = reading; // Update the debounced state
      stateChanged = true;          // Mark that the state has changed
    }
  }
  lastButtonState = reading; // Remember the last raw reading for next time

  // --- State Machine based on Debounced State ---
  if (stateChanged) { // Only act when the debounced state changes
    if (currentButtonState == LOW) {
      // Button just pressed (transition from HIGH to LOW after debounce)
      pressStartTime = millis(); // Record the time the stable press started
      actionTriggeredForPress =
          false; // Reset the action trigger flag for this new press
      Serial.println("Button Press Detected (Debounced)");
    } else {
      // Button just released (transition from LOW to HIGH after debounce)
      Serial.println("Button Released (Debounced)");
      pressStartTime = 0;              // Reset press start time
      actionTriggeredForPress = false; // Reset action trigger flag
    }
  }

  // --- Check for Hold Duration and Trigger Action ---
  // If the button is currently debounced as pressed, a press start time is
  // recorded, and the action hasn't been triggered yet for this press...
  if (currentButtonState == LOW && pressStartTime > 0 &&
      !actionTriggeredForPress) {
    // Check if the button has been held for the required duration
    if (millis() - pressStartTime >= HOLD_DURATION) {
      onButtonHeld(); // Call the dedicated handler function
      actionTriggeredForPress =
          true; // Mark action as triggered for this press cycle
    }
  }
}

void setup() {
  // Initialize Serial communication (for debugging)
  Serial.begin(115200);
  // Wait for Serial port to connect. Needed for native USB port only
  // while (!Serial); // Comment out or remove if causing issues

  Serial.println("Starting GPS Tracker...");

  // Initialize I2C (needed for SSD1306)
  Wire.begin();

  // Initialize OLED display
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("SSD1306 allocation failed"));
    // Don't halt, just print to Serial if OLED fails
  } else {
    Serial.println(F("SSD1306 Initialized"));
    display.display(); // show splash screen (Adafruit logo)
    delay(500);        // Pause
    display.clearDisplay();
    display.println("OLED Initialized");
    display.display();
    delay(500);
  }

  // Initialize GPS Serial
  // L76K default baud rate is usually 9600
  // Pins are defined in variant.h (PIN_SERIAL1_RX, PIN_SERIAL1_TX)
  gpsSerial.begin(9600); // Remove pin arguments
  Serial.println("GPS Serial Initialized (Serial1)");

  // Initialize Button Pin
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.println("Button Pin Initialized");

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

  String initMsg[] = {"System Initialized", "Waiting for GPS..."};
  displayInfo(initMsg, 2);
}

void loop() {
  handleGPS();    // Call GPS handler
  handleButton(); // Call Button handler

  // The small delay might not be necessary anymore as handleGPS only updates
  // display periodically and handleButton includes debounce logic.
  // You can remove or adjust this delay if needed.
  // delay(10);
}
