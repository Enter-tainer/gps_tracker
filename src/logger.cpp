#include "logger.h"

// Define the global Logger instance, initializing with Serial
// You might want to make the specific Serial port and baud rate configurable
Logger Log(Serial, 115200);

Logger::Logger(Adafruit_USBD_CDC &serial, long baudRate)
    : serial_(&serial), baudRate_(baudRate), enabled_(true) {}

void Logger::begin() {
  if (serial_) {
    serial_->begin(baudRate_);
  }
}

void Logger::setEnabled(bool enabled) { enabled_ = enabled; }

bool Logger::isEnabled() { return enabled_; }
