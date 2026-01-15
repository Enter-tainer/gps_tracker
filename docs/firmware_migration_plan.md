# Firmware Migration Plan (Arduino -> Rust/Embassy)

Purpose: Track work items to migrate legacy firmware in `src/` to the new
Rust/Embassy firmware in `firmware/`, targeting nRF52840 with no LoRa support.

## Scope and assumptions
- Target MCU: nRF52840 (no change).
- Radio: BLE only, no LoRa features.
- Migration target: `firmware/` Rust + Embassy + nrf-softdevice.
- Keep current hardware map from `boards/promicro_nrf52840/variants/promicro_diy/variant.h`.
- Accelerometer: LIS3DH only (no multi-sensor abstraction needed).
- BMP280: use a Rust crate driver if it provides feature parity.
- LittleFS: not required for the migration.

## Guiding principles
- 1:1 behavior with legacy firmware first, then optimize.
- Keep logic and timing equivalent unless a bug is clearly severe.
- If legacy behavior is questionable, flag it and confirm before changing.
- Preserve protocol compatibility with existing frontend and tools.
- Protocol parity is the top priority; change only with explicit agreement.

## Protocol parity (guideline)
- [x] Freeze protocol spec from legacy code (see `docs/protocol_parity_spec.md`):
  - command IDs and payload framing
  - endianness and field order
  - error behaviors (empty response vs. error code)
  - path encoding and limits
- [ ] Mirror BLE service/characteristics and device name used by the frontend.
- [ ] Match MTU negotiation and max payload behavior (MTU minus ATT header).
- [ ] Build protocol test vectors and a runnable harness (defer until protocol port).

## Phase 0: Inventory and mapping
- [x] Build a module map from legacy code (see `docs/firmware_phase0_inventory.md`):
  - `src/main.cpp` (system orchestration)
  - `src/gps_handler.*`, `src/casic_gps_wrapper.*`, `src/gpx_logger.*`
  - `src/ble_handler.*`, `src/file_transfer_protocol.*`
  - `src/accel_handler.*`, `src/accel_analyzer.*`
  - `src/bmp280_handler.*`
  - `src/display_handler.*`
  - `src/sd_handler.*`, `src/sd_fs_handler.*`
  - `src/battery.*`, `src/button_handler.*`, `src/system_info.h`, `src/logger.*`
- [x] Map pins from `variant.h` to Embassy GPIO/UART/I2C/SPI definitions.
- [x] Identify which storage backend is required (SD only vs. SD + internal FS).
- [x] Decide if A-GNSS stays identical to current protocol.
- [x] Confirm legacy LittleFS usage is out-of-scope for the new firmware.

## Phase 1: Bring-up and toolchain
- [x] Confirm `firmware/.cargo/config.toml` runner and target for nRF52840.
- [x] Verify `memory.x` matches SoftDevice S140 layout (flash/RAM offsets).
- [x] Minimal app: LED blink + defmt logging.
- [x] Confirm flashing/debug flow (probe-rs or UF2).

## Phase 2: Core drivers and async runtime
- [x] UART driver for GPS (async + RX buffering).
- [x] I2C driver for sensors/display with a shared bus lock.
- [x] SPI driver for SD (and any other SPI peripherals).
- [x] Time source and timers (Embassy time with RTC1, compatible with SoftDevice).

## Phase 3: GPS and state machine
- [x] GPS UART task skeleton (read loop + power control).
- [x] Port CASIC protocol parser (`casic_gps_wrapper.*`) to Rust.
- [x] Integrate NMEA parsing (`nmea` crate) with CASIC for mixed streams.
- [x] Port GPS state machine from `src/gps_handler.cpp`:
  - power control
  - fix attempts, sleep/wake intervals
  - stillness/accel integration
- [x] AGNSS message queue and send timing.
- [x] Define `SystemInfo` model for parity with legacy firmware.
- [x] Implement `SystemInfo` serialization for BLE responses.

## Phase 4: BLE and file transfer
- [ ] Mirror BLE UART service/characteristics (UUIDs/handles) used today.
- [ ] Implement MTU negotiation and chunking identical to legacy behavior.
- [ ] Port `file_transfer_protocol.*` with identical framing and responses:
  - list dir, open/read/close/delete, sysinfo, AGNSS upload, GPS wakeup
- [ ] Validate with existing frontend expectations (payload format).

## Phase 5: Storage
- [ ] SD card stack (choose crate: `embedded-sdmmc` or equivalent).
- [ ] Port GPX logging (`gpx_logger.*`) and file layout.
- [ ] Verify large file handling and chunked reads over BLE.

## Phase 6: Sensors, display, and UI
- [ ] LIS3DH accel via `lis3dh` crate; confirm range/ODR settings.
- [ ] BMP280 via `bmp280-rs` crate; map calibration and units.
- [ ] SSD1306 display via `embedded-graphics` + `ssd1306`.
- [ ] Button handling and debounce (async GPIO + timer).
- [ ] Battery ADC setup and scaling.

## Phase 7: Power and performance
- [ ] Sleep strategy for MCU + peripherals.
- [ ] GPS power gating behavior and wake triggers.
- [ ] Tune task priorities and interrupts with SoftDevice.

## Phase 8: Integration and validation
- [ ] End-to-end runtime (GPS -> logging -> BLE transfer -> frontend).
- [ ] Stress test file transfer with large GPX files.
- [ ] Regression checklist vs. legacy firmware.
- [ ] Protocol regression tests (vectors + harness) using mocks.

## Deliverables
- [ ] Rust firmware parity for required features (no LoRa).
- [ ] Updated docs on build/flash and runtime usage.
- [ ] Migration notes for remaining gaps or deferred features.

## Risks and open questions
- [ ] BLE MTU/throughput for file transfer.
- [ ] SD card filesystem performance and async safety.
- [ ] SoftDevice RAM/flash sizing conflicts.
- [ ] CASIC + NMEA parsing correctness under mixed streams.
