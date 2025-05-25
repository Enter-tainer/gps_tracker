#include "i2c_lock.h"
#include <Arduino.h>
#include <FreeRTOS.h>
#include <semphr.h>

static SemaphoreHandle_t i2c_mutex = NULL;

static void i2c_lock_init() {
  if (i2c_mutex == NULL) {
    i2c_mutex = xSemaphoreCreateMutex();
  }
}

void i2c_lock() {
  i2c_lock_init();
  xSemaphoreTake(i2c_mutex, portMAX_DELAY);
}

void i2c_unlock() { xSemaphoreGive(i2c_mutex); }
