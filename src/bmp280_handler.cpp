#include "bmp280_handler.h"
#include "i2c_lock.h"
#include "logger.h"

BMP280Handler bmp280Handler;

BMP280Handler::BMP280Handler()
    : ok(false), lastAltitude(0), lastTemperature(0), lastPressure(0) {}

bool BMP280Handler::begin(uint8_t addr) {
  {
    I2C_LockGuard lock;
    ok = bmp280.begin(addr);
  }
  if (ok) {
    Log.println("BMP280 初始化成功");
  } else {
    Log.println("BMP280 初始化失败");
  }
  return ok;
}

void BMP280Handler::update() { updateInternal(); }

void BMP280Handler::updateInternal() {
  if (!ok)
    return;
  {
    I2C_LockGuard lock;
    lastTemperature = bmp280.readTemperature();
    lastPressure = bmp280.readPressure();
    lastAltitude = bmp280.readAltitude(1017.9); // 标准大气压
  }
  // Log.print("[BMP280] 温度: ");
  // Log.print(lastTemperature);
  // Log.print(" C, 气压: ");
  // Log.print(lastPressure / 100.0);
  // Log.print(" hPa, 海拔: ");
  // Log.print(lastAltitude);
  // Log.println(" m");
}

float BMP280Handler::getAltitude() const { return lastAltitude; }
float BMP280Handler::getTemperature() const { return lastTemperature; }
float BMP280Handler::getPressure() const { return lastPressure; }
bool BMP280Handler::isOk() const { return ok; }
