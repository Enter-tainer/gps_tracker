"""
CASIC protocol parser for binary AGNSS data files.

Parses CASIC packet structure: Header(0xBA 0xCE) + Length + Class + ID + Payload + Checksum.
Supports GPS/BDS ephemeris, UTC, ionospheric data, AID-INI, and ACK/NACK messages.
"""

import argparse
import csv
import datetime
import struct
import sys
from typing import Any, Optional


class CasicPacket:
    """CASIC data packet."""

    def __init__(self):
        self.header: int = 0
        self.length: int = 0
        self.class_id: int = 0
        self.message_id: int = 0
        self.payload: bytes = b""
        self.checksum: int = 0
        self.parsed_data: Optional[dict[str, Any]] = None

    def __str__(self):
        msg_type = CasicParser.get_message_name(
            self.class_id, self.message_id
        )
        return (
            f"CASIC Packet: {msg_type} (Class=0x{self.class_id:02X}, "
            f"ID=0x{self.message_id:02X}), "
            f"Length={self.length}, "
            f"Checksum=0x{self.checksum:08X}"
        )


class CasicParser:
    """CASIC protocol parser."""

    HEADER_MAGIC = b"\xba\xce"
    MIN_PACKET_SIZE = 10

    MESSAGE_TYPES = {
        (0x0B, 0x01): "AID-INI",
        (0x08, 0x00): "MSG_BDSUTC",
        (0x08, 0x01): "MSG_BDSION",
        (0x08, 0x02): "MSG_BDSEPH",
        (0x08, 0x05): "MSG_GPSUTC",
        (0x08, 0x06): "MSG_GPSION",
        (0x08, 0x07): "MSG_GPSEPH",
        (0x05, 0x01): "ACK",
        (0x05, 0x00): "NACK",
    }

    def __init__(self):
        self.packets: list[CasicPacket] = []
        self.stats = {
            "total_bytes": 0,
            "valid_packets": 0,
            "invalid_packets": 0,
            "checksum_errors": 0,
        }

    @staticmethod
    def get_message_name(class_id: int, message_id: int) -> str:
        return CasicParser.MESSAGE_TYPES.get(
            (class_id, message_id), "UNKNOWN"
        )

    def calculate_checksum(
        self,
        class_id: int,
        message_id: int,
        length: int,
        payload: bytes,
    ) -> int:
        checksum = (message_id << 24) + (class_id << 16) + length
        payload_len = len(payload)
        for i in range(0, payload_len // 4):
            offset = i * 4
            if offset + 4 <= payload_len:
                payload_word = struct.unpack(
                    "<I", payload[offset : offset + 4]
                )[0]
                checksum += payload_word
        return checksum & 0xFFFFFFFF

    def parse_message_payload(
        self, packet: CasicPacket
    ) -> dict[str, Any]:
        msg_type = (packet.class_id, packet.message_id)

        if msg_type == (0x0B, 0x01):
            return self._parse_aid_ini(packet.payload)
        elif msg_type == (0x05, 0x01):
            return self._parse_ack_nack(packet.payload, is_ack=True)
        elif msg_type == (0x05, 0x00):
            return self._parse_ack_nack(packet.payload, is_ack=False)
        elif msg_type == (0x08, 0x07):
            return self._parse_gps_ephemeris(packet.payload)
        elif msg_type == (0x08, 0x02):
            return self._parse_bds_ephemeris(packet.payload)
        elif msg_type == (0x08, 0x00):
            return self._parse_simple(packet.payload, "BDS_UTC", 20)
        elif msg_type == (0x08, 0x01):
            return self._parse_simple(
                packet.payload, "BDS_IONOSPHERIC", 16
            )
        elif msg_type == (0x08, 0x05):
            return self._parse_simple(packet.payload, "GPS_UTC", 20)
        elif msg_type == (0x08, 0x06):
            return self._parse_simple(
                packet.payload, "GPS_IONOSPHERIC", 16
            )
        else:
            return {"raw_data": packet.payload.hex()}

    def _parse_aid_ini(self, payload: bytes) -> dict[str, Any]:
        if len(payload) < 56:
            return {"error": "AID-INI payload too short"}
        try:
            lat = struct.unpack("<d", payload[0:8])[0]
            lon = struct.unpack("<d", payload[8:16])[0]
            alt = struct.unpack("<d", payload[16:24])[0]
            tow = struct.unpack("<d", payload[24:32])[0]
            freq_bias = struct.unpack("<f", payload[32:36])[0]
            p_acc = struct.unpack("<f", payload[36:40])[0]
            t_acc = struct.unpack("<f", payload[40:44])[0]
            f_acc = struct.unpack("<f", payload[44:48])[0]
            res = struct.unpack("<I", payload[48:52])[0]
            wn = struct.unpack("<H", payload[52:54])[0]
            timer_source = payload[54]
            flags = payload[55]
            return {
                "latitude": lat,
                "longitude": lon,
                "altitude": alt,
                "time_of_week": tow,
                "frequency_bias": freq_bias,
                "position_accuracy": p_acc,
                "time_accuracy": t_acc,
                "frequency_accuracy": f_acc,
                "reserved": res,
                "week_number": wn,
                "timer_source": timer_source,
                "flags": flags,
                "flags_detail": {
                    "position_valid": bool(flags & 0x01),
                    "time_valid": bool(flags & 0x02),
                    "clock_freq_drift_valid": bool(flags & 0x04),
                    "clock_freq_valid": bool(flags & 0x10),
                    "position_is_lla": bool(flags & 0x20),
                    "altitude_invalid": bool(flags & 0x40),
                },
            }
        except struct.error as e:
            return {"error": f"Failed to parse AID-INI: {e}"}

    def _parse_ack_nack(
        self, payload: bytes, is_ack: bool
    ) -> dict[str, Any]:
        if len(payload) < 4:
            return {"error": "ACK/NACK payload too short"}
        cls_id = payload[0]
        msg_id = payload[1]
        res = struct.unpack("<H", payload[2:4])[0]
        return {
            "type": "ACK" if is_ack else "NACK",
            "acknowledged_class": f"0x{cls_id:02X}",
            "acknowledged_message": f"0x{msg_id:02X}",
            "acknowledged_type": self.get_message_name(cls_id, msg_id),
            "reserved": res,
        }

    def _parse_gps_ephemeris(self, payload: bytes) -> dict[str, Any]:
        if len(payload) < 72:
            return {"error": "GPS Ephemeris payload too short"}
        try:
            svid = struct.unpack("<I", payload[0:4])[0]
            toe = struct.unpack("<I", payload[4:8])[0]
            toc = struct.unpack("<I", payload[8:12])[0]
            return {
                "type": "GPS_EPHEMERIS",
                "satellite_id": svid & 0xFF,
                "time_of_ephemeris": toe,
                "time_of_clock": toc,
                "length": len(payload),
                "raw_data": (
                    payload[:32].hex() + "..."
                    if len(payload) > 32
                    else payload.hex()
                ),
            }
        except struct.error:
            return {
                "type": "GPS_EPHEMERIS",
                "error": "Failed to parse GPS ephemeris structure",
                "length": len(payload),
            }

    def _parse_bds_ephemeris(self, payload: bytes) -> dict[str, Any]:
        if len(payload) < 92:
            return {"error": "BDS Ephemeris payload too short"}
        try:
            svid = struct.unpack("<I", payload[0:4])[0]
            toe = struct.unpack("<I", payload[4:8])[0]
            toc = struct.unpack("<I", payload[8:12])[0]
            return {
                "type": "BDS_EPHEMERIS",
                "satellite_id": svid & 0xFF,
                "time_of_ephemeris": toe,
                "time_of_clock": toc,
                "length": len(payload),
                "raw_data": (
                    payload[:32].hex() + "..."
                    if len(payload) > 32
                    else payload.hex()
                ),
            }
        except struct.error:
            return {
                "type": "BDS_EPHEMERIS",
                "error": "Failed to parse BDS ephemeris structure",
                "length": len(payload),
            }

    def _parse_simple(
        self, payload: bytes, type_name: str, min_len: int
    ) -> dict[str, Any]:
        if len(payload) < min_len:
            return {"error": f"{type_name} payload too short"}
        return {
            "type": type_name,
            "length": len(payload),
            "raw_data": payload.hex(),
        }

    def parse_file(self, filepath: str) -> bool:
        try:
            with open(filepath, "rb") as f:
                data = f.read()
                self.stats["total_bytes"] = len(data)
                return self.parse_data(data)
        except FileNotFoundError:
            print(f"Error: file '{filepath}' not found")
            return False
        except Exception as e:
            print(f"Error reading file: {e}")
            return False

    def parse_data(self, data: bytes) -> bool:
        offset = 0
        while offset < len(data):
            header_pos = data.find(self.HEADER_MAGIC, offset)
            if header_pos == -1:
                break
            if header_pos + self.MIN_PACKET_SIZE > len(data):
                break
            try:
                packet = self._parse_packet_at(data, header_pos)
                if packet:
                    self.packets.append(packet)
                    self.stats["valid_packets"] += 1
                    offset = header_pos + 6 + packet.length + 4
                else:
                    self.stats["invalid_packets"] += 1
                    offset = header_pos + 1
            except Exception as e:
                print(f"Warning: parse error at offset {header_pos}: {e}")
                self.stats["invalid_packets"] += 1
                offset = header_pos + 1
        return True

    def _parse_packet_at(
        self, data: bytes, offset: int
    ) -> Optional[CasicPacket]:
        packet = CasicPacket()
        packet.header = struct.unpack(
            "<H", data[offset : offset + 2]
        )[0]
        packet.length = struct.unpack(
            "<H", data[offset + 2 : offset + 4]
        )[0]
        packet.class_id = data[offset + 4]
        packet.message_id = data[offset + 5]

        total_packet_size = 6 + packet.length + 4
        if offset + total_packet_size > len(data):
            return None

        payload_start = offset + 6
        payload_end = payload_start + packet.length
        packet.payload = data[payload_start:payload_end]

        checksum_start = payload_end
        packet.checksum = struct.unpack(
            "<I", data[checksum_start : checksum_start + 4]
        )[0]

        calculated_checksum = self.calculate_checksum(
            packet.class_id,
            packet.message_id,
            packet.length,
            packet.payload,
        )
        if calculated_checksum != packet.checksum:
            self.stats["checksum_errors"] += 1
            print(
                f"Warning: checksum error at offset {offset}: "
                f"calc=0x{calculated_checksum:08X}, "
                f"got=0x{packet.checksum:08X}"
            )

        packet.parsed_data = self.parse_message_payload(packet)
        return packet

    def print_summary(self):
        print("\n=== Parse Summary ===")
        print(f"Total bytes: {self.stats['total_bytes']}")
        print(f"Valid packets: {self.stats['valid_packets']}")
        print(f"Invalid packets: {self.stats['invalid_packets']}")
        print(f"Checksum errors: {self.stats['checksum_errors']}")

        if self.packets:
            print("\n=== Packet Type Statistics ===")
            class_stats: dict[tuple[int, int], int] = {}
            for packet in self.packets:
                key = (packet.class_id, packet.message_id)
                class_stats[key] = class_stats.get(key, 0) + 1
            for (class_id, msg_id), count in sorted(class_stats.items()):
                print(
                    f"Class 0x{class_id:02X}, ID 0x{msg_id:02X}: {count}"
                )

    def print_packets(
        self, limit: Optional[int] = None, verbose: bool = False
    ):
        if not self.packets:
            print("No valid packets found")
            return

        print("\n=== Packet List ===")
        packets_to_show = (
            self.packets[:limit] if limit else self.packets
        )

        for i, packet in enumerate(packets_to_show):
            print(f"[{i + 1:4d}] {packet}")
            if verbose:
                if packet.parsed_data:
                    _print_parsed_data(packet.parsed_data, indent="       ")
                if packet.payload:
                    payload_preview = packet.payload[:32]
                    hex_str = " ".join(
                        f"{b:02X}" for b in payload_preview
                    )
                    if len(packet.payload) > 32:
                        hex_str += "..."
                    print(
                        f"       Raw Payload ({len(packet.payload)} bytes): {hex_str}"
                    )

        if limit and len(self.packets) > limit:
            print(f"... {len(self.packets) - limit} more packets")

    def export_to_csv(self, output_file: str):
        with open(output_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
                    "Index",
                    "Type",
                    "Class",
                    "ID",
                    "Length",
                    "Checksum",
                    "ParseStatus",
                    "Payload(Hex)",
                ]
            )
            for i, packet in enumerate(self.packets):
                msg_type = self.get_message_name(
                    packet.class_id, packet.message_id
                )
                payload_hex = (
                    packet.payload.hex().upper()
                    if packet.payload
                    else ""
                )
                parse_status = (
                    "OK"
                    if packet.parsed_data
                    and "error" not in packet.parsed_data
                    else "FAIL"
                )
                writer.writerow(
                    [
                        i + 1,
                        msg_type,
                        f"0x{packet.class_id:02X}",
                        f"0x{packet.message_id:02X}",
                        packet.length,
                        f"0x{packet.checksum:08X}",
                        parse_status,
                        payload_hex,
                    ]
                )
        print(f"Exported to: {output_file}")

    def analyze_agnss_session(self):
        print("\n=== AGNSS Session Analysis ===")

        by_type = {}
        for p in self.packets:
            key = (p.class_id, p.message_id)
            by_type.setdefault(key, []).append(p)

        aid_ini = by_type.get((0x0B, 0x01), [])
        acks = by_type.get((0x05, 0x01), [])
        nacks = by_type.get((0x05, 0x00), [])
        gps_eph = by_type.get((0x08, 0x07), [])
        bds_eph = by_type.get((0x08, 0x02), [])

        print(f"AID-INI: {len(aid_ini)}")
        print(f"ACK: {len(acks)}")
        print(f"NACK: {len(nacks)}")
        print(f"GPS Ephemeris: {len(gps_eph)}")
        print(f"BDS Ephemeris: {len(bds_eph)}")

        gps_sats = set()
        bds_sats = set()
        for p in gps_eph:
            if p.parsed_data and "satellite_id" in p.parsed_data:
                gps_sats.add(p.parsed_data["satellite_id"])
        for p in bds_eph:
            if p.parsed_data and "satellite_id" in p.parsed_data:
                bds_sats.add(p.parsed_data["satellite_id"])

        if gps_sats:
            print(
                f"\nGPS satellites: {len(gps_sats)} - {sorted(gps_sats)}"
            )
        if bds_sats:
            print(
                f"BDS satellites: {len(bds_sats)} - {sorted(bds_sats)}"
            )

    def create_casic_packet_bytes(
        self, class_id: int, message_id: int, payload: bytes
    ) -> bytes:
        length = len(payload)
        checksum = self.calculate_checksum(
            class_id, message_id, length, payload
        )
        packet_bytes = bytearray()
        packet_bytes.extend(self.HEADER_MAGIC)
        packet_bytes.extend(struct.pack("<H", length))
        packet_bytes.append(class_id)
        packet_bytes.append(message_id)
        packet_bytes.extend(payload)
        packet_bytes.extend(struct.pack("<I", checksum))
        return bytes(packet_bytes)

    def create_dummy_aid_ini(self) -> bytes:
        """Create a Shanghai-location AID-INI packet payload."""
        latitude = 31.2304
        longitude = 121.4737
        altitude = 10.0

        now = datetime.datetime.now(datetime.timezone.utc)
        gps_epoch = datetime.datetime(
            2006, 1, 1, tzinfo=datetime.timezone.utc
        )
        total_seconds = (now - gps_epoch).total_seconds()
        gps_week = int(total_seconds // (7 * 24 * 3600))
        time_of_week = total_seconds % (7 * 24 * 3600)

        flags = 0b01100010

        payload = struct.pack(
            "<ddddffffIHBB",
            latitude,
            longitude,
            altitude,
            time_of_week,
            0.0,  # frequency_bias
            10.0,  # position_accuracy
            1.0,  # time_accuracy
            1.0,  # frequency_accuracy
            0,  # reserved
            gps_week,
            1,  # timer_source
            flags,
        )
        return payload

    def export_to_cpp_vector(
        self,
        output_file: str,
        include_dummy_aid_ini: bool = True,
    ):
        with open(output_file, "w", encoding="utf-8") as f:
            f.write("// CASIC protocol packets - auto-generated\n")
            f.write("#include <vector>\n#include <cstdint>\n\n")
            f.write(
                "const std::vector<std::vector<uint8_t>> agnss_packets = {\n"
            )

            if include_dummy_aid_ini:
                dummy_payload = self.create_dummy_aid_ini()
                dummy_bytes = self.create_casic_packet_bytes(
                    0x0B, 0x01, dummy_payload
                )
                f.write("    // Shanghai AID-INI\n    {\n")
                _write_cpp_hex_lines(f, dummy_bytes)
                f.write("    },\n\n")

            for i, packet in enumerate(self.packets):
                msg_type = self.get_message_name(
                    packet.class_id, packet.message_id
                )
                packet_bytes = self.create_casic_packet_bytes(
                    packet.class_id, packet.message_id, packet.payload
                )
                f.write(
                    f"    // Packet {i + 1}: {msg_type} "
                    f"(Class=0x{packet.class_id:02X}, ID=0x{packet.message_id:02X})\n"
                )
                f.write("    {\n")
                _write_cpp_hex_lines(f, packet_bytes)
                if i < len(self.packets) - 1:
                    f.write("    },\n\n")
                else:
                    f.write("    }\n")

            f.write("};\n")
        print(f"C++ exported to: {output_file}")

    def filter_packets_by_type(
        self, class_id: int, message_id: int
    ) -> list[CasicPacket]:
        return [
            p
            for p in self.packets
            if p.class_id == class_id and p.message_id == message_id
        ]


def _print_parsed_data(
    data: dict[str, Any], indent: str = ""
) -> None:
    if "error" in data:
        print(f"{indent}Parse error: {data['error']}")
        return
    for key, value in data.items():
        if key == "raw_data":
            continue
        elif isinstance(value, dict):
            print(f"{indent}{key}:")
            _print_parsed_data(value, indent + "  ")
        elif isinstance(value, float):
            if "latitude" in key.lower() or "longitude" in key.lower():
                print(f"{indent}{key}: {value:.8f}")
            elif "accuracy" in key.lower():
                print(f"{indent}{key}: {value:.4f}")
            else:
                print(f"{indent}{key}: {value:.6f}")
        elif key == "flags":
            print(f"{indent}{key}: 0x{value:02X}")
        else:
            print(f"{indent}{key}: {value}")


def _write_cpp_hex_lines(f, data: bytes) -> None:
    for j in range(0, len(data), 16):
        chunk = data[j : j + 16]
        hex_values = ", ".join(f"0x{b:02X}" for b in chunk)
        if j + 16 < len(data):
            f.write(f"        {hex_values},\n")
        else:
            f.write(f"        {hex_values}\n")


# ---------------------------------------------------------------------------
# CLI setup
# ---------------------------------------------------------------------------


def add_subcommands(subparsers) -> None:
    """Register casic subcommands (just 'parse')."""
    p = subparsers.add_parser(
        "parse", help="Parse a CASIC binary data file"
    )
    p.add_argument("filepath", help="Binary data file to parse")
    p.add_argument(
        "-v", "--verbose", action="store_true", help="Verbose output"
    )
    p.add_argument(
        "-l",
        "--limit",
        type=int,
        metavar="N",
        help="Limit displayed packets",
    )
    p.add_argument(
        "-o", "--output", metavar="FILE", help="Export to CSV"
    )
    p.add_argument(
        "--cpp", metavar="FILE", help="Export to C++ vector format"
    )
    p.add_argument(
        "--no-dummy-aid-ini",
        action="store_true",
        help="Skip dummy AID-INI in C++ export",
    )
    p.add_argument(
        "--no-summary",
        action="store_true",
        help="Skip parse summary",
    )
    p.add_argument(
        "--agnss",
        action="store_true",
        help="Show AGNSS session analysis",
    )
    p.add_argument(
        "--filter",
        metavar="CLASS:ID",
        help="Filter by message type (e.g. 0x0B:0x01)",
    )
    p.set_defaults(func=cmd_parse)


def cmd_parse(args):
    """Parse a CASIC binary file."""
    parser = CasicParser()
    print(f"Parsing: {args.filepath}")
    if not parser.parse_file(args.filepath):
        sys.exit(1)

    if args.filter:
        try:
            parts = args.filter.split(":")
            if len(parts) != 2:
                raise ValueError("format error")
            class_id = int(
                parts[0], 16 if parts[0].startswith("0x") else 10
            )
            msg_id = int(
                parts[1], 16 if parts[1].startswith("0x") else 10
            )
            filtered = parser.filter_packets_by_type(class_id, msg_id)
            print(
                f"\nFilter: {len(filtered)} "
                f"{parser.get_message_name(class_id, msg_id)} packets"
            )
            original_packets = parser.packets
            parser.packets = filtered
            parser.print_packets(
                limit=args.limit, verbose=args.verbose
            )
            parser.packets = original_packets
        except ValueError:
            print(
                "Error: invalid filter format, use CLASS:ID (e.g. 0x0B:0x01)"
            )
            sys.exit(1)
    else:
        if not args.no_summary:
            parser.print_summary()
        if args.agnss:
            parser.analyze_agnss_session()
        parser.print_packets(limit=args.limit, verbose=args.verbose)

    if args.output:
        parser.export_to_csv(args.output)
    if args.cpp:
        parser.export_to_cpp_vector(
            args.cpp,
            include_dummy_aid_ini=not args.no_dummy_aid_ini,
        )


def main():
    parser = argparse.ArgumentParser(
        description="CASIC protocol binary data parser"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    add_subcommands(sub)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
