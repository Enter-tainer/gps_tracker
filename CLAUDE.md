# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a low-power GPS tracking device based on nRF52840 with intelligent power management and web frontend visualization. Key features include motion-based GPS power management, A-GNSS support, BLE connectivity, and GPX logging.

## Architecture

### Hardware Components
- **MCU**: nRF52840 (Pro Micro compatible)
- **GPS**: CASIC protocol GPS module (L76k)
- **Sensors**: LIS3DHTR accelerometer, BMP280 pressure/temperature sensor
- **Display**: SSD1306 OLED
- **Storage**: Internal LittleFS + optional SD card

### Core System States
The GPS power management follows a sophisticated 6-state machine defined in `docs/state_spec.md`:
- S0: Initializing
- S1: GPS searching for fix
- S2: Idle (GPS off)
- S3: Tracking with fix
- S4: Analyzing stillness
- S5: A-GNSS processing

### Software Architecture

#### Firmware (src/)
- **main.cpp**: System initialization and main loop
- **gps_handler.cpp**: GPS state machine implementation
- **ble_handler.cpp**: Bluetooth Low Energy communication
- **accel_handler.cpp**: Accelerometer data processing
- **gpx_logger.cpp**: GPX format trajectory logging
- **display_handler.cpp**: OLED display management
- **battery.cpp**: Battery monitoring
- **file_transfer_protocol.cpp**: UART-based file transfer

#### Web Frontend (frontend/)
- **Vite-based** modern web application
- **Web Bluetooth API** for device communication
- **Services**: BLE, GPS decoding, file management, A-GNSS
- **Components**: File explorer, logger, status panel
- **Real-time data visualization** and GPX export

## Development Commands

### Firmware Development
```bash
# Install PlatformIO
pip install platformio

# Build firmware
pio run

# Upload to device (generates .uf2)
pio run -t upload

# Monitor serial output
pio device monitor
```

### Web Frontend Development
```bash
cd frontend
npm install
npm run dev          # Development server
npm run build        # Production build
npm run preview      # Preview production build
```

### File Structure Key
- `src/` - Arduino firmware source
- `frontend/` - Web frontend (Vite + vanilla JS)
- `boards/` - Custom board definitions for nRF52840
- `docs/` - Technical specifications and protocols
- `patches/` - Required library patches
- `platformio.ini` - PlatformIO build configuration

## Key Technologies
- **Framework**: Arduino Core for nRF52840
- **BLE**: Adafruit Bluefruit library
- **Storage**: LittleFS for internal flash
- **GPS**: TinyGPS++ for NMEA parsing
- **Web**: Vanilla JS with Web Bluetooth API
- **Build**: PlatformIO with custom UF2 generation

## Important Notes
- GPS power management uses sophisticated motion detection with configurable thresholds
- A-GNSS data injection uses CASIC binary protocol
- GPX logging supports incremental compression
- File transfer over UART uses custom protocol defined in `docs/uart_file_proto.md`
- Web frontend auto-deploys to GitHub Pages via GitHub Actions