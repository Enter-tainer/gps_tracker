#!/usr/bin/env python3
"""
GPS Tracker Custom Binary Format Tool

This tool provides encoding and decoding functionality for the custom GPS data format
used in the MGT GPS Tracker project. The format uses delta compression with varint
encoding to efficiently store GPS trajectory data.

Features:
- Decode binary GPS files to human-readable JSON format
- Encode JSON data back to binary format
- Convert binary files to GPX format
- Validate file format integrity

The binary format supports two block types:
- Full Block (0xFF): Contains complete GPS data (timestamp, lat, lon, alt)
- Delta Block (0x0X): Contains compressed delta values for changed fields
"""

import struct
import json
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, BinaryIO


class GpsPoint:
    """Represents a GPS point with scaled values"""
    def __init__(self, timestamp: int, latitude_scaled_1e5: int, 
                 longitude_scaled_1e5: int, altitude_m_scaled_1e1: int):
        self.timestamp = timestamp
        self.latitude_scaled_1e5 = latitude_scaled_1e5
        self.longitude_scaled_1e5 = longitude_scaled_1e5
        self.altitude_m_scaled_1e1 = altitude_m_scaled_1e1
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization"""
        return {
            'timestamp': self.timestamp,
            'timestamp_iso': datetime.fromtimestamp(self.timestamp).isoformat(),
            'latitude': self.latitude_scaled_1e5 / 1e5,
            'longitude': self.longitude_scaled_1e5 / 1e5,
            'altitude': self.altitude_m_scaled_1e1 / 10.0,
            'latitude_scaled': self.latitude_scaled_1e5,
            'longitude_scaled': self.longitude_scaled_1e5,
            'altitude_scaled': self.altitude_m_scaled_1e1
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'GpsPoint':
        """Create from dictionary (supports both scaled and unscaled values)"""
        if 'latitude_scaled' in data:
            return cls(
                data['timestamp'],
                data['latitude_scaled'],
                data['longitude_scaled'],
                data['altitude_scaled']
            )
        else:
            return cls(
                int(data['timestamp']),
                int(data['latitude'] * 1e5),
                int(data['longitude'] * 1e5),
                int(data['altitude'] * 10)
            )


class GpsFormatDecoder:
    """Decoder for the custom GPS binary format"""
    
    def __init__(self):
        self.previous_point: Optional[GpsPoint] = None
        self.is_first_point = True
    
    def _read_varint_s32(self, data: bytes, offset: int) -> tuple[int, int]:
        """Read ZigZag encoded varint from bytes
        
        Returns:
            tuple[value, bytes_consumed]
        """
        unsigned_val = 0
        shift = 0
        i = 0
        
        while i < 5:  # Max 5 bytes for 32-bit varint
            if offset + i >= len(data):
                raise ValueError("Buffer underflow while reading varint")
            
            byte = data[offset + i]
            unsigned_val |= (byte & 0x7F) << shift
            shift += 7
            i += 1
            
            if (byte & 0x80) == 0:
                # ZigZag decode
                result = (unsigned_val >> 1) ^ -(unsigned_val & 1)
                return result, i
        
        raise ValueError("Varint too long or malformed")
    
    def _read_uint32_le(self, data: bytes, offset: int) -> int:
        """Read little-endian uint32"""
        return struct.unpack('<I', data[offset:offset + 4])[0]
    
    def _read_int32_le(self, data: bytes, offset: int) -> int:
        """Read little-endian int32"""
        return struct.unpack('<i', data[offset:offset + 4])[0]
    
    def decode_block(self, data: bytes, offset: int) -> tuple[GpsPoint, int, str]:
        """Decode a single block from the binary format
        
        Returns:
            tuple[point, bytes_consumed, block_type]
        """
        if offset >= len(data):
            raise ValueError("Buffer underflow: cannot read header")
        
        header = data[offset]
        offset += 1
        
        if header == 0xFF:  # Full Block
            if offset + 16 > len(data):
                raise ValueError("Buffer underflow for Full Block payload")
            
            timestamp = self._read_uint32_le(data, offset)
            latitude = self._read_int32_le(data, offset + 4)
            longitude = self._read_int32_le(data, offset + 8)
            altitude = self._read_int32_le(data, offset + 12)
            
            point = GpsPoint(timestamp, latitude, longitude, altitude)
            self.previous_point = point
            self.is_first_point = False
            
            return point, 17, "full"  # 1 header + 16 payload
        
        elif (header & 0x80) == 0:  # Delta Block
            if self.is_first_point:
                raise ValueError("Invalid data: Delta Block found as first block")
            
            if (header & 0x70) != 0:  # Check reserved bits (4-6)
                raise ValueError(f"Invalid Delta Block header: 0x{header:02X}")
            
            # Start with previous point values
            current_point = GpsPoint(
                self.previous_point.timestamp,
                self.previous_point.latitude_scaled_1e5,
                self.previous_point.longitude_scaled_1e5,
                self.previous_point.altitude_m_scaled_1e1
            )
            
            flags = header & 0x0F
            payload_offset = offset
            bytes_consumed = 1  # header
            
            # Process flags in order: timestamp, lat, lon, alt
            if (flags >> 3) & 1:  # timestamp delta
                delta, consumed = self._read_varint_s32(data, payload_offset)
                current_point.timestamp = (current_point.timestamp + delta) & 0xFFFFFFFF
                payload_offset += consumed
                bytes_consumed += consumed
            
            if (flags >> 2) & 1:  # latitude delta
                delta, consumed = self._read_varint_s32(data, payload_offset)
                current_point.latitude_scaled_1e5 += delta
                payload_offset += consumed
                bytes_consumed += consumed
            
            if (flags >> 1) & 1:  # longitude delta
                delta, consumed = self._read_varint_s32(data, payload_offset)
                current_point.longitude_scaled_1e5 += delta
                payload_offset += consumed
                bytes_consumed += consumed
            
            if flags & 1:  # altitude delta
                delta, consumed = self._read_varint_s32(data, payload_offset)
                current_point.altitude_m_scaled_1e1 += delta
                payload_offset += consumed
                bytes_consumed += consumed
            
            self.previous_point = current_point
            return current_point, bytes_consumed, "delta"
        
        else:
            raise ValueError(f"Invalid block header: 0x{header:02X}")
    
    def decode_file(self, data: bytes) -> List[Dict]:
        """Decode entire binary file to list of points"""
        points = []
        offset = 0
        block_index = 0
        
        while offset < len(data):
            try:
                point, consumed, block_type = self.decode_block(data, offset)
                points.append({
                    'index': block_index,
                    'type': block_type,
                    'data': point.to_dict()
                })
                offset += consumed
                block_index += 1
            except Exception as e:
                print(f"Error decoding block {block_index} at offset {offset}: {e}")
                break
        
        return points


class GpsFormatEncoder:
    """Encoder for the custom GPS binary format"""
    
    def __init__(self, full_block_interval: int = 64):
        self.full_block_interval = max(1, full_block_interval)
        self.previous_point: Optional[GpsPoint] = None
        self.is_first_point = True
        self.points_since_last_full = 0
        self.output_buffer = bytearray()
    
    def _write_varint_s32(self, value: int) -> bytes:
        """Write ZigZag encoded varint"""
        # ZigZag encode
        zz_value = (value << 1) ^ (value >> 31)
        
        # Varint encode
        result = bytearray()
        while zz_value >= 0x80:
            result.append(zz_value | 0x80)
            zz_value >>= 7
        result.append(zz_value)
        return result
    
    def _write_uint32_le(self, value: int) -> bytes:
        """Write little-endian uint32"""
        return struct.pack('<I', value)
    
    def _write_int32_le(self, value: int) -> bytes:
        """Write little-endian int32"""
        return struct.pack('<i', value)
    
    def encode_point(self, point: GpsPoint) -> bytes:
        """Encode a single point to binary format"""
        block_data = bytearray()
        
        # Determine if we should use full block
        use_full_block = False
        if self.is_first_point:
            use_full_block = True
        elif self.full_block_interval == 1:
            use_full_block = True
        elif self.points_since_last_full >= self.full_block_interval - 1:
            use_full_block = True
        
        if use_full_block:
            # Full Block
            block_data.append(0xFF)
            block_data.extend(self._write_uint32_le(point.timestamp))
            block_data.extend(self._write_int32_le(point.latitude_scaled_1e5))
            block_data.extend(self._write_int32_le(point.longitude_scaled_1e5))
            block_data.extend(self._write_int32_le(point.altitude_m_scaled_1e1))
            
            self.points_since_last_full = 0
            self.is_first_point = False
        else:
            # Delta Block
            delta_timestamp = point.timestamp - self.previous_point.timestamp
            delta_latitude = point.latitude_scaled_1e5 - self.previous_point.latitude_scaled_1e5
            delta_longitude = point.longitude_scaled_1e5 - self.previous_point.longitude_scaled_1e5
            delta_altitude = point.altitude_m_scaled_1e1 - self.previous_point.altitude_m_scaled_1e1
            
            # Build header
            header = 0x00
            if delta_timestamp != 0:
                header |= (1 << 3)
            if delta_latitude != 0:
                header |= (1 << 2)
            if delta_longitude != 0:
                header |= (1 << 1)
            if delta_altitude != 0:
                header |= (1 << 0)
            
            block_data.append(header)
            
            # Add delta values in order: timestamp, lat, lon, alt
            if delta_timestamp != 0:
                block_data.extend(self._write_varint_s32(delta_timestamp))
            if delta_latitude != 0:
                block_data.extend(self._write_varint_s32(delta_latitude))
            if delta_longitude != 0:
                block_data.extend(self._write_varint_s32(delta_longitude))
            if delta_altitude != 0:
                block_data.extend(self._write_varint_s32(delta_altitude))
            
            self.points_since_last_full += 1
        
        self.previous_point = point
        return block_data
    
    def encode_points(self, points: List[GpsPoint]) -> bytes:
        """Encode list of points to binary format"""
        self.output_buffer.clear()
        
        for point in points:
            block_data = self.encode_point(point)
            self.output_buffer.extend(block_data)
        
        return bytes(self.output_buffer)


def convert_to_gpx(points_data: List[Dict], filename: str = "track") -> str:
    """Convert decoded points to GPX format"""
    if not points_data:
        return ""
    
    # Extract just the point data
    points = [item['data'] for item in points_data]
    
    gpx = f'''<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"
    version="1.1" creator="MGT GPS Format Tool">
  <metadata>
    <name>{filename}</name>
    <time>{datetime.fromtimestamp(points[0]['timestamp']).isoformat()}</time>
  </metadata>
  <trk>
    <name>{filename}</name>
    <trkseg>
'''
    
    for point in points:
        lat = point['latitude']
        lon = point['longitude']
        ele = point['altitude']
        time = datetime.fromtimestamp(point['timestamp']).isoformat()
        
        # Basic coordinate validation
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            print(f"Skipping invalid point: Lat {lat}, Lon {lon}")
            continue
        
        gpx += f'      <trkpt lat="{lat:.5f}" lon="{lon:.5f}">\n'
        gpx += f'        <ele>{ele:.1f}</ele>\n'
        gpx += f'        <time>{time}</time>\n'
        gpx += f'      </trkpt>\n'
    
    gpx += '''    </trkseg>
  </trk>
</gpx>'''
    
    return gpx


def main():
    parser = argparse.ArgumentParser(
        description='GPS Tracker Custom Binary Format Tool',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Decode binary file to JSON
  python gps_format_tool.py decode input.bin output.json
  
  # Decode binary file to GPX
  python gps_format_tool.py to-gpx input.bin output.gpx
  
  # Encode JSON to binary
  python gps_format_tool.py encode input.json output.bin
  
  # Validate binary file
  python gps_format_tool.py validate input.bin
        '''
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Decode command
    decode_parser = subparsers.add_parser('decode', help='Decode binary file to JSON')
    decode_parser.add_argument('input', help='Input binary file')
    decode_parser.add_argument('output', help='Output JSON file')
    decode_parser.add_argument('--full-interval', type=int, default=64, 
                              help='Full block interval (default: 64)')
    
    # Encode command
    encode_parser = subparsers.add_parser('encode', help='Encode JSON to binary file')
    encode_parser.add_argument('input', help='Input JSON file')
    encode_parser.add_argument('output', help='Output binary file')
    encode_parser.add_argument('--full-interval', type=int, default=64,
                              help='Full block interval (default: 64)')
    
    # GPX conversion command
    gpx_parser = subparsers.add_parser('to-gpx', help='Convert binary file to GPX format')
    gpx_parser.add_argument('input', help='Input binary file')
    gpx_parser.add_argument('output', help='Output GPX file')
    gpx_parser.add_argument('--full-interval', type=int, default=64,
                           help='Full block interval (default: 64)')
    
    # Validate command
    validate_parser = subparsers.add_parser('validate', help='Validate binary file format')
    validate_parser.add_argument('input', help='Input binary file')
    validate_parser.add_argument('--full-interval', type=int, default=64,
                                help='Full block interval (default: 64)')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    try:
        if args.command == 'decode':
            # Read binary file
            with open(args.input, 'rb') as f:
                binary_data = f.read()
            
            # Decode
            decoder = GpsFormatDecoder()
            points = decoder.decode_file(binary_data)
            
            # Write JSON
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump({
                    'file_info': {
                        'input_file': args.input,
                        'total_points': len(points),
                        'format_version': '1.0'
                    },
                    'points': points
                }, f, indent=2, ensure_ascii=False)
            
            print(f"Decoded {len(points)} points to {args.output}")
        
        elif args.command == 'encode':
            # Read JSON file
            with open(args.input, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # Extract points
            points_data = data['points'] if 'points' in data else data
            if isinstance(points_data[0], dict) and 'data' in points_data[0]:
                # Already in decoded format
                points = [GpsPoint.from_dict(item['data']) for item in points_data]
            else:
                # Raw point data
                points = [GpsPoint.from_dict(item) for item in points_data]
            
            # Encode
            encoder = GpsFormatEncoder(args.full_interval)
            binary_data = encoder.encode_points(points)
            
            # Write binary file
            with open(args.output, 'wb') as f:
                f.write(binary_data)
            
            print(f"Encoded {len(points)} points to {args.output} ({len(binary_data)} bytes)")
        
        elif args.command == 'to-gpx':
            # Read binary file
            with open(args.input, 'rb') as f:
                binary_data = f.read()
            
            # Decode
            decoder = GpsFormatDecoder()
            points = decoder.decode_file(binary_data)
            
            # Convert to GPX
            gpx_content = convert_to_gpx(points, Path(args.input).stem)
            
            # Write GPX file
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(gpx_content)
            
            print(f"Converted {len(points)} points to GPX: {args.output}")
        
        elif args.command == 'validate':
            # Read binary file
            with open(args.input, 'rb') as f:
                binary_data = f.read()
            
            # Try to decode
            decoder = GpsFormatDecoder()
            points = decoder.decode_file(binary_data)
            
            print(f"File validation successful!")
            print(f"  Total points: {len(points)}")
            print(f"  File size: {len(binary_data)} bytes")
            
            # Analyze block types
            full_blocks = sum(1 for p in points if p['type'] == 'full')
            delta_blocks = sum(1 for p in points if p['type'] == 'delta')
            
            print(f"  Full blocks: {full_blocks}")
            print(f"  Delta blocks: {delta_blocks}")
            
            if points:
                first_point = points[0]['data']
                last_point = points[-1]['data']
                duration = last_point['timestamp'] - first_point['data']['timestamp']
                print(f"  Duration: {duration} seconds ({duration/3600:.1f} hours)")
            
            print(f"  Compression ratio: {len(binary_data) / (len(points) * 16):.2f}x")
    
    except Exception as e:
        print(f"Error: {e}")
        return 1
    
    return 0


if __name__ == '__main__':
    exit(main())