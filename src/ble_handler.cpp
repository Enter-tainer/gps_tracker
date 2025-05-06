#include "ble_handler.h"
#include <InternalFileSystem.h>

// BLE Services
BLEDis bledis; // Device Information Service

// BLE Service and Characteristic definitions
BLEService fileTransferService(UUID_SVC_FILE_TRANSFER);
BLECharacteristic controlPointChar(UUID_CHR_CONTROL_POINT);
BLECharacteristic dataChar(UUID_CHR_DATA_TRANSFER);

// File transfer state variables
static Adafruit_LittleFS_Namespace::File
    currentFile(InternalFS); // File object for the active transfer
static bool transferInProgress = false;
static uint32_t totalFileSize = 0;
static uint32_t bytesTransferred = 0;
static char currentFilename[MAX_FILENAME_LEN + 1];
static uint16_t negotiatedMtuPayloadSize = BLE_DEFAULT_MTU_PAYLOAD;

// --- Helper Functions ---

/**
 * @brief Sends a data chunk over the DataCharacteristic.
 * @param conn_handle Connection handle.
 * @param data Pointer to the data buffer.
 * @param len Length of the data to send.
 */
static void send_data_chunk_ble(uint16_t conn_handle, const uint8_t *data,
                                uint16_t len) {
  if (Bluefruit.connected(conn_handle)) {
    if (!dataChar.notify(data, len)) {
      Log.print("BLE: DataChar notify failed, buffer likely full.");
      // Consider adding more sophisticated flow control if this happens often
    }
  }
}

/**
 * @brief Sends a null-terminated string over the DataCharacteristic.
 * @param conn_handle Connection handle.
 * @param str The string to send.
 */
static void send_string_ble(uint16_t conn_handle, const char *str) {
  send_data_chunk_ble(conn_handle, (const uint8_t *)str, strlen(str));
}

/**
 * @brief Resets the file transfer state.
 * @param close_file If true, closes the currentFile if it's open.
 */
static void reset_transfer_state(bool close_file) {
  if (close_file && currentFile) {
    currentFile.close();
  }
  transferInProgress = false;
  totalFileSize = 0;
  bytesTransferred = 0;
  memset(currentFilename, 0, sizeof(currentFilename));
  Log.print("BLE: Transfer state reset.");
}

// --- BLE Callback Implementations ---

void BleHandler::control_point_write_callback(uint16_t conn_handle,
                                              BLECharacteristic *chr,
                                              uint8_t *data, uint16_t len) {
  if (len == 0) {
    Log.print("BLE CtrlPt: Empty command received.");
    return;
  }

  uint8_t command = data[0];
  Log.printf("BLE CtrlPt: RX cmd 0x%02X, len %d", command, len);

  switch (command) {
  case 0x01: // LIST_FILES
  {
    Log.print("BLE: LIST_FILES command received.");
    if (transferInProgress) {
      Log.print("BLE: Cannot list files, transfer in progress. Abort first.");
      send_string_ble(conn_handle, "ERROR:TransferInProgress");
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF marker
      return;
    }

    auto root = InternalFS.open("/");
    if (!root) {
      Log.print("BLE: Failed to open root directory for listing.");
      send_string_ble(conn_handle, "ERROR:CannotOpenRootDir");
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF marker
      return;
    }
    if (!root.isDirectory()) {
      Log.print("BLE: Root is not a directory.");
      send_string_ble(conn_handle, "ERROR:RootNotDir");
      root.close();
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF marker
      return;
    }

    auto entry = root.openNextFile();
    bool file_found = false;
    while (entry) {
      if (!entry.isDirectory()) { // List only files
        Log.printf("BLE: Listing file: %s (size: %lu)", entry.name(),
                   entry.size());
        // Format: filename:size
        char file_entry_str[MAX_FILENAME_LEN + 1 + 1 + 10 +
                            1]; // name + : + size_str + null
        snprintf(file_entry_str, sizeof(file_entry_str), "%s:%lu", entry.name(),
                 entry.size());
        send_string_ble(conn_handle, file_entry_str);
        file_found = true;
        // A small delay can help if sending many filenames rapidly,
        // but proper client-side request for next batch is better for very long
        // lists.
        delay(20);
      }
      entry.close();
      entry = root.openNextFile();
    }
    root.close();

    if (!file_found) {
      Log.print("BLE: No files found to list.");
      // send_string_ble(conn_handle, "INFO:NoFiles"); // Optional: inform
      // client
    }
    send_data_chunk_ble(conn_handle, NULL, 0); // EOF marker for list
    Log.print("BLE: LIST_FILES complete.");
    break;
  }
  case 0x02: // START_TRANSFER <filename_null_terminated>
  {
    if (transferInProgress) {
      Log.print(
          "BLE: START_TRANSFER failed, another transfer already in progress.");
      // Optionally send an error code back via an indicatable characteristic if
      // implemented
      return;
    }
    // Command (1 byte) + filename (at least 1 char) + null terminator (1 byte)
    if (len < 3) {
      Log.print("BLE: START_TRANSFER command too short for filename and null "
                "terminator.");
      return;
    }

    uint16_t filename_len = len - 2; // Actual characters in filename (excluding
                                     // command and its null term)
    if (filename_len > MAX_FILENAME_LEN) {
      Log.printf("BLE: START_TRANSFER: Filename length %d exceeds max %d.",
                 filename_len, MAX_FILENAME_LEN);
      return;
    }
    memcpy(currentFilename, (const char *)&data[1], filename_len);
    currentFilename[filename_len] = '\0';

    Log.printf("BLE: START_TRANSFER command for file: '%s'", currentFilename);

    if (currentFile) {
      currentFile.close();
    } // Should not be needed if state is managed well

    currentFile = InternalFS.open(currentFilename,
                                  Adafruit_LittleFS_Namespace::FILE_O_READ);

    if (currentFile) {
      totalFileSize = currentFile.size();
      bytesTransferred = 0;
      transferInProgress = true;
      Log.printf("BLE: File '%s' opened. Size: %lu bytes. Ready for chunks.",
                 currentFilename, totalFileSize);
      // Client should now send GET_CHUNK.
      // Optionally, send success/file size via ControlPointChar.indicate() if
      // it were configured. For now, we can send the file size as the first
      // "data" packet if desired, or client just starts requesting chunks.
      // Let's send file size as a special first message on dataChar for
      // simplicity:
      char size_msg[32];
      snprintf(size_msg, sizeof(size_msg), "SIZE:%lu", totalFileSize);
      send_string_ble(conn_handle, size_msg);

    } else {
      Log.printf("BLE: Failed to open file: '%s'", currentFilename);
      reset_transfer_state(false); // Don't close, it's not open
      send_string_ble(conn_handle, "ERROR:FileOpenFailed"); // Inform client
    }
    break;
  }
  case 0x03: // GET_CHUNK
  {
    if (!transferInProgress || !currentFile) {
      Log.print("BLE: GET_CHUNK received but no transfer in progress or file "
                "not open.");
      send_data_chunk_ble(conn_handle, NULL,
                          0); // Send empty packet to signify error/EOF
      return;
    }

    if (bytesTransferred >= totalFileSize) {
      Log.printf("BLE: GET_CHUNK - EOF already reached for '%s'.",
                 currentFilename);
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF
      // File is kept open until ABORT or new START_TRANSFER or disconnect
      return;
    }

    uint8_t chunkBuffer[negotiatedMtuPayloadSize];
    int bytesToRead = min((uint32_t)negotiatedMtuPayloadSize,
                          totalFileSize - bytesTransferred);

    int readCount = currentFile.read(chunkBuffer, bytesToRead);

    if (readCount > 0) {
      send_data_chunk_ble(conn_handle, chunkBuffer, readCount);
      bytesTransferred += readCount;
      // Log.printf("BLE: Sent chunk, %d bytes. Total sent: %lu/%lu for '%s'",
      // readCount, bytesTransferred, totalFileSize, currentFilename);
      if (bytesTransferred >= totalFileSize) {
        Log.printf("BLE: File transfer complete for '%s'. Total: %lu bytes.",
                   currentFilename, bytesTransferred);
        // Client detects EOF when next GET_CHUNK returns 0 bytes or by tracking
        // total size. We can send an explicit EOF marker after the last data
        // chunk. send_data_chunk_ble(conn_handle, NULL, 0); // Optional
        // explicit EOF after last data.
      }
    } else if (readCount == 0) { // EOF reached during this read attempt
      Log.printf("BLE: GET_CHUNK - EOF reached while reading file '%s'.",
                 currentFilename);
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF
    } else {                                     // Error reading from file
      Log.printf("BLE: Error reading file chunk for '%s'. Aborting transfer.",
                 currentFilename);
      send_string_ble(conn_handle, "ERROR:FileReadError");
      send_data_chunk_ble(conn_handle, NULL, 0); // EOF/Error marker
      reset_transfer_state(true);
    }
    break;
  }
  case 0x04: // ABORT_TRANSFER
  {
    Log.print("BLE: ABORT_TRANSFER command received.");
    if (transferInProgress) {
      Log.printf("BLE: Aborting transfer of file '%s'.", currentFilename);
    }
    reset_transfer_state(true);
    // Optionally send an ACK for abort via ControlPointChar.indicate()
    send_string_ble(conn_handle, "INFO:TransferAborted");
    break;
  }
  default:
    Log.printf("BLE: Unknown command received on ControlPoint: 0x%02X",
               command);
    break;
  }
}

void BleHandler::connect_callback(uint16_t conn_handle) {
  Log.print("BLE: Client connected, conn_handle =");
  Log.print(conn_handle);

  BLEConnection *conn = Bluefruit.Connection(conn_handle);
  if (conn) {
    // Adafruit Bluefruit nRF52 library typically negotiates MTU automatically.
    // Default is often 23 bytes (payload 20). Max can be up to 247 (payload
    // 244) for nRF52840. We get the negotiated MTU here.
    uint16_t mtu = conn->getMtu();
    negotiatedMtuPayloadSize = mtu - 3; // 3 bytes for ATT header
    Log.print("BLE: Negotiated MTU:");
    Log.print(mtu);
    Log.print("BLE: Negotiated MTU payload size:");
    Log.print(negotiatedMtuPayloadSize);

    // Update DataCharacteristic max length if needed, though dynamic sizing of
    // notify is key. dataChar.setMaxLen(negotiatedMtuPayloadSize); // This
    // might not be necessary as notify() takes length.
  }
  // Reset any lingering transfer state from a previous abrupt disconnect if not
  // handled by disconnect_callback
  if (transferInProgress) {
    Log.print(
        "BLE Connect: Previous transfer was in progress, resetting state.");
    reset_transfer_state(true);
  }
}

void BleHandler::disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  Log.printf("BLE: Client disconnected, conn_handle = %d, reason = 0x%02X",
             conn_handle, reason);
  if (transferInProgress) {
    Log.print("BLE Disconnect: Transfer was in progress, aborting.");
  }
  reset_transfer_state(true);
  negotiatedMtuPayloadSize = BLE_DEFAULT_MTU_PAYLOAD; // Reset to default
}

namespace BleHandler {

// Helper function to start advertising
void startAdv(void) {
  // Advertising packet
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();

  // Include File Transfer Service UUID
  Bluefruit.Advertising.addService(fileTransferService);

  // Include Name
  // Construct a dynamic device name with part of the firmware version if
  // desired char device_name[32]; snprintf(device_name, sizeof(device_name),
  // "GPS Tracker %s", SYSTEM_INFO_FW_VERSION);
  // Bluefruit.Advertising.addName(device_name);
  Bluefruit.Advertising
      .addName(); // Use default name from config.h or auto-generated

  /* Start Advertising
   * - Enable auto advertising if disconnected
   * - Interval:  fast mode = 20 ms, slow mode = 152.5 ms
   * - Timeout for fast mode is 30 seconds
   * - Start(timeout) with timeout = 0 will advertise forever (until connected)
   *
   * For recommended advertising interval
   * https://developer.apple.com/library/content/qa/qa1931/_index.html
   */
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244); // in unit of 0.625 ms
  Bluefruit.Advertising.setFastTimeout(30);   // number of seconds in fast mode
  Bluefruit.Advertising.start(0); // 0 = Don't stop advertising after n seconds
  Log.print("BLE: Advertising started.");
}

/**
 * @brief Initializes the BLE stack, services, characteristics, and starts
 * advertising.
 * @return true if BLE setup was successful, false otherwise.
 */
bool setup() { // Modified to return bool
  Log.print("BLE: Initializing File Transfer Handler...");

  // Initialize Bluefruit Central library
  Log.print("BLE: Initializing Bluefruit stack...");
  if (!Bluefruit.begin()) {
    Log.print("BLE: ERROR - Failed to initialize Bluefruit stack!");
    return false; // Critical failure
  }
  Log.print("BLE: Bluefruit stack initialized successfully.");
  Bluefruit.setTxPower(4); // Check documentation for valid power levels
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);
  // Initialize File Transfer Service
  Log.print("BLE: Initializing File Transfer Service...");
  if (fileTransferService.begin() != 0) {
    Log.print("BLE: ERROR - Failed to initialize File Transfer Service!");
    return false;
  }

  // Configure Control Point Characteristic
  // Properties: Write, Write Without Response
  // Permissions: Writeable
  // Callback for writes
  controlPointChar.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  controlPointChar.setPermission(SECMODE_OPEN,
                                 SECMODE_OPEN); // Adjust security as needed
  controlPointChar.setWriteCallback(BleHandler::control_point_write_callback);
  controlPointChar.setMaxLen(MAX_FILENAME_LEN + 2); // Define if needed
  if (controlPointChar.begin() != 0) {
    Log.print(
        "BLE: ERROR - Failed to initialize Control Point Characteristic!");
    return false;
  }

  // Configure Data Characteristic
  // Properties: Notify
  // Permissions: Readable (for notify)
  // Max length should accommodate MTU payload size
  dataChar.setProperties(CHR_PROPS_NOTIFY);
  dataChar.setPermission(SECMODE_OPEN,
                         SECMODE_OPEN); // Adjust security as needed
  dataChar.setMaxLen(244);              // Set dynamically or to max
  // possible
  if (dataChar.begin() != 0) {
    Log.print("BLE: ERROR - Failed to initialize Data Characteristic!");
    return false;
  }
  Log.print("BLE: File Transfer Service and Characteristics initialized.");
  // Initialize Device Information Service
  Log.print("BLE: Initializing Device Information Service...");
  bledis.setManufacturer("Adafruit Industries"); // Example manufacturer
  bledis.setModel("MGT nRF52840 GPS Tracker");   // Example model
  if (bledis.begin() != 0) {
    Log.print("BLE: ERROR - Failed to initialize DIS!");
    return false;
  }
  Log.print("BLE: Device Information Service initialized.");

  // Start Advertising
  startAdv();

  Log.print("BLE: File Transfer Handler initialized successfully.");
  return true;
}

} // namespace BleHandler
