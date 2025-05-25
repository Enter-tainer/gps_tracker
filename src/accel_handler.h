#ifndef ACCEL_HANDLER_H
#define ACCEL_HANDLER_H
#include "i2c_lock.h"
#include <Arduino.h>
#include <LIS3DHTR.h>

class AccelHandler {
public:
  AccelHandler();
  bool begin(uint8_t addr = 0x19);
  void update();
  void get(float *x, float *y, float *z) const;
  float getTotal() const;
  bool isOk() const;

private:
  LIS3DHTR<TwoWire> lis;
  bool ok;
  float last_x, last_y, last_z;
};

extern AccelHandler accelHandler;

#endif // ACCEL_HANDLER_H
