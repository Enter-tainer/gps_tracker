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
- Response payload length: 50 bytes, fields in order:
  - `latitude (f64, 8)`
  - `longitude (f64, 8)`
  - `altitude (f32, 4)`
  - `satellites (u32, 4)`
  - `hdop (f32, 4)`
  - `speed (f32, 4)`
  - `course (f32, 4)`
  - `year (u16, 2)`
  - `month (u8, 1)`
  - `day (u8, 1)`
  - `hour (u8, 1)`
  - `minute (u8, 1)`
  - `second (u8, 1)`
  - `locationValid (u8, 1)` (0 or 1)
  - `dateTimeValid (u8, 1)` (0 or 1)
  - `batteryVoltage (f32, 4)`
  - `gpsState (u8, 1)`

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

## Known doc mismatches (vs docs/uart_file_proto.md)
- START_AGNSS_WRITE does not use a total-size payload; any payload is ignored.
- OPEN_FILE closes any existing open file before opening the requested file.
- READ_CHUNK max data per response is fixed at 254 bytes, not MTU-derived.
- Responses do not include a response ID; only length + payload.
