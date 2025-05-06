#ifndef BLE_HANDLER_H
#define BLE_HANDLER_H

#include "littlefs_handler.h" // For InternalFS and File object
#include "logger.h"           // For logging
#include "system_info.h" // For SYSTEM_INFO_FW_VERSION (optional for device name)
#include <bluefruit.h>

// --- UUIDs for File Transfer Service ---
// You should generate your own unique UUIDs for a production application.
// These are example UUIDs.
// Service UUID: e.g., use "uuidgen" tool
#define UUID_SVC_FILE_TRANSFER "4a98bdbd-e8f5-4476-a52c-8e10e5024df5"
// Characteristic UUIDs:
#define UUID_CHR_CONTROL_POINT                                                 \
  "4a980001-e8f5-4476-a52c-8e10e5024df5" // For commands
#define UUID_CHR_DATA_TRANSFER                                                 \
  "4a980002-e8f5-4476-a52c-8e10e5024df5" // For data transfer

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
