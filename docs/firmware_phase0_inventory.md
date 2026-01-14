# Phase 0 Inventory (Legacy Firmware)

Purpose: capture a 1:1 map of legacy firmware modules, pins, and scope
decisions to guide the Rust/Embassy port without changing behavior.

## Module map (legacy C++ -> responsibilities)
- `src/main.cpp`: initialization order, main loop, and cross-module wiring.
- `src/gps_handler.*`: GPS state machine, power control, AGNSS timing, updates
  `gSystemInfo`, triggers GPX logging.
- `src/casic_gps_wrapper.*`: CASIC protocol parser + TinyGPS++ bridge.
- `src/gpx_logger.*`: GPX data encoding (full/delta blocks) and append logic.
- `src/sd_handler.*`: GPX file rotation, cache buffer, delete old files.
- `src/sd_fs_handler.*`: unified SD filesystem API (uses SdFat).
- `src/file_transfer_protocol.*`: BLE UART protocol for file transfer and
  system info.
- `src/ble_handler.*`: Bluefruit BLE stack, UART service, device name,
  connection/MTU negotiation.
- `src/accel_handler.*`: LIS3DHTR I2C driver and sampling.
- `src/accel_analyzer.*`: stillness/jump detection.
- `src/bmp280_handler.*`: BMP280 sensor driver and sampling.
- `src/display_handler.*`: SSD1306 display updates.
- `src/battery.*`: ADC sampling and battery voltage scaling.
- `src/button_handler.*`: button debounce and events.
- `src/logger.*`: serial logging with a mutex.
- `src/system_info.h`: `SystemInfo` data model used by BLE responses.
- `src/littlefs_handler.*`: internal flash FS (out of scope per current plan).

## Pin map (variant.h -> Embassy)
- LED: P0.15 -> `p.P0_15`
- Button: P1.00 -> `p.P1_00`
- GPS UART:
  - MCU RX (GPS_TX): P0.22 -> `p.P0_22`
  - MCU TX (GPS_RX): P0.20 -> `p.P0_20`
  - GPS EN: P0.24 -> `p.P0_24`
- I2C:
  - SDA: P1.04 -> `p.P1_04`
  - SCL: P0.11 -> `p.P0_11`
- SPI (SD card):
  - MISO: P0.02 -> `p.P0_02`
  - MOSI: P1.15 -> `p.P1_15`
  - SCK: P1.11 -> `p.P1_11`
  - CS:  P1.13 -> `p.P1_13` (uses `LORA_CS` in legacy code)
- Battery ADC: P0.31 -> `p.P0_31` (scale per variant.h constants)
- 3V3_EN: P0.13 -> `p.P0_13`
- Serial2 (unused today): RX P0.06, TX P0.08
- LoRa pins: ignore for this port (no LoRa support).

## Scope decisions (P0)
- Storage: SD card only; internal flash FS (LittleFS) is out of scope.
- Accelerometer: LIS3DH only (I2C).
- BMP280: keep same sensor behavior, use Rust driver crate.
- A-GNSS: keep protocol and timing semantics identical to legacy.
