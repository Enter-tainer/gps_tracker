#include "button_handler.h"
#include "config.h"
#include "display_handler.h" // For toggling display
#include "gps_handler.h"     // For resetting GPS update timer
#include "littlefs_handler.h"
#include "logger.h"
#include <Arduino.h>

// Button state variables
static unsigned long lastValidInterruptTime = 0; // ADDED
bool currentButtonState = HIGH;                  // Debounced state
unsigned long pressStartTime =
    0; // Time when the button press started (after debounce)
bool actionTriggeredForPress =
    false; // Flag to ensure action triggers only once per press

void initButton() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Log.println("Button Pin Initialized");
  attachInterrupt(BUTTON_PIN, handleButton, FALLING);
}

void onButtonPushed() {
  Log.println("Button Held Action Triggered!");
  listInternalFlashContents(); // List files on button press
  resetDisplayTimeout(); // Reset display timeout
  toggleDisplay();       // Toggle display on press
}

// Function to handle button press with debounce and hold duration requirement
void handleButton() {
  unsigned long currentTime = millis();

  // New debounce logic: if an interrupt occurs too soon after the last one
  // that was allowed to proceed, ignore this current interrupt.
  if (currentTime - lastValidInterruptTime < DEBOUNCE_DELAY) {
    return; // Ignore this interrupt
  }
  // This interrupt is not being ignored due to rate-limiting.
  // Mark this time as the last time an interrupt was processed.
  lastValidInterruptTime = currentTime;

  onButtonPushed();
}
