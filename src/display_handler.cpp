#include "display_handler.h"
#include "config.h"
#include <Arduino.h> // For Serial

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
  display.println("OLED Initialized");
  display.display();
  delay(500);
  return true;
}

// Helper function to print multiple lines to OLED and Serial
void displayInfo(const String lines[], int numLines) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);

  Serial.println("--- Display Update ---");
  for (int i = 0; i < numLines; ++i) {
    // Basic check to prevent writing off-screen vertically
    if (display.getCursorY() < SCREEN_HEIGHT) {
      display.println(lines[i]);
    }
    Serial.println(lines[i]);
  }
  Serial.println("----------------------");

  display.display();
}
