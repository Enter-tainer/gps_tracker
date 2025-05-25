#pragma once
#include <Arduino.h>

// I2C Lock API
void i2c_lock();
void i2c_unlock();

// RAII风格的I2C锁守卫
class I2C_LockGuard {
public:
  I2C_LockGuard() { i2c_lock(); }
  ~I2C_LockGuard() { i2c_unlock(); }
  // 禁止拷贝和赋值
  I2C_LockGuard(const I2C_LockGuard &) = delete;
  I2C_LockGuard &operator=(const I2C_LockGuard &) = delete;
};
