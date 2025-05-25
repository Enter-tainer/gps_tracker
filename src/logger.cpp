#include "logger.h"
#include <Arduino.h>
#include <FreeRTOS.h>
#include <semphr.h>

Logger Log(Serial, 115200);

Logger::Logger(Adafruit_USBD_CDC &serial, long baudRate)
    : serial_(&serial), baudRate_(baudRate), enabled_(true), mutex_(NULL) {}

void Logger::begin() {
  if (mutex_ == NULL) {
    mutex_ = xSemaphoreCreateMutex();
  }
  if (serial_) {
    serial_->begin(baudRate_);
  }
}

void Logger::setEnabled(bool enabled) { enabled_ = enabled; }

bool Logger::isEnabled() { return enabled_; }

void Logger::lock() {
  if (mutex_ == NULL) {
    mutex_ = xSemaphoreCreateMutex();
  }
  xSemaphoreTake(mutex_, portMAX_DELAY);
}

void Logger::unlock() { xSemaphoreGive(mutex_); }
