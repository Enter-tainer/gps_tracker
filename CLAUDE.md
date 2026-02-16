# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Low-power GPS tracking device based on nRF52840 with intelligent power management, BLE connectivity, and a web frontend for visualization. Hardware: nRF52840 MCU, L76K GPS (CASIC protocol), LIS3DHTR accelerometer, BMP280 barometer, SSD1306 OLED, SD card storage.

## Development Commands

### Rust Firmware (firmware/)

```bash
cd firmware

# Build
cargo build --release

# Flash and run via probe-rs (device must be connected via SWD)
cargo run --release

# Change log level (default: debug)
DEFMT_LOG=info cargo run --release
```

Key build notes:
- Target: `thumbv7em-none-eabihf` (Cortex-M4F)
- Uses `flip-link` as linker (must be installed: `cargo install flip-link`)
- Uses `probe-rs` as runner (must be installed: `cargo install probe-rs-tools`)
- Both dev and release profiles use `opt-level = 'z'` — async state machines can stack-overflow without size optimization
- Release uses fat LTO and `codegen-units = 1` for maximum size reduction
- Logging via `defmt` + RTT (no serial output, requires debug probe)

### Web Frontend (frontend/)

```bash
cd frontend
npm install
npm run dev          # Vite dev server (localhost:3000)
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

Frontend auto-deploys to GitHub Pages on push to master via `.github/workflows/deploy-frontend.yml`.

## Architecture

### Rust Firmware

Embassy-nrf async framework with spawned tasks. `#![no_std]`, no heap — all buffers are `StaticCell` or stack-allocated.

Key modules:
- **gps.rs** — GPS state machine (6 states, see below), NMEA parsing, CASIC command sending
- **storage.rs** — SD card via SPI, GPZ binary format (V1 1e5 / V2 1e7 precision), delta compression with ZigZag + LEB128
- **protocol.rs** — BLE UART file transfer protocol (commands 0x01-0x0A), matches `docs/uart_file_proto.md`
- **ble.rs** — BLE GATT server with NUS (Nordic UART Service), advertising, connection management
- **casic.rs** — CASIC binary protocol parser (frame: `BA CE [len] [class] [id] [payload] [checksum]`)
- **usb_msc.rs** — USB mass storage class for direct SD card access
- **accel.rs** — LIS3DH motion detection for GPS power management
- **display.rs** — SSD1306 OLED rendering with embedded-graphics
- **timezone.rs** — IANA timezone database for GPS time conversion
- **main.rs** — Peripheral init, interrupt binding, task spawning, USB boot mode detection

Hardware constraints:
- SoftDevice (BLE stack) reserves RTC0 → firmware uses RTC1 as Embassy time driver
- SoftDevice reserves first 0x27000 of flash and 0x3000 of RAM (see `memory.x`)
- DMA buffers must be in RAM (StaticCell), not flash
- I2C bus shared between display, accelerometer, and barometer via `BlockingMutex`

### GPS State Machine

Defined in `docs/state_spec.md`. States:
- **S0**: Initializing hardware
- **S1**: GPS searching for fix (timeout: 90s cold/30s reacquire)
- **S2**: Idle, GPS powered off (periodic wake every 15min)
- **S3**: Tracking with fix (10s sample interval, HDOP < 2.0 required, ignored above 20km/h)
- **S4**: Analyzing stillness (60s below 0.1g threshold)
- **S5**: A-GNSS data injection (60s timeout, 5s per message, max 70 messages)

### GPZ Storage Format

Binary format documented in `docs/delta_compress_gpx.md`:
- Full blocks (16 bytes): timestamp + lat + lon + altitude
- Delta blocks: varint-encoded differences from previous point
- Full block inserted every 64 deltas
- V1: 1e5 coordinate precision (~1.1m), V2: 1e7 precision (~1.1cm)
- Files can mix V1/V2 blocks

### Web Frontend

React + TypeScript + Vite PWA. Communicates with device via Web Bluetooth API.

Key services:
- **bleService.ts** — BLE NUS connection, 244-byte MTU packet framing
- **gpsDecoder.ts** — GPZ binary format decoder (mirrors firmware storage.rs)
- **gpxConverter.ts** — GPZ → GPX format conversion for export
- **modules/agnss/** — A-GNSS ephemeris data fetching and CASIC formatting

### BLE File Transfer Protocol

Command-response over NUS (see `docs/uart_file_proto.md`):
- Format: `[CMD_ID:1B] [LEN:2B LE] [payload]`
- Commands: LIST_DIR(0x01), OPEN_FILE(0x02), READ_CHUNK(0x03), CLOSE_FILE(0x04), DELETE_FILE(0x05), GET_SYS_INFO(0x06), AGNSS operations(0x07-0x09), GPS_WAKEUP(0x0A)

## Important Caveats

- `src/` directory contains **deprecated** C++ Arduino firmware — do not modify, use `firmware/` (Rust) for all development
- `platformio.ini` is for the deprecated C++ build — Rust firmware uses Cargo
- nrf-softdevice is pinned to a specific git revision — updating requires careful compatibility testing
- The `host-test` feature flag exists in Cargo.toml for potential host-side testing but hardware drivers make most code untestable without a device

## Specifications

- `docs/state_spec.md` — Complete GPS state machine spec with transitions and thresholds
- `docs/uart_file_proto.md` — BLE file transfer protocol with command/response formats
- `docs/casic_agnss.md` — CASIC binary protocol and A-GNSS injection process
- `docs/delta_compress_gpx.md` — GPZ V1/V2 binary format and delta compression algorithm

## Utility Scripts

- `gps_format_tool.py` — Encode/decode GPZ files for debugging
- `casic_parser.py` — Parse CASIC binary protocol captures
- `scripts/gen_tz_grid.py` — Generate timezone grid data from IANA tzdata
- `scripts/gen_logo.py` — Generate embedded OLED logo bitmaps
- `tools/build_uf2.py` — Build UF2 firmware images
