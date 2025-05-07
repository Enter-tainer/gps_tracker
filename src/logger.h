#ifndef LOGGER_H
#define LOGGER_H

#include <Arduino.h>

class Logger {
public:
  Logger(Adafruit_USBD_CDC &serial, long baudRate);
  void begin();
  void setEnabled(bool enabled);
  bool isEnabled();

  template <typename T> void print(T message) {
    if (enabled_ && serial_) {
      serial_->print(message);
    }
  }

  template <typename T> void println(T message) {
    if (enabled_ && serial_) {
      serial_->println(message);
    }
  }

  // Overload for char arrays
  void print(const char *message) {
    if (enabled_ && serial_) {
      serial_->print(message);
    }
  }

  void println(const char *message) {
    if (enabled_ && serial_) {
      serial_->println(message);
    }
  }

  void printf(const char *format, ...) {
    if (enabled_ && serial_) {
      char buf[256]; // 缓冲区用于格式化字符串
      va_list args;
      va_start(args, format);
      vsnprintf(buf, sizeof(buf), format,
                args); // 使用 vsnprintf 格式化字符串到缓冲区
      va_end(args);
      serial_->print(buf); // 输出格式化后的字符串
    }
  }

private:
  Adafruit_USBD_CDC *serial_;
  long baudRate_;
  bool enabled_;
};

extern Logger Log; // Declare a global Logger instance

#endif // LOGGER_H
