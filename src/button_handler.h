#ifndef BUTTON_HANDLER_H
#define BUTTON_HANDLER_H

#include <Arduino.h>

// Function to initialize the button pin
void initButton();

// Function to handle button press with debounce and hold duration requirement
void handleButton();

// Function called when a valid button hold is detected (needs to be implemented
// by user or here)
void onButtonPushed();

#endif // BUTTON_HANDLER_H
