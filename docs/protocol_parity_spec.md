# Protocol Parity Spec (Legacy BLE UART)

Scope: 1:1 behavior for the file transfer protocol implemented by
`src/file_transfer_protocol.*` and BLE UART in `src/ble_handler.*`.
Source of truth is the C++ code; docs are secondary.

## Transport and framing
- Transport: byte stream over BLE UART (NUS). Device name: `MGT GPS Tracker`.
- Command frame: `CMD_ID (1) + PAYLOAD_LEN_LE (2) + PAYLOAD (N)`.
- Response frame: `PAYLOAD_LEN_LE (2) + PAYLOAD (N)`.
- All multi-byte numeric fields are little-endian.

## Command IDs
- `0x01` LIST_DIR
- `0x02` OPEN_FILE
- `0x03` READ_CHUNK
- `0x04` CLOSE_FILE
- `0x05` DELETE_FILE
- `0x06` GET_SYS_INFO
- `0x07` START_AGNSS_WRITE
- `0x08` WRITE_AGNSS_CHUNK
- `0x09` END_AGNSS_WRITE
- `0x0A` GPS_WAKEUP
- `0x0B` GPS_KEEP_ALIVE
- `0x0C` WRITE_FINDMY_KEYS (requires `findmy` feature)
- `0x0D` READ_FINDMY_KEYS (requires `findmy` feature)
- `0x0E` GET_FINDMY_STATUS (requires `findmy` feature)

## Common limits
- `MAX_PATH_LENGTH = 64` bytes.
- Max command payload length: 570 bytes; larger payloads are dropped with no
  response.
- LIST_DIR response buffer: 128 bytes.
- READ_CHUNK response buffer: 256 bytes (2 bytes length + up to 254 data).

## Statefulness
- LIST_DIR is stateful: the first call opens the directory; subsequent LIST_DIR
  calls return the next entry until `MoreFlag = 0x00`. Path in subsequent calls
  is ignored while listing is in progress.
- OPEN_FILE implicitly closes any currently open file before opening a new one.
- DELETE_FILE fails if a file is currently open.
- AGNSS data is buffered in RAM; START clears the queue, END sends it to GPS.

## Command details (payloads and responses)
### LIST_DIR (0x01)
- Payload: `PathLen (1) + Path (PathLen bytes)`. If `PathLen = 0`, use `/`.
- Response payload:
  - `MoreFlag (1)`: `0x01` if more entries remain, `0x00` if last/none.
  - If `MoreFlag = 0x01`, append:
    - `EntryType (1)`: `0x00` file, `0x01` directory.
    - `NameLen (1) + Name (NameLen bytes)`
    - If file: `FileSize (4 LE)`
- On open failure or invalid path: empty response (payload length 0).

### OPEN_FILE (0x02)
- Payload: `PathLen (1) + Path (PathLen bytes)`.
- Response payload on success: `FileSize (4 LE)`.
- Response payload on failure: empty.

### READ_CHUNK (0x03)
- Payload: `Offset (4 LE) + BytesToRead (2 LE)`.
- Behavior: `BytesToRead` is clamped to 254 bytes.
- Response payload:
  - `ActualBytes (2 LE) + Data (ActualBytes bytes)`
  - On error (no open file or seek failure): `ActualBytes = 0` and payload
    length is 2.

### CLOSE_FILE (0x04)
- Payload: empty.
- Response payload: empty (always).

### DELETE_FILE (0x05)
- Payload: `PathLen (1) + Path (PathLen bytes)`.
- Response payload: empty (always), even on error.

### GET_SYS_INFO (0x06)
- Payload: empty.
- Response payload length: **50 bytes (V1, legacy)** or **63 bytes (V2, current)**
- V1 format (50 bytes, master branch):
  - No version field
  - `latitude (f64, 8)` through `gpsState (u8, 1)` — 50 bytes total
- V2 format (63 bytes, current):
  - `version (u8, 1)` = 2
  - `latitude (f64, 8)` through `gpsState (u8, 1)` — 50 legacy bytes
  - `keepAliveRemainingS (u16, 2)` (0 = inactive)
  - `batteryPercent (u8, 1)` (0-100)
  - `isStationary (u8, 1)` (0 or 1)
  - `temperatureC (f32, 4)` (Celsius)
  - `pressurePa (f32, 4)` (Pascals)

Version detection: Frontend checks payload length (50 = V1, 63 = V2).

### START_AGNSS_WRITE (0x07)
- Payload: ignored (length can be 0 or non-zero).
- Response payload: empty.

### WRITE_AGNSS_CHUNK (0x08)
- Payload: `ChunkSize (2 LE) + Data (ChunkSize bytes)`.
- If `ChunkSize == 0` or `ChunkSize > PayloadLen - 2`, treat as error.
- Response payload: empty (always).

### END_AGNSS_WRITE (0x09)
- Payload: empty.
- Response payload: empty.

### GPS_WAKEUP (0x0A)
- Payload: empty.
- Response payload: empty.

### GPS_KEEP_ALIVE (0x0B)
- Payload: `Duration (2 LE)` in minutes. `0` = cancel.
- Response payload: empty.

## Find My commands (requires `findmy` feature)

- `0x0C` WRITE_FINDMY_KEYS
- `0x0D` READ_FINDMY_KEYS
- `0x0E` GET_FINDMY_STATUS

### WRITE_FINDMY_KEYS (0x0C)
- Payload: 68 bytes = `PrivateKey (28) + SymmetricKey (32) + Epoch (8 LE)`.
- If payload length != 68: empty response.
- On SD write failure: empty response.
- On success: response payload = `0x01` (1 byte). Also initializes Find My module and enables advertising immediately.

### READ_FINDMY_KEYS (0x0D)
- Payload: empty.
- Response payload on success: 68 bytes (same layout as WRITE_FINDMY_KEYS payload).
- Response payload on failure (no file): empty.

### GET_FINDMY_STATUS (0x0E)
- Payload: empty.
- Response payload: 1 byte. `0x01` = enabled, `0x00` = disabled.

## Known doc mismatches (vs docs/uart_file_proto.md)
- START_AGNSS_WRITE does not use a total-size payload; any payload is ignored.
- OPEN_FILE closes any existing open file before opening the requested file.
- READ_CHUNK max data per response is fixed at 254 bytes, not MTU-derived.
- Responses do not include a response ID; only length + payload.
