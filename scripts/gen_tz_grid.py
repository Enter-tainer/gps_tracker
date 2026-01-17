#!/usr/bin/env python3
"""
Generate timezone grid data for embedded Rust firmware.

Outputs three files:
  - firmware/data/tz_offsets.bin: UTC offset table (i16 minutes per offset_id)
  - firmware/data/tz_row_index.bin: Row index (u16 offset into RLE data per latitude)
  - firmware/data/tz_rle.bin: RLE encoded grid data (count, offset_id pairs)

Usage:
    uv run --with shapely,requests,tqdm python scripts/gen_tz_grid.py
"""

import json
import struct
import zipfile
import io
from pathlib import Path

import requests
from tqdm import tqdm
from shapely.geometry import shape, Point
from shapely import STRtree
from shapely.validation import make_valid

CACHE_DIR = Path(__file__).parent / ".cache"
OUTPUT_DIR = Path(__file__).parent.parent / "firmware" / "data"

GEOJSON_URL = "https://github.com/evansiroky/timezone-boundary-builder/releases/download/2025c/timezones-now.geojson.zip"

# Standard UTC offsets in minutes for each IANA timezone
# This maps timezone name -> offset in minutes
TZ_OFFSETS = {
    "Etc/UTC": 0,
    "Africa/Abidjan": 0,
    "Europe/Moscow": 180,
    "Africa/Lagos": 60,
    "Africa/Johannesburg": 120,
    "Africa/Cairo": 120,
    "Africa/Casablanca": 60,
    "Europe/Paris": 60,
    "America/Adak": -600,
    "America/Anchorage": -540,
    "America/Caracas": -240,
    "America/Sao_Paulo": -180,
    "America/Lima": -300,
    "America/Mexico_City": -360,
    "America/Denver": -420,
    "America/Chicago": -360,
    "America/Phoenix": -420,
    "America/New_York": -300,
    "America/Halifax": -240,
    "America/Havana": -300,
    "America/Los_Angeles": -480,
    "America/Miquelon": -180,
    "America/Noronha": -120,
    "America/Nuuk": -120,
    "America/Santiago": -240,
    "America/St_Johns": -210,  # -3:30
    "Asia/Manila": 480,
    "Asia/Jakarta": 420,
    "Australia/Brisbane": 600,
    "Australia/Sydney": 600,
    "Asia/Karachi": 300,
    "Pacific/Auckland": 720,
    "Antarctica/Troll": 0,
    "Pacific/Fiji": 720,
    "Asia/Dubai": 240,
    "Asia/Beirut": 120,
    "Asia/Dhaka": 360,
    "Asia/Tokyo": 540,
    "Asia/Kolkata": 330,  # +5:30
    "Europe/Athens": 120,
    "Asia/Gaza": 120,
    "Asia/Jerusalem": 120,
    "Asia/Kabul": 270,  # +4:30
    "Asia/Kathmandu": 345,  # +5:45
    "Asia/Sakhalin": 660,
    "Asia/Tehran": 210,  # +3:30
    "Asia/Yangon": 390,  # +6:30
    "Atlantic/Azores": -60,
    "Europe/London": 0,
    "Atlantic/Cape_Verde": -60,
    "Australia/Adelaide": 570,  # +9:30
    "Australia/Darwin": 570,  # +9:30
    "Australia/Eucla": 525,  # +8:45
    "Australia/Lord_Howe": 630,  # +10:30
    "Europe/Chisinau": 120,
    "Pacific/Tongatapu": 780,
    "Pacific/Chatham": 765,  # +12:45
    "Pacific/Easter": -360,
    "Pacific/Gambier": -540,
    "Pacific/Honolulu": -600,
    "Pacific/Kiritimati": 840,
    "Pacific/Marquesas": -570,  # -9:30
    "Pacific/Pago_Pago": -660,
    "Pacific/Norfolk": 660,
    "Pacific/Pitcairn": -480,
}


def download_timezone_data() -> dict:
    """Download and cache timezone boundary GeoJSON."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / "timezones-now-2025c.geojson"
    
    if cache_file.exists():
        print(f"Using cached data: {cache_file}")
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    
    print(f"Downloading timezone data from {GEOJSON_URL}...")
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


def build_timezone_grid(geojson: dict) -> tuple[list[list[int]], list[int]]:
    """
    Build a 1x1 degree grid of offset IDs.
    
    Returns:
        (grid, offset_table) where:
        - grid[lat][lon] = offset_id
        - offset_table[offset_id] = UTC offset in minutes
    """
    features = geojson["features"]
    
    # Build offset table: unique offsets only
    offset_to_id: dict[int, int] = {0: 0}  # UTC = 0
    offset_table = [0]  # offset_id 0 = UTC
    
    # Map timezone name -> offset_id
    tz_to_offset_id: dict[str, int] = {"Etc/UTC": 0}
    
    print("Building spatial index...")
    geometries = []
    geom_offset_ids = []
    
    for feat in tqdm(features, desc="Loading geometries"):
        tz_name = feat["properties"]["tzid"]
        
        # Get UTC offset for this timezone
        offset_mins = TZ_OFFSETS.get(tz_name, 0)
        
        # Get or create offset_id
        if offset_mins not in offset_to_id:
            offset_to_id[offset_mins] = len(offset_table)
            offset_table.append(offset_mins)
        
        offset_id = offset_to_id[offset_mins]
        tz_to_offset_id[tz_name] = offset_id
        
        geom = shape(feat["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        geometries.append(geom)
        geom_offset_ids.append(offset_id)
    
    print(f"Found {len(offset_table)} unique UTC offsets")
    
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
                    grid[lat_idx][lon_idx] = geom_offset_ids[idx]
                    break
    
    return grid, offset_table


def rle_encode_row(row: list[int]) -> bytes:
    """RLE encode a single row."""
    result = bytearray()
    i = 0
    while i < len(row):
        value = row[i]
        count = 1
        while i + count < len(row) and row[i + count] == value and count < 255:
            count += 1
        result.append(count)
        result.append(value)
        i += count
    return bytes(result)


def generate_files(grid: list[list[int]], offset_table: list[int]):
    """Generate the three binary files."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # 1. Offset table: array of i16
    offsets_bin = b''.join(struct.pack('<h', off) for off in offset_table)
    offsets_file = OUTPUT_DIR / "tz_offsets.bin"
    with open(offsets_file, 'wb') as f:
        f.write(offsets_bin)
    print(f"Wrote {offsets_file}: {len(offsets_bin)} bytes ({len(offset_table)} offsets)")
    
    # 2. RLE data for each row
    rle_rows = [rle_encode_row(row) for row in grid]
    rle_bin = b''.join(rle_rows)
    rle_file = OUTPUT_DIR / "tz_rle.bin"
    with open(rle_file, 'wb') as f:
        f.write(rle_bin)
    print(f"Wrote {rle_file}: {len(rle_bin)} bytes")
    
    # 3. Row index: offset into RLE data for each row (u16)
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
    
    # Total size
    total = len(offsets_bin) + len(rle_bin) + len(index_bin)
    print(f"\nTotal: {total} bytes ({total/1024:.1f} KB)")
    
    return offset_table, rle_rows, row_offsets


def verify_files(grid: list[list[int]], offset_table: list[int]):
    """Verify the generated files can be parsed correctly."""
    # Read files back
    with open(OUTPUT_DIR / "tz_offsets.bin", 'rb') as f:
        offsets_data = f.read()
    with open(OUTPUT_DIR / "tz_row_index.bin", 'rb') as f:
        index_data = f.read()
    with open(OUTPUT_DIR / "tz_rle.bin", 'rb') as f:
        rle_data = f.read()
    
    # Parse offset table
    num_offsets = len(offsets_data) // 2
    offsets = [struct.unpack('<h', offsets_data[i*2:i*2+2])[0] for i in range(num_offsets)]
    assert offsets == offset_table, "Offset table mismatch"
    
    # Parse and verify each row
    for lat_idx in range(180):
        row_offset = struct.unpack('<H', index_data[lat_idx*2:lat_idx*2+2])[0]
        
        # Decode RLE
        pos = row_offset
        decoded = []
        while len(decoded) < 360:
            count = rle_data[pos]
            offset_id = rle_data[pos + 1]
            decoded.extend([offset_id] * count)
            pos += 2
        
        assert decoded == grid[lat_idx], f"Row {lat_idx} mismatch"
    
    print("Verification passed!")


def main():
    print("=== Timezone Grid Generator ===\n")
    
    geojson = download_timezone_data()
    grid, offset_table = build_timezone_grid(geojson)
    
    print("\nGenerating binary files...")
    generate_files(grid, offset_table)
    
    print("\nVerifying...")
    verify_files(grid, offset_table)
    
    # Print offset table for reference
    print("\nOffset table (offset_id -> minutes):")
    for i, off in enumerate(offset_table):
        hours = off // 60
        mins = abs(off) % 60
        sign = '+' if off >= 0 else '-'
        if mins:
            print(f"  {i}: {sign}{abs(hours)}:{mins:02d}")
        else:
            print(f"  {i}: {sign}{abs(hours)}")
    
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
            offset_id = grid[lat_idx][lon_idx]
            offset_mins = offset_table[offset_id]
            hours = offset_mins // 60
            mins = abs(offset_mins) % 60
            sign = '+' if offset_mins >= 0 else ''
            if mins:
                print(f"  {name}: ({lat}, {lon}) -> UTC{sign}{hours}:{mins:02d}")
            else:
                print(f"  {name}: ({lat}, {lon}) -> UTC{sign}{hours}")


if __name__ == "__main__":
    main()
