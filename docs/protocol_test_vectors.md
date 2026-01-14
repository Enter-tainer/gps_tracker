# Protocol Test Vectors (Initial)

These vectors are derived from `src/file_transfer_protocol.*` and are intended
for parity tests in the Rust implementation. All bytes are hex, little-endian.

## Test setup (virtual FS + system info)
- Root directory order: `a.txt` (file, "hello", size 5), `logs` (dir, empty).
- SystemInfo values for GET_SYS_INFO:
  - latitude = 1.0 (f64)
  - longitude = 2.0 (f64)
  - altitude = 3.5 (f32)
  - satellites = 7 (u32)
  - hdop = 1.25 (f32)
  - speed = 10.0 (f32)
  - course = 90.0 (f32)
  - year = 2025 (u16)
  - month = 9, day = 6, hour = 12, minute = 34, second = 56
  - locationValid = 1, dateTimeValid = 1
  - batteryVoltage = 4.0 (f32)
  - gpsState = 3 (S3_TRACKING_FIXED)

## Sequence A: LIST_DIR (root)
1) LIST_DIR `/` (path len 0)
```
CMD: 01 01 00 00
RSP: 0c 00 01 00 05 61 2e 74 78 74 05 00 00 00
```
2) LIST_DIR again (next entry)
```
CMD: 01 01 00 00
RSP: 07 00 01 01 04 6c 6f 67 73
```
3) LIST_DIR again (end)
```
CMD: 01 01 00 00
RSP: 01 00 00
```

## Sequence B: OPEN/READ/CLOSE a.txt
1) OPEN_FILE `/a.txt`
```
CMD: 02 07 00 06 2f 61 2e 74 78 74
RSP: 04 00 05 00 00 00
```
2) READ_CHUNK offset 0, len 3
```
CMD: 03 06 00 00 00 00 00 03 00
RSP: 05 00 03 00 68 65 6c
```
3) READ_CHUNK offset 3, len 10 (EOF clamp)
```
CMD: 03 06 00 03 00 00 00 0a 00
RSP: 04 00 02 00 6c 6f
```
4) CLOSE_FILE
```
CMD: 04 00 00
RSP: 00 00
```
5) READ_CHUNK without open file (error)
```
CMD: 03 06 00 00 00 00 00 01 00
RSP: 02 00 00 00
```

## Sequence C: DELETE_FILE (no open file)
```
CMD: 05 07 00 06 2f 61 2e 74 78 74
RSP: 00 00
```

## Sequence D: GET_SYS_INFO
```
CMD: 06 00 00
RSP: 32 00
     00 00 00 00 00 00 f0 3f
     00 00 00 00 00 00 00 40
     00 00 60 40
     07 00 00 00
     00 00 a0 3f
     00 00 20 41
     00 00 b4 42
     e9 07 09 06 0c 22 38 01 01
     00 00 80 40
     03
```

## Sequence E: AGNSS
1) START_AGNSS_WRITE
```
CMD: 07 00 00
RSP: 00 00
```
2) WRITE_AGNSS_CHUNK "abc"
```
CMD: 08 05 00 03 00 61 62 63
RSP: 00 00
```
3) END_AGNSS_WRITE
```
CMD: 09 00 00
RSP: 00 00
```

## Sequence F: GPS_WAKEUP
```
CMD: 0a 00 00
RSP: 00 00
```

## Notes
- LIST_DIR uses stateful iteration; the final "no more entries" response is a
  payload length of 1 with `MoreFlag = 00` and no entry data.
- READ_CHUNK clamps to a max of 254 data bytes per response.
