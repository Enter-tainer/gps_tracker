#ifndef LOGGER_H
#define LOGGER_H

#include <Arduino.h>
#include <FreeRTOS.h>
#include <semphr.h>

class Logger {
public:
  Logger(Adafruit_USBD_CDC &serial, long baudRate);
  void begin();
  void setEnabled(bool enabled);
  bool isEnabled();

  template <typename T> void print(T message) {
    lock();
    if (enabled_ && serial_) {
      serial_->print(message);
    }
    unlock();
  }

  template <typename T> void println(T message) {
    lock();
    if (enabled_ && serial_) {
      serial_->println(message);
    }
    unlock();
  }

  // Overload for char arrays
  void print(const char *message) {
    lock();
    if (enabled_ && serial_) {
      serial_->print(message);
    }
    unlock();
  }

  void println(const char *message) {
    lock();
    if (enabled_ && serial_) {
      serial_->println(message);
    }
    unlock();
  }

  void printf(const char *format, ...) {
    lock();
    if (enabled_ && serial_) {
      char buf[256]; // 缓冲区用于格式化字符串
      va_list args;
      va_start(args, format);
      vsnprintf(buf, sizeof(buf), format, args);
      va_end(args);
      serial_->print(buf);
    }
    unlock();
  }

private:
  void lock();
  void unlock();
  SemaphoreHandle_t mutex_ = NULL;
  Adafruit_USBD_CDC *serial_;
  long baudRate_;
  bool enabled_;
};

extern Logger Log; // Declare a global Logger instance

#endif // LOGGER_H
