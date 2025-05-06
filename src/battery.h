#ifndef BATTERY_H
#define BATTERY_H

#include <Arduino.h>
#include <stdint.h>
/**
 * @brief Initializes the ADC for battery voltage reading.
 *
 * Sets the analog reference and resolution based on variant definitions.
 */
void initBattery();

/**
 * @brief Reads the battery voltage.
 *
 * Reads the raw ADC value from the battery pin and converts it to millivolts
 * using the scaling factors defined in the variant file.
 *
 * @return The battery voltage in millivolts (mV). Returns 0 if the pin is not
 * defined.
 */
uint32_t readBatteryVoltageMv();

void updateBatteryInfo(
    TimerHandle_t handle); // Function to handle battery reading and updates

/**
 * @brief Estimates battery level using floating point calculations.
 *
 * @param voltageMv The battery voltage in millivolts.
 * @return Float battery level percentage between 0.0 and 100.0.
 */
float estimateBatteryLevel(float voltageMv);

#endif // BATTERY_H
