#ifndef BMP280_HANDLER_H
#define BMP280_HANDLER_H

#include <Adafruit_BMP280.h>
#include <Arduino.h>

class BMP280Handler {
public:
  BMP280Handler();
  bool begin(uint8_t addr = 0x76);
  void update();
  float getAltitude() const;
  float getTemperature() const;
  float getPressure() const;
  bool isOk() const;

private:
  void updateInternal();
  Adafruit_BMP280 bmp280;
  bool ok;
  float lastAltitude;
  float lastTemperature;
  float lastPressure;
};

extern BMP280Handler bmp280Handler;

#endif // BMP280_HANDLER_H
