#include "ble_handler.h"
#include "file_transfer_protocol.h"
#include <InternalFileSystem.h>

// BLE Services
BLEDis bledis; // Device Information Service
BLEUart bleuart;
// BLEBas blebas; // Battery Service
static FileTransferProtocol
    fileTransferProtocol(&bleuart); // File Transfer Protocol
// File transfer state variables
static Adafruit_LittleFS_Namespace::File
    currentFile(InternalFS); // File object for the active transfer
static uint16_t negotiatedMtuPayloadSize = BLE_DEFAULT_MTU_PAYLOAD;

// --- Helper Functions ---

void BleHandler::connect_callback(uint16_t conn_handle) {
  Log.print("BLE: Client connected, conn_handle =");
  Log.print(conn_handle);

  BLEConnection *conn = Bluefruit.Connection(conn_handle);
  if (conn) {
    // Adafruit Bluefruit nRF52 library typically negotiates MTU automatically.
    // Default is often 23 bytes (payload 20). Max can be up to 247 (payload
    // 244) for nRF52840. We get the negotiated MTU here.
    conn->requestPHY();
    conn->requestDataLengthUpdate();
    conn->requestMtuExchange(247); // Request max MTU
    delay(1000);                   // Wait for MTU exchange to complete
    uint16_t mtu = conn->getMtu();
    negotiatedMtuPayloadSize = mtu - 3; // 3 bytes for ATT header
    Log.print("BLE: Negotiated MTU:");
    Log.print(mtu);
    Log.print("BLE: Negotiated MTU payload size:");
    Log.print(negotiatedMtuPayloadSize);
  }
}

void BleHandler::disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  Log.printf("BLE: Client disconnected, conn_handle = %d, reason = 0x%02X",
             conn_handle, reason);
  negotiatedMtuPayloadSize = BLE_DEFAULT_MTU_PAYLOAD; // Reset to default
}

void bleuart_rx_callback(uint16_t conn_hdl) { fileTransferProtocol.process(); }

void bleuart_notify_callback(uint16_t conn_hdl, bool enabled) {
  if (enabled) {
    Log.println("Send a key and press enter to start test");
  }
}

namespace BleHandler {

// Helper function to start advertising
void startAdv(void) {
  // Advertising packet
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
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
  Bluefruit.Advertising.start(30); // 30 = stop advertising after 30 seconds
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
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  if (!Bluefruit.begin()) {
    Log.print("BLE: ERROR - Failed to initialize Bluefruit stack!");
    return false; // Critical failure
  }
  Log.print("BLE: Bluefruit stack initialized successfully.");
  Bluefruit.setTxPower(4); // Check documentation for valid power levels
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);
  Bluefruit.Periph.setConnInterval(6, 12);

  bleuart.begin();

  bleuart.setRxCallback(bleuart_rx_callback);
  bleuart.setNotifyCallback(bleuart_notify_callback);
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
