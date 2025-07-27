#ifndef BLE_HANDLER_H
#define BLE_HANDLER_H

#include "SdFat.h" // For SD card file operations
#include "logger.h"           // For logging
#include "system_info.h" // For SYSTEM_INFO_FW_VERSION (optional for device name)
#include <bluefruit.h>

#define MAX_FILENAME_LEN 64 // Maximum length for a filename
#define BLE_DEFAULT_MTU_PAYLOAD                                                \
  20 // Default BLE payload size before MTU negotiation

namespace BleHandler {

/**
 * @brief Initializes the BLE stack, services, characteristics, and starts
 * advertising.
 * @return true if BLE setup was successful, false otherwise.
 */
bool setup(); // Return bool to indicate success/failure

// BLE Connection Callbacks
void connect_callback(uint16_t conn_handle);
void disconnect_callback(uint16_t conn_handle, uint8_t reason);

// BLE Characteristic Callbacks
void control_point_write_callback(uint16_t conn_handle, BLECharacteristic *chr,
                                  uint8_t *data, uint16_t len);

} // namespace BleHandler

#endif // BLE_HANDLER_H
