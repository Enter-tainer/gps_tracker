#include "button_handler.h"
#include "config.h"
#include "display_handler.h" // For displaying button message
#include "gps_handler.h"     // For resetting GPS update timer
#include <Arduino.h>

// Button state variables
unsigned long lastButtonCheckTime = 0;
bool lastButtonState = HIGH;    // Assuming INPUT_PULLUP, HIGH is released
bool currentButtonState = HIGH; // Debounced state
unsigned long pressStartTime =
    0; // Time when the button press started (after debounce)
bool actionTriggeredForPress =
    false; // Flag to ensure action triggers only once per press

// Function to initialize the button pin
void initButton() {
// BUTTON_PIN should be defined in variant.h or config.h
#ifdef BUTTON_PIN
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.println("Button Pin Initialized");
#else
  Serial.println("WARNING: BUTTON_PIN not defined!");
#endif
}

// --- Button Action Handler ---
// This function is called when a valid button hold is detected.
void onButtonHeld() { Serial.println("Button Held Action Triggered!"); }

// Function to handle button press with debounce and hold duration requirement
void handleButton() {
#ifdef BUTTON_PIN // Only run if button pin is defined
  int reading = digitalRead(BUTTON_PIN);
  bool stateChanged = false;

  // --- Debounce Logic ---
  if (reading != lastButtonState) {
    lastButtonCheckTime = millis();
  }

  if ((millis() - lastButtonCheckTime) > DEBOUNCE_DELAY) {
    if (reading != currentButtonState) {
      currentButtonState = reading;
      stateChanged = true;
    }
  }
  lastButtonState = reading;

  // --- State Machine based on Debounced State ---
  if (stateChanged) {
    if (currentButtonState == LOW) { // Button pressed
      pressStartTime = millis();
      actionTriggeredForPress = false;
      Serial.println("Button Press Detected (Debounced)");
    } else { // Button released
      Serial.println("Button Released (Debounced)");
      pressStartTime = 0;
      actionTriggeredForPress = false;
    }
  }

  // --- Check for Hold Duration and Trigger Action ---
  if (currentButtonState == LOW && pressStartTime > 0 &&
      !actionTriggeredForPress) {
    if (millis() - pressStartTime >= HOLD_DURATION) {
      onButtonHeld();
      actionTriggeredForPress = true;
    }
  }
#endif // BUTTON_PIN
}
