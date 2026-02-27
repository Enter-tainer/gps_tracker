"""
GPS Tracker custom binary format encoder/decoder.

The format uses delta compression with varint encoding to efficiently store
GPS trajectory data.

Block types:
- Full Block (0xFF): Complete GPS data (timestamp, lat, lon, alt)
- Delta Block (0x0X): Compressed delta values for changed fields
"""

import argparse
import json
import struct
from datetime import datetime
from pathlib import Path
from typing import Optional


class GpsPoint:
    """GPS point with scaled values."""

    def __init__(
        self,
        timestamp: int,
        latitude_scaled_1e5: int,
        longitude_scaled_1e5: int,
        altitude_m_scaled_1e1: int,
    ):
        self.timestamp = timestamp
        self.latitude_scaled_1e5 = latitude_scaled_1e5
        self.longitude_scaled_1e5 = longitude_scaled_1e5
        self.altitude_m_scaled_1e1 = altitude_m_scaled_1e1

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "timestamp_iso": datetime.fromtimestamp(
                self.timestamp
            ).isoformat(),
            "latitude": self.latitude_scaled_1e5 / 1e5,
            "longitude": self.longitude_scaled_1e5 / 1e5,
            "altitude": self.altitude_m_scaled_1e1 / 10.0,
            "latitude_scaled": self.latitude_scaled_1e5,
            "longitude_scaled": self.longitude_scaled_1e5,
            "altitude_scaled": self.altitude_m_scaled_1e1,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GpsPoint":
        if "latitude_scaled" in data:
            return cls(
                data["timestamp"],
                data["latitude_scaled"],
                data["longitude_scaled"],
                data["altitude_scaled"],
            )
        return cls(
            int(data["timestamp"]),
            int(data["latitude"] * 1e5),
            int(data["longitude"] * 1e5),
            int(data["altitude"] * 10),
        )


class GpsFormatDecoder:
    """Decoder for the custom GPS binary format."""

    def __init__(self):
        self.previous_point: Optional[GpsPoint] = None
        self.is_first_point = True

    def _read_varint_s32(
        self, data: bytes, offset: int
    ) -> tuple[int, int]:
        unsigned_val = 0
        shift = 0
        i = 0

        while i < 5:
            if offset + i >= len(data):
                raise ValueError(
                    "Buffer underflow while reading varint"
                )
            byte = data[offset + i]
            unsigned_val |= (byte & 0x7F) << shift
            shift += 7
            i += 1
            if (byte & 0x80) == 0:
                result = (unsigned_val >> 1) ^ -(unsigned_val & 1)
                return result, i

        raise ValueError("Varint too long or malformed")

    def _read_uint32_le(self, data: bytes, offset: int) -> int:
        return struct.unpack("<I", data[offset : offset + 4])[0]

    def _read_int32_le(self, data: bytes, offset: int) -> int:
        return struct.unpack("<i", data[offset : offset + 4])[0]

    def decode_block(
        self, data: bytes, offset: int
    ) -> tuple[GpsPoint, int, str]:
        if offset >= len(data):
            raise ValueError("Buffer underflow: cannot read header")

        header = data[offset]
        offset += 1

        if header == 0xFF:
            if offset + 16 > len(data):
                raise ValueError(
                    "Buffer underflow for Full Block payload"
                )
            timestamp = self._read_uint32_le(data, offset)
            latitude = self._read_int32_le(data, offset + 4)
            longitude = self._read_int32_le(data, offset + 8)
            altitude = self._read_int32_le(data, offset + 12)

            point = GpsPoint(timestamp, latitude, longitude, altitude)
            self.previous_point = point
            self.is_first_point = False
            return point, 17, "full"

        elif (header & 0x80) == 0:
            if self.is_first_point:
                raise ValueError(
                    "Invalid data: Delta Block found as first block"
                )
            if (header & 0x70) != 0:
                raise ValueError(
                    f"Invalid Delta Block header: 0x{header:02X}"
                )

            current_point = GpsPoint(
                self.previous_point.timestamp,
                self.previous_point.latitude_scaled_1e5,
                self.previous_point.longitude_scaled_1e5,
                self.previous_point.altitude_m_scaled_1e1,
            )

            flags = header & 0x0F
            payload_offset = offset
            bytes_consumed = 1

            if (flags >> 3) & 1:
                delta, consumed = self._read_varint_s32(
                    data, payload_offset
                )
                current_point.timestamp = (
                    current_point.timestamp + delta
                ) & 0xFFFFFFFF
                payload_offset += consumed
                bytes_consumed += consumed

            if (flags >> 2) & 1:
                delta, consumed = self._read_varint_s32(
                    data, payload_offset
                )
                current_point.latitude_scaled_1e5 += delta
                payload_offset += consumed
                bytes_consumed += consumed

            if (flags >> 1) & 1:
                delta, consumed = self._read_varint_s32(
                    data, payload_offset
                )
                current_point.longitude_scaled_1e5 += delta
                payload_offset += consumed
                bytes_consumed += consumed

            if flags & 1:
                delta, consumed = self._read_varint_s32(
                    data, payload_offset
                )
                current_point.altitude_m_scaled_1e1 += delta
                payload_offset += consumed
                bytes_consumed += consumed

            self.previous_point = current_point
            return current_point, bytes_consumed, "delta"

        else:
            raise ValueError(
                f"Invalid block header: 0x{header:02X}"
            )

    def decode_file(self, data: bytes) -> list[dict]:
        points = []
        offset = 0
        block_index = 0

        while offset < len(data):
            try:
                point, consumed, block_type = self.decode_block(
                    data, offset
                )
                points.append(
                    {
                        "index": block_index,
                        "type": block_type,
                        "data": point.to_dict(),
                    }
                )
                offset += consumed
                block_index += 1
            except Exception as e:
                print(
                    f"Error decoding block {block_index} at offset {offset}: {e}"
                )
                break

        return points


class GpsFormatEncoder:
    """Encoder for the custom GPS binary format."""

    def __init__(self, full_block_interval: int = 64):
        self.full_block_interval = max(1, full_block_interval)
        self.previous_point: Optional[GpsPoint] = None
        self.is_first_point = True
        self.points_since_last_full = 0
        self.output_buffer = bytearray()

    def _write_varint_s32(self, value: int) -> bytes:
        zz_value = (value << 1) ^ (value >> 31)
        result = bytearray()
        while zz_value >= 0x80:
            result.append(zz_value | 0x80)
            zz_value >>= 7
        result.append(zz_value)
        return result

    def _write_uint32_le(self, value: int) -> bytes:
        return struct.pack("<I", value)

    def _write_int32_le(self, value: int) -> bytes:
        return struct.pack("<i", value)

    def encode_point(self, point: GpsPoint) -> bytes:
        block_data = bytearray()

        use_full_block = False
        if self.is_first_point:
            use_full_block = True
        elif self.full_block_interval == 1:
            use_full_block = True
        elif (
            self.points_since_last_full
            >= self.full_block_interval - 1
        ):
            use_full_block = True

        if use_full_block:
            block_data.append(0xFF)
            block_data.extend(
                self._write_uint32_le(point.timestamp)
            )
            block_data.extend(
                self._write_int32_le(point.latitude_scaled_1e5)
            )
            block_data.extend(
                self._write_int32_le(point.longitude_scaled_1e5)
            )
            block_data.extend(
                self._write_int32_le(point.altitude_m_scaled_1e1)
            )
            self.points_since_last_full = 0
            self.is_first_point = False
        else:
            delta_timestamp = (
                point.timestamp - self.previous_point.timestamp
            )
            delta_latitude = (
                point.latitude_scaled_1e5
                - self.previous_point.latitude_scaled_1e5
            )
            delta_longitude = (
                point.longitude_scaled_1e5
                - self.previous_point.longitude_scaled_1e5
            )
            delta_altitude = (
                point.altitude_m_scaled_1e1
                - self.previous_point.altitude_m_scaled_1e1
            )

            header = 0x00
            if delta_timestamp != 0:
                header |= 1 << 3
            if delta_latitude != 0:
                header |= 1 << 2
            if delta_longitude != 0:
                header |= 1 << 1
            if delta_altitude != 0:
                header |= 1 << 0

            block_data.append(header)

            if delta_timestamp != 0:
                block_data.extend(
                    self._write_varint_s32(delta_timestamp)
                )
            if delta_latitude != 0:
                block_data.extend(
                    self._write_varint_s32(delta_latitude)
                )
            if delta_longitude != 0:
                block_data.extend(
                    self._write_varint_s32(delta_longitude)
                )
            if delta_altitude != 0:
                block_data.extend(
                    self._write_varint_s32(delta_altitude)
                )

            self.points_since_last_full += 1

        self.previous_point = point
        return block_data

    def encode_points(self, points: list[GpsPoint]) -> bytes:
        self.output_buffer.clear()
        for point in points:
            block_data = self.encode_point(point)
            self.output_buffer.extend(block_data)
        return bytes(self.output_buffer)


def convert_to_gpx(
    points_data: list[dict], filename: str = "track"
) -> str:
    """Convert decoded points to GPX format."""
    if not points_data:
        return ""

    points = [item["data"] for item in points_data]

    gpx = f"""<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"
    version="1.1" creator="gps-tracker-tools">
  <metadata>
    <name>{filename}</name>
    <time>{datetime.fromtimestamp(points[0]['timestamp']).isoformat()}</time>
  </metadata>
  <trk>
    <name>{filename}</name>
    <trkseg>
"""
    for point in points:
        lat = point["latitude"]
        lon = point["longitude"]
        ele = point["altitude"]
        ts = datetime.fromtimestamp(point["timestamp"]).isoformat()

        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            print(f"Skipping invalid point: Lat {lat}, Lon {lon}")
            continue

        gpx += f'      <trkpt lat="{lat:.5f}" lon="{lon:.5f}">\n'
        gpx += f"        <ele>{ele:.1f}</ele>\n"
        gpx += f"        <time>{ts}</time>\n"
        gpx += "      </trkpt>\n"

    gpx += """    </trkseg>
  </trk>
</gpx>"""
    return gpx


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_decode(args):
    with open(args.input, "rb") as f:
        binary_data = f.read()

    decoder = GpsFormatDecoder()
    points = decoder.decode_file(binary_data)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(
            {
                "file_info": {
                    "input_file": args.input,
                    "total_points": len(points),
                    "format_version": "1.0",
                },
                "points": points,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )
    print(f"Decoded {len(points)} points to {args.output}")


def cmd_encode(args):
    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    points_data = data["points"] if "points" in data else data
    if isinstance(points_data[0], dict) and "data" in points_data[0]:
        points = [
            GpsPoint.from_dict(item["data"]) for item in points_data
        ]
    else:
        points = [GpsPoint.from_dict(item) for item in points_data]

    encoder = GpsFormatEncoder(args.full_interval)
    binary_data = encoder.encode_points(points)

    with open(args.output, "wb") as f:
        f.write(binary_data)
    print(
        f"Encoded {len(points)} points to {args.output} ({len(binary_data)} bytes)"
    )


def cmd_to_gpx(args):
    with open(args.input, "rb") as f:
        binary_data = f.read()

    decoder = GpsFormatDecoder()
    points = decoder.decode_file(binary_data)
    gpx_content = convert_to_gpx(points, Path(args.input).stem)

    with open(args.output, "w", encoding="utf-8") as f:
        f.write(gpx_content)
    print(
        f"Converted {len(points)} points to GPX: {args.output}"
    )


def cmd_validate(args):
    with open(args.input, "rb") as f:
        binary_data = f.read()

    decoder = GpsFormatDecoder()
    points = decoder.decode_file(binary_data)

    print("File validation successful!")
    print(f"  Total points: {len(points)}")
    print(f"  File size: {len(binary_data)} bytes")

    full_blocks = sum(1 for p in points if p["type"] == "full")
    delta_blocks = sum(1 for p in points if p["type"] == "delta")

    print(f"  Full blocks: {full_blocks}")
    print(f"  Delta blocks: {delta_blocks}")

    if len(points) >= 2:
        first_ts = points[0]["data"]["timestamp"]
        last_ts = points[-1]["data"]["timestamp"]
        duration = last_ts - first_ts
        print(
            f"  Duration: {duration} seconds ({duration/3600:.1f} hours)"
        )

    if points:
        print(
            f"  Compression ratio: {len(binary_data) / (len(points) * 16):.2f}x"
        )


# ---------------------------------------------------------------------------
# CLI setup
# ---------------------------------------------------------------------------


def add_subcommands(subparsers) -> None:
    """Register GPS format subcommands."""
    decode_p = subparsers.add_parser(
        "decode", help="Decode binary file to JSON"
    )
    decode_p.add_argument("input", help="Input binary file")
    decode_p.add_argument("output", help="Output JSON file")
    decode_p.add_argument(
        "--full-interval",
        type=int,
        default=64,
        help="Full block interval (default: 64)",
    )
    decode_p.set_defaults(func=cmd_decode)

    encode_p = subparsers.add_parser(
        "encode", help="Encode JSON to binary file"
    )
    encode_p.add_argument("input", help="Input JSON file")
    encode_p.add_argument("output", help="Output binary file")
    encode_p.add_argument(
        "--full-interval",
        type=int,
        default=64,
        help="Full block interval (default: 64)",
    )
    encode_p.set_defaults(func=cmd_encode)

    gpx_p = subparsers.add_parser(
        "to-gpx", help="Convert binary file to GPX format"
    )
    gpx_p.add_argument("input", help="Input binary file")
    gpx_p.add_argument("output", help="Output GPX file")
    gpx_p.set_defaults(func=cmd_to_gpx)

    validate_p = subparsers.add_parser(
        "validate", help="Validate binary file format"
    )
    validate_p.add_argument("input", help="Input binary file")
    validate_p.set_defaults(func=cmd_validate)


def main():
    parser = argparse.ArgumentParser(
        description="GPS Tracker custom binary format tool"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    add_subcommands(sub)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    exit(main())
