#include "accel_handler.h"
#include "i2c_lock.h"
#include "logger.h"
#include <LIS3DHTR.h>
#include <Wire.h>

AccelHandler accelHandler;

AccelHandler::AccelHandler() : ok(false), last_x(0), last_y(0), last_z(0) {}

bool AccelHandler::begin(uint8_t addr) {
  I2C_LockGuard lock;
  lis.begin(Wire, addr);
  if (lis.isConnection()) {
    ok = true;
    Log.println("LIS3DHTR 初始化成功");
    lis.setOutputDataRate(LIS3DHTR_DATARATE_50HZ);
    lis.setHighSolution(true);
    lis.setFullScaleRange(LIS3DHTR_RANGE_2G);
  } else {
    ok = false;
    Log.println("LIS3DHTR 初始化失败");
  }
  return ok;
}

void AccelHandler::update() {
  if (!ok) {
    Log.println("LIS3DHTR 未初始化或连接失败，无法更新加速度数据");
    return;
  }
  float x, y, z;
  {
    I2C_LockGuard lock;
    lis.getAcceleration(&x, &y, &z);
  }
  last_x = x;
  last_y = y;
  last_z = z;
  float total = sqrt(x * x + y * y + z * z);
  // Log.print("LIS3DHTR 加速度: ");
  // Log.print(total);
  // Log.println(" g");
}

void AccelHandler::get(float *x, float *y, float *z) const {
  if (x)
    *x = last_x;
  if (y)
    *y = last_y;
  if (z)
    *z = last_z;
}

bool AccelHandler::isOk() const { return ok; }

float AccelHandler::getTotal() const {
  return sqrt(last_x * last_x + last_y * last_y + last_z * last_z);
}
