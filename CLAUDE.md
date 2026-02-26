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
- **protocol.rs** — BLE UART file transfer protocol (commands 0x01-0x0B), matches `docs/uart_file_proto.md`
- **ble.rs** — BLE GATT server with NUS (Nordic UART Service), advertising, connection management
- **casic.rs** — CASIC binary protocol parser (frame: `BA CE [len] [class] [id] [payload] [checksum]`)
- **usb_msc.rs** — USB mass storage class for direct SD card access
- **accel.rs** — LIS3DH motion detection for GPS power management
- **display.rs** — SSD1306 OLED rendering with embedded-graphics
- **timezone.rs** — IANA timezone database for GPS time conversion
- **findmy.rs** — Apple Find My offline finding: P-224 key derivation (ANSI X9.63 KDF), BLE non-connectable advertising with 15-min rolling keys, GPS-time-based counter. Gated behind `findmy` feature flag.
- **google_fmdn.rs** — Google Find My Device Network: EID computation (AES-ECB-256 + SECP160R1), BLE advertising (Eddystone 0xFEAA), 1024s EID rotation. Gated behind `google-fmdn` feature flag.
- **secp160r1.rs** — SECP160R1 elliptic curve implementation (field arithmetic, scalar multiplication) for FMDN EID generation. Gated behind `google-fmdn` feature flag.
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
- **S2**: Idle, GPS powered off (wakes on motion or BLE command)
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
- **findmyKeyGen.ts** — P-224 key generation for Find My provisioning (uses @noble/curves)
- **fdmnKeyGen.ts** — FMDN EIK generation (32-byte random), JSON export/import

### BLE File Transfer Protocol

Command-response over NUS (see `docs/uart_file_proto.md`):
- Format: `[CMD_ID:1B] [LEN:2B LE] [payload]`
- Commands: LIST_DIR(0x01), OPEN_FILE(0x02), READ_CHUNK(0x03), CLOSE_FILE(0x04), DELETE_FILE(0x05), GET_SYS_INFO(0x06), AGNSS operations(0x07-0x09), GPS_WAKEUP(0x0A), GPS_KEEP_ALIVE(0x0B), WRITE_FINDMY_KEYS(0x0C), READ_FINDMY_KEYS(0x0D), GET_FINDMY_STATUS(0x0E) — last three require `findmy` feature; WRITE_FMDN_EIK(0x0F), READ_FMDN_EIK(0x10), GET_FMDN_STATUS(0x11) — require `google-fmdn` feature

## Important Caveats

- `src/` directory contains **deprecated** C++ Arduino firmware — do not modify, use `firmware/` (Rust) for all development
- `platformio.ini` is for the deprecated C++ build — Rust firmware uses Cargo
- nrf-softdevice is pinned to a specific git revision — updating requires careful compatibility testing
- The `host-test` feature flag exists in Cargo.toml for potential host-side testing but hardware drivers make most code untestable without a device
- The `findmy` feature flag enables Apple Find My offline finding (findmy.rs, protocol commands 0x0C-0x0E, SD card key storage). Requires `p224`, `sha2`, and `chrono` crates.
- The `google-fmdn` feature flag enables Google Find My Device Network (google_fmdn.rs, secp160r1.rs, protocol commands 0x0F-0x11, SD card EIK storage). Requires `aes`, `sha2` crates.

## Specifications

- `docs/state_spec.md` — Complete GPS state machine spec with transitions and thresholds
- `docs/uart_file_proto.md` — BLE file transfer protocol with command/response formats
- `docs/casic_agnss.md` — CASIC binary protocol and A-GNSS injection process
- `docs/delta_compress_gpx.md` — GPZ V1/V2 binary format and delta compression algorithm

## Find My Offline Finding

### How It Works

The device broadcasts BLE advertisements compatible with Apple's Find My network. Nearby Apple devices (iPhones, Macs, iPads) detect these advertisements, encrypt their own GPS location with the broadcasted public key, and upload the encrypted report to Apple's servers. The device owner can then query Apple's API with the corresponding private keys to decrypt and retrieve these location reports.

Privacy is maintained through **rolling keys**: the public key changes every 15 minutes, so no single observer can continuously track the device.

### Key Concepts

- **Master key material** (68 bytes): P-224 private key (28B) + initial symmetric key SK₀ (32B) + epoch timestamp (8B). Generated once, provisioned to device via BLE, must be kept secret.
- **Rolling keys**: Every 15-minute slot gets a unique P-224 keypair derived from the master material via ANSI X9.63 KDF. The counter is `floor(now/900) - floor(epoch/900)`.
- **Counter**: Index into the key sequence. Counter 0 corresponds to the epoch. The firmware needs GPS time to compute the current counter — without it, advertising cannot start.
- **Hashed advertisement key**: `base64(SHA-256(public_key_x))` — this is how Apple indexes reports on their server.
- **anisette-v3-server**: Provides Apple device attestation headers required for API authentication. Run via Docker: `docker run -d -p 6969:6969 dadoum/anisette-v3-server`
- **auth.json**: Contains `dsid` (Apple ID numeric identifier) + `searchPartyToken` (session token for Apple's Find My API). Generated by authenticating with an Apple ID via [biemster/FindMy](https://github.com/biemster/FindMy). Tokens expire periodically and need re-authentication.

### Provisioning Keys to Device

1. In the web frontend: **Generate** → **Provision** (writes 68-byte key bundle via BLE command 0x0C)
2. **Export** the keys as JSON backup — this is the only way to decrypt location reports later
3. Device stores keys to `/FINDMY.KEY` on SD card and begins advertising once GPS time is available

### Querying Location Reports

Prerequisites: `auth.json` + running `anisette-v3-server` on `localhost:6969`

```bash
cd tools
pip install cryptography requests

# Fetch last 24 hours, save JSON + GPX
python findmy_query.py fetch -k keys.json --auth auth.json -H 24 -o results.json --gpx track.gpx

# Fetch last 48 hours
python findmy_query.py fetch -k keys.json --auth auth.json -H 48 -o results.json --gpx track.gpx

# Convert existing JSON to GPX (with spatial dedup)
python findmy_query.py gpx results.json -o track.gpx

# Show all raw points without dedup
python findmy_query.py gpx results.json --all -o track_all.gpx

# Inspect rolling keys without querying Apple (no auth needed)
python findmy_query.py keys -k keys.json -H 24
```

**Important**: Apple's API returns at most ~20 reports per request. The script automatically batches queries (10 key hashes per request) to retrieve all available data.

### Generating auth.json

```bash
# 1. Start anisette server
docker run -d --restart always -p 6969:6969 dadoum/anisette-v3-server

# 2. Clone and set up the FindMy auth tool
git clone https://github.com/biemster/FindMy
cd FindMy
pip install -r requirements.txt  # needs: requests, cryptography, pbkdf2, srp, pycryptodome

# 3. Run authentication (interactive: Apple ID + password + 2FA)
python3 request_reports.py -t   # -t for trusted device 2FA push

# 4. auth.json is generated in the current directory
```

## Google Find My Device Network (FMDN)

### How It Works

The device broadcasts BLE advertisements compatible with Google's Find My Device Network (Find Hub). Nearby Android devices detect the Eddystone-format advertisements, encrypt their GPS location with the broadcasted EID public key, and upload encrypted reports to Google's servers. The device owner uses the Spot API to retrieve and decrypt location reports.

Privacy is maintained through **rotating EIDs**: the Ephemeral Identifier changes every 1024 seconds (~17 minutes) using AES-ECB-256 + SECP160R1 elliptic curve.

### Key Concepts

- **EIK (Ephemeral Identity Key)** (32 bytes): Random key provisioned to device via BLE, stored on SD card at `/FMDN.EIK`. Used as AES-256 key for EID computation.
- **EID (Ephemeral Identifier)** (20 bytes): Rotating public value broadcast in BLE advertisements. Computed as x-coordinate of `r*G` on SECP160R1, where `r` is derived from AES-ECB-256(EIK, input_block).
- **EID Rotation**: Every 1024 seconds (K=10, 2^10=1024). Firmware needs GPS time to compute the correct rotation period.
- **SECP160R1**: Non-standard 160-bit elliptic curve used for compact 20-byte EIDs. Custom implementation in `secp160r1.rs`.
- **Hashed flags**: Battery level and UTP mode encoded as `SHA256(r)[0] XOR flags_raw`.
- **Key hierarchy**: Recovery key = SHA256(EIK||0x01)[:8], Ring key = SHA256(EIK||0x02)[:8], Tracking key = SHA256(EIK||0x03)[:8].
- **Precomputed key IDs**: Truncated EIDs (first 10 bytes) with timestamps, uploaded to Google's Spot API every ~3-4 days. Without fresh uploads, the tracker stops receiving location reports.

### Provisioning EIK to Device

1. In the web frontend: **Generate EIK** → **Provision** (writes 32-byte EIK via BLE command 0x0F)
2. **Export** the EIK as JSON backup
3. Device stores EIK to `/FMDN.EIK` on SD card and begins advertising once GPS time is available

### Companion Tool

```bash
cd tools
pip install cryptography

# Generate EIK and save to file
python fmdn_companion.py generate -o eik.json

# Show EID sequence for last 24 hours (verify firmware EID computation)
python fmdn_companion.py keys -k eik.json -H 24

# Precompute key IDs for Spot API upload (96 hours)
python fmdn_companion.py key-ids -k eik.json -H 96 -o key_ids.json
```

**Note**: Device registration and location report fetching require integration with [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) and Google OAuth authentication via the Spot gRPC API. These operations are not yet implemented in the standalone companion tool.

## Utility Scripts

- `gps_format_tool.py` — Encode/decode GPZ files for debugging
- `casic_parser.py` — Parse CASIC binary protocol captures
- `scripts/gen_tz_grid.py` — Generate timezone grid data from IANA tzdata
- `scripts/gen_logo.py` — Generate embedded OLED logo bitmaps
- `tools/build_uf2.py` — Build UF2 firmware images
- `tools/findmy_query.py` — Find My location report query tool: key generation, Apple API fetch, GPX export
- `tools/fmdn_companion.py` — FMDN companion tool: EIK generation, EID derivation, key ID precomputation
