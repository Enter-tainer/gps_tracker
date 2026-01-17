#!/usr/bin/env python3
"""
Generate timezone grid data for embedded Rust firmware with tzdb support.

Outputs four files:
  - firmware/data/tz_row_index.bin: Row index (u16 offset into RLE data per latitude)
  - firmware/data/tz_rle.bin: RLE encoded grid data (count, tz_id pairs, tz_id is u16)
  - firmware/data/tz_transition_index.bin: Per-tz_id base offset + transition index
  - firmware/data/tz_transitions.bin: UTC transition timestamps and offsets

Binary formats:
  tz_row_index.bin: 180 * u16 (little-endian)

  tz_rle.bin:
    For each row: sequence of (count: u8, tz_id: u16) pairs

  tz_transition_index.bin:
    For each tz_id:
      [base_offset_minutes: i16]
      [first_transition_index: u32]
      [transition_count: u16]

  tz_transitions.bin:
    For each transition:
      [transition_utc_ts: u32][offset_minutes: i16]

DST transitions are generated for years 2025-2100 (inclusive).

Usage:
    uv run --with shapely,requests,tqdm,tzdata python scripts/gen_tz_grid.py
"""

import json
import struct
import zipfile
import io
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from tqdm import tqdm
from shapely.geometry import shape, Point
from shapely import STRtree
from shapely.validation import make_valid

CACHE_DIR = Path(__file__).parent / ".cache"
OUTPUT_DIR = Path(__file__).parent.parent / "firmware" / "data"

GEOJSON_URL = "https://github.com/evansiroky/timezone-boundary-builder/releases/download/2025c/timezones.geojson.zip"
DST_START_YEAR = 2025
DST_END_YEAR = 2100
TRANSITION_STEP_HOURS = 6


def download_timezone_data() -> dict:
    """Download and cache full timezone boundary GeoJSON."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / "timezones-2025c.geojson"
    
    if cache_file.exists():
        print(f"Using cached data: {cache_file}")
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    
    print(f"Downloading full timezone data from {GEOJSON_URL}...")
    response = requests.get(GEOJSON_URL, stream=True)
    response.raise_for_status()
    
    with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
        for name in zf.namelist():
            if name.endswith('.geojson') or name.endswith('.json'):
                print(f"Extracting {name}...")
                with zf.open(name) as f:
                    data = json.load(f)
                    with open(cache_file, "w", encoding="utf-8") as cf:
                        json.dump(data, cf)
                    return data
    
    raise RuntimeError("No geojson/json file found in zip")


def utc_offset_minutes(zone: ZoneInfo, utc_dt: datetime) -> int:
    """Get total UTC offset in minutes for a UTC datetime."""
    offset = utc_dt.astimezone(zone).utcoffset()
    if offset is None:
        return 0
    return int(offset.total_seconds() // 60)


def find_transition(zone: ZoneInfo, start: datetime, end: datetime, prev_offset: int) -> tuple[datetime, int]:
    """Binary search the first UTC time where the offset differs from prev_offset."""
    lo = start
    hi = end
    while (hi - lo).total_seconds() > 1:
        mid = lo + (hi - lo) / 2
        if utc_offset_minutes(zone, mid) == prev_offset:
            lo = mid
        else:
            hi = mid
    new_offset = utc_offset_minutes(zone, hi)
    return hi, new_offset


def build_transition_tables(tz_names: list[str]) -> tuple[list[tuple[int, int, int]], list[tuple[int, int]]]:
    """Build per-timezone transition tables for the configured DST year range."""
    start = datetime(DST_START_YEAR, 1, 1, tzinfo=timezone.utc)
    end = datetime(DST_END_YEAR + 1, 1, 1, tzinfo=timezone.utc)
    step = timedelta(hours=TRANSITION_STEP_HOURS)

    index_entries: list[tuple[int, int, int]] = []
    transitions: list[tuple[int, int]] = []

    for tz_name in tqdm(tz_names, desc="Building DST transitions"):
        try:
            zone = ZoneInfo(tz_name)
        except ZoneInfoNotFoundError as exc:
            raise RuntimeError(
                f"ZoneInfo data missing for {tz_name}. Install the 'tzdata' package."
            ) from exc

        base_offset = utc_offset_minutes(zone, start)
        prev_offset = base_offset
        prev_time = start
        current = prev_time + step
        tz_transitions: list[tuple[int, int]] = []

        while current <= end:
            cur_offset = utc_offset_minutes(zone, current)
            if cur_offset != prev_offset:
                trans_time, new_offset = find_transition(zone, prev_time, current, prev_offset)
                if trans_time >= end:
                    break
                tz_transitions.append((int(trans_time.timestamp()), new_offset))
                prev_time = trans_time
                prev_offset = new_offset
                current = prev_time + step
                continue
            prev_time = current
            current += step

        start_index = len(transitions)
        transitions.extend(tz_transitions)
        index_entries.append((base_offset, start_index, len(tz_transitions)))

    return index_entries, transitions


def build_timezone_grid(geojson: dict) -> tuple[list[list[int]], list[str]]:
    """
    Build a 1x1 degree grid of timezone IDs.
    
    Returns:
        (grid, tz_names) where:
        - grid[lat][lon] = tz_id
        - tz_names[tz_id] = IANA timezone name
    """
    features = geojson["features"]
    
    # Build timezone name table
    tz_names = ["Etc/UTC"]  # tz_id 0 = ocean/unknown = UTC
    tz_name_to_id: dict[str, int] = {"Etc/UTC": 0}
    
    print("Building spatial index...")
    geometries = []
    geom_tz_ids = []
    
    for feat in tqdm(features, desc="Loading geometries"):
        tz_name = feat["properties"]["tzid"]
        
        # Get or create tz_id
        if tz_name not in tz_name_to_id:
            tz_name_to_id[tz_name] = len(tz_names)
            tz_names.append(tz_name)
        
        tz_id = tz_name_to_id[tz_name]
        
        geom = shape(feat["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        geometries.append(geom)
        geom_tz_ids.append(tz_id)
    
    print(f"Found {len(tz_names)} unique timezones")
    
    tree = STRtree(geometries)
    
    # Build 180x360 grid
    grid = [[0] * 360 for _ in range(180)]
    
    print("Building grid...")
    for lat_idx in tqdm(range(180), desc="Processing rows"):
        lat = -90 + lat_idx + 0.5
        
        for lon_idx in range(360):
            lon = -180 + lon_idx + 0.5
            pt = Point(lon, lat)
            
            for idx in tree.query(pt):
                if geometries[idx].contains(pt):
                    grid[lat_idx][lon_idx] = geom_tz_ids[idx]
                    break
    
    return grid, tz_names


def rle_encode_row(row: list[int]) -> bytes:
    """RLE encode a single row. Each entry is (count: u8, tz_id: u16)."""
    result = bytearray()
    i = 0
    while i < len(row):
        value = row[i]
        count = 1
        while i + count < len(row) and row[i + count] == value and count < 255:
            count += 1
        result.append(count)
        result.extend(struct.pack('<H', value))  # tz_id is u16
        i += count
    return bytes(result)


def generate_files(
    grid: list[list[int]],
    tz_index_entries: list[tuple[int, int, int]],
    tz_transitions: list[tuple[int, int]],
):
    """Generate the timezone grid and transition binary files."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # 1. RLE data for each row
    rle_rows = [rle_encode_row(row) for row in grid]
    rle_bin = b''.join(rle_rows)
    rle_file = OUTPUT_DIR / "tz_rle.bin"
    with open(rle_file, 'wb') as f:
        f.write(rle_bin)
    print(f"Wrote {rle_file}: {len(rle_bin)} bytes")
    
    # 2. Row index: offset into RLE data for each row (u16)
    row_offsets = []
    offset = 0
    for rle in rle_rows:
        row_offsets.append(offset)
        offset += len(rle)
    
    index_bin = b''.join(struct.pack('<H', off) for off in row_offsets)
    index_file = OUTPUT_DIR / "tz_row_index.bin"
    with open(index_file, 'wb') as f:
        f.write(index_bin)
    print(f"Wrote {index_file}: {len(index_bin)} bytes (180 rows)")

    # 3. Transition index: per-tz_id base offset + transitions slice info
    index_data = bytearray()
    for base_offset, first_index, count in tz_index_entries:
        index_data.extend(struct.pack('<hIH', base_offset, first_index, count))
    tz_index_file = OUTPUT_DIR / "tz_transition_index.bin"
    with open(tz_index_file, 'wb') as f:
        f.write(index_data)
    print(f"Wrote {tz_index_file}: {len(index_data)} bytes ({len(tz_index_entries)} zones)")

    # 4. Transitions: (utc_ts: u32, offset_minutes: i16)
    transitions_data = bytearray()
    for ts, offset in tz_transitions:
        transitions_data.extend(struct.pack('<Ih', ts, offset))
    tz_transitions_file = OUTPUT_DIR / "tz_transitions.bin"
    with open(tz_transitions_file, 'wb') as f:
        f.write(transitions_data)
    print(f"Wrote {tz_transitions_file}: {len(transitions_data)} bytes ({len(tz_transitions)} transitions)")
    
    # Total size
    total = len(rle_bin) + len(index_bin) + len(index_data) + len(transitions_data)
    print(f"\nTotal: {total} bytes ({total/1024:.1f} KB)")


def verify_files(
    grid: list[list[int]],
    tz_index_entries: list[tuple[int, int, int]],
    tz_transitions: list[tuple[int, int]],
):
    """Verify the generated files can be parsed correctly."""
    # Read files back
    with open(OUTPUT_DIR / "tz_row_index.bin", 'rb') as f:
        index_data = f.read()
    with open(OUTPUT_DIR / "tz_rle.bin", 'rb') as f:
        rle_data = f.read()
    with open(OUTPUT_DIR / "tz_transition_index.bin", 'rb') as f:
        tz_index_data = f.read()
    with open(OUTPUT_DIR / "tz_transitions.bin", 'rb') as f:
        tz_transitions_data = f.read()
    
    # Parse transition index
    expected_index_len = len(tz_index_entries) * 8
    assert len(tz_index_data) == expected_index_len, "Transition index length mismatch"
    parsed_index = []
    for i in range(0, len(tz_index_data), 8):
        base_offset, first_index, count = struct.unpack_from('<hIH', tz_index_data, i)
        parsed_index.append((base_offset, first_index, count))
    assert parsed_index == tz_index_entries, "Transition index mismatch"

    # Parse transitions data
    expected_trans_len = len(tz_transitions) * 6
    assert len(tz_transitions_data) == expected_trans_len, "Transitions length mismatch"
    parsed_transitions = []
    for i in range(0, len(tz_transitions_data), 6):
        ts, offset = struct.unpack_from('<Ih', tz_transitions_data, i)
        parsed_transitions.append((ts, offset))
    assert parsed_transitions == tz_transitions, "Transitions data mismatch"
    
    # Parse and verify each row
    for lat_idx in range(180):
        row_offset = struct.unpack('<H', index_data[lat_idx*2:lat_idx*2+2])[0]
        
        # Decode RLE
        pos = row_offset
        decoded = []
        while len(decoded) < 360:
            count = rle_data[pos]
            tz_id = struct.unpack('<H', rle_data[pos+1:pos+3])[0]
            decoded.extend([tz_id] * count)
            pos += 3
        
        assert decoded == grid[lat_idx], f"Row {lat_idx} mismatch"
    
    print("Verification passed!")


def main():
    print("=== Timezone Grid Generator (Full DST Support) ===\n")
    
    geojson = download_timezone_data()
    grid, tz_names = build_timezone_grid(geojson)
    
    print("\nBuilding DST transitions...")
    tz_index_entries, tz_transitions = build_transition_tables(tz_names)
    
    print("\nGenerating binary files...")
    generate_files(grid, tz_index_entries, tz_transitions)
    
    print("\nVerifying...")
    verify_files(grid, tz_index_entries, tz_transitions)
    
    # Sample lookups
    print("\n=== Sample Lookups ===")
    test_points = [
        (39.9, 116.4, "Beijing"),
        (35.7, 139.7, "Tokyo"),
        (51.5, -0.1, "London"),
        (40.7, -74.0, "New York"),
        (0.0, 0.0, "Atlantic Ocean"),
        (-33.9, 151.2, "Sydney"),
        (28.6, 77.2, "Delhi"),
    ]
    
    for lat, lon, name in test_points:
        lat_idx = int(lat + 90)
        lon_idx = int(lon + 180)
        if 0 <= lat_idx < 180 and 0 <= lon_idx < 360:
            tz_id = grid[lat_idx][lon_idx]
            tz_name = tz_names[tz_id]
            print(f"  {name}: ({lat}, {lon}) -> {tz_name}")


if __name__ == "__main__":
    main()
