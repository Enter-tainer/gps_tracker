#!/usr/bin/env python3
"""
CASIC 协议解析器
基于 CASIC 语句结构解析二进制数据文件
"""

import argparse
import struct
import sys
from typing import List, Optional, Dict, Any


class CasicPacket:
    """CASIC 数据包类"""

    def __init__(self):
        self.header: int = 0  # 起始字符 (2字节: 0xBA 0xCE)
        self.length: int = 0  # 长度字段 (2字节)
        self.class_id: int = 0  # Class (1字节)
        self.message_id: int = 0  # ID (1字节)
        self.payload: bytes = b""  # Payload (长度可变)
        self.checksum: int = 0  # Checksum (4字节)
        self.parsed_data: Optional[Dict[str, Any]] = None  # 解析后的数据

    def __str__(self):
        msg_type = CasicParser.get_message_name(self.class_id, self.message_id)
        return (
            f"CASIC Packet: {msg_type} (Class=0x{self.class_id:02X}, "
            f"ID=0x{self.message_id:02X}), "
            f"Length={self.length}, "
            f"Checksum=0x{self.checksum:08X}"
        )


class CasicParser:
    """CASIC 协议解析器"""

    HEADER_MAGIC = b"\xba\xce"  # 固定起始字符
    MIN_PACKET_SIZE = 10  # 最小包大小 (Header + Len + Class + ID + Checksum)

    # AGNSS 消息类型定义
    MESSAGE_TYPES = {
        (0x0B, 0x01): "AID-INI",  # 辅助初始化数据
        (0x08, 0x00): "MSG_BDSUTC",  # BDS UTC 数据
        (0x08, 0x01): "MSG_BDSION",  # BDS 电离层数据
        (0x08, 0x02): "MSG_BDSEPH",  # BDS 星历
        (0x08, 0x05): "MSG_GPSUTC",  # GPS UTC 数据
        (0x08, 0x06): "MSG_GPSION",  # GPS 电离层参数
        (0x08, 0x07): "MSG_GPSEPH",  # GPS 星历
        (0x05, 0x01): "ACK",  # 确认消息
        (0x05, 0x00): "NACK",  # 否定消息
    }

    def __init__(self):
        self.packets: List[CasicPacket] = []
        self.stats = {
            "total_bytes": 0,
            "valid_packets": 0,
            "invalid_packets": 0,
            "checksum_errors": 0,
        }

    @staticmethod
    def get_message_name(class_id: int, message_id: int) -> str:
        """获取消息类型名称"""
        return CasicParser.MESSAGE_TYPES.get((class_id, message_id), "UNKNOWN")

    def calculate_checksum(
        self, class_id: int, message_id: int, length: int, payload: bytes
    ) -> int:
        """
        计算校验和 (官方算法)
        Checksum = (ID << 24) + (Class << 16) + Len;
        for (i = 0; i < (Len / 4); i++)
        {
            Checksum = Checksum + Payload [i];
        }
        """
        # 初始校验和：(ID << 24) + (Class << 16) + Len
        checksum = (message_id << 24) + (class_id << 16) + length

        # 按 4 字节为单位处理 Payload
        payload_len = len(payload)
        for i in range(0, payload_len // 4):
            # 从 payload 中提取 4 字节作为一个 32 位整数（小端序）
            offset = i * 4
            if offset + 4 <= payload_len:
                payload_word = struct.unpack("<I", payload[offset : offset + 4])[0]
                checksum += payload_word

        return checksum & 0xFFFFFFFF

    def parse_message_payload(self, packet: CasicPacket) -> Dict[str, Any]:
        """解析消息载荷"""
        msg_type = (packet.class_id, packet.message_id)

        if msg_type == (0x0B, 0x01):  # AID-INI
            return self.parse_aid_ini(packet.payload)
        elif msg_type == (0x05, 0x01):  # ACK
            return self.parse_ack_nack(packet.payload, is_ack=True)
        elif msg_type == (0x05, 0x00):  # NACK
            return self.parse_ack_nack(packet.payload, is_ack=False)
        elif msg_type == (0x08, 0x07):  # GPS Ephemeris
            return self.parse_gps_ephemeris(packet.payload)
        elif msg_type == (0x08, 0x02):  # BDS Ephemeris
            return self.parse_bds_ephemeris(packet.payload)
        elif msg_type == (0x08, 0x00):  # BDS UTC
            return self.parse_bds_utc(packet.payload)
        elif msg_type == (0x08, 0x01):  # BDS Ionospheric
            return self.parse_bds_ion(packet.payload)
        elif msg_type == (0x08, 0x05):  # GPS UTC
            return self.parse_gps_utc(packet.payload)
        elif msg_type == (0x08, 0x06):  # GPS Ionospheric
            return self.parse_gps_ion(packet.payload)
        else:
            return {"raw_data": packet.payload.hex()}

    def parse_aid_ini(self, payload: bytes) -> Dict[str, Any]:
        """解析 AID-INI 消息"""
        if len(payload) < 56:
            return {"error": "AID-INI payload too short"}

        try:
            # 按照文档格式解析
            lat = struct.unpack("<d", payload[0:8])[0]  # R8 - Latitude
            lon = struct.unpack("<d", payload[8:16])[0]  # R8 - Longitude
            alt = struct.unpack("<d", payload[16:24])[0]  # R8 - Altitude
            tow = struct.unpack("<d", payload[24:32])[0]  # R8 - GPS Time of Week
            freq_bias = struct.unpack("<f", payload[32:36])[
                0
            ]  # R4 - Clock frequency offset
            p_acc = struct.unpack("<f", payload[36:40])[0]  # R4 - Position accuracy
            t_acc = struct.unpack("<f", payload[40:44])[0]  # R4 - Time accuracy
            f_acc = struct.unpack("<f", payload[44:48])[0]  # R4 - Frequency accuracy
            res = struct.unpack("<I", payload[48:52])[0]  # U4 - Reserved
            wn = struct.unpack("<H", payload[52:54])[0]  # U2 - GPS Week Number
            timer_source = payload[54]  # U1 - Time source
            flags = payload[55]  # U1 - Flag mask

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
                "flags_detail": self.parse_aid_ini_flags(flags),
            }
        except struct.error as e:
            return {"error": f"Failed to parse AID-INI: {e}"}

    def parse_aid_ini_flags(self, flags: int) -> Dict[str, bool]:
        """解析 AID-INI 标志位"""
        return {
            "position_valid": bool(flags & 0x01),
            "time_valid": bool(flags & 0x02),
            "clock_freq_drift_valid": bool(flags & 0x04),
            "clock_freq_valid": bool(flags & 0x10),
            "position_is_lla": bool(flags & 0x20),
            "altitude_invalid": bool(flags & 0x40),
        }

    def parse_ack_nack(self, payload: bytes, is_ack: bool) -> Dict[str, Any]:
        """解析 ACK/NACK 消息"""
        if len(payload) < 4:
            return {"error": "ACK/NACK payload too short"}

        cls_id = payload[0]
        msg_id = payload[1]
        res = struct.unpack("<H", payload[2:4])[0]

        ack_msg_type = self.get_message_name(cls_id, msg_id)

        return {
            "type": "ACK" if is_ack else "NACK",
            "acknowledged_class": f"0x{cls_id:02X}",
            "acknowledged_message": f"0x{msg_id:02X}",
            "acknowledged_type": ack_msg_type,
            "reserved": res,
        }

    def parse_gps_ephemeris(self, payload: bytes) -> Dict[str, Any]:
        """解析 GPS 星历数据"""
        if len(payload) < 72:
            return {"error": "GPS Ephemeris payload too short"}

        try:
            # GPS星历基本字段解析 (这里只解析一些基本字段作为示例)
            svid = struct.unpack("<I", payload[0:4])[0]  # 卫星ID
            toe = struct.unpack("<I", payload[4:8])[0]  # 星历参考时间
            toc = struct.unpack("<I", payload[8:12])[0]  # 时钟参考时间

            return {
                "type": "GPS_EPHEMERIS",
                "satellite_id": svid & 0xFF,  # 低8位为卫星号
                "time_of_ephemeris": toe,
                "time_of_clock": toc,
                "length": len(payload),
                "raw_data": payload[:32].hex() + "..."
                if len(payload) > 32
                else payload.hex(),
            }
        except struct.error:
            return {
                "type": "GPS_EPHEMERIS",
                "error": "Failed to parse GPS ephemeris structure",
                "length": len(payload),
                "raw_data": payload[:32].hex() + "..."
                if len(payload) > 32
                else payload.hex(),
            }

    def parse_bds_ephemeris(self, payload: bytes) -> Dict[str, Any]:
        """解析 BDS 星历数据"""
        if len(payload) < 92:
            return {"error": "BDS Ephemeris payload too short"}

        try:
            # BDS星历基本字段解析
            svid = struct.unpack("<I", payload[0:4])[0]  # 卫星ID
            toe = struct.unpack("<I", payload[4:8])[0]  # 星历参考时间
            toc = struct.unpack("<I", payload[8:12])[0]  # 时钟参考时间

            return {
                "type": "BDS_EPHEMERIS",
                "satellite_id": svid & 0xFF,  # 低8位为卫星号
                "time_of_ephemeris": toe,
                "time_of_clock": toc,
                "length": len(payload),
                "raw_data": payload[:32].hex() + "..."
                if len(payload) > 32
                else payload.hex(),
            }
        except struct.error:
            return {
                "type": "BDS_EPHEMERIS",
                "error": "Failed to parse BDS ephemeris structure",
                "length": len(payload),
                "raw_data": payload[:32].hex() + "..."
                if len(payload) > 32
                else payload.hex(),
            }

    def parse_bds_utc(self, payload: bytes) -> Dict[str, Any]:
        """解析 BDS UTC 数据"""
        if len(payload) < 20:
            return {"error": "BDS UTC payload too short"}

        return {"type": "BDS_UTC", "length": len(payload), "raw_data": payload.hex()}

    def parse_bds_ion(self, payload: bytes) -> Dict[str, Any]:
        """解析 BDS 电离层数据"""
        if len(payload) < 16:
            return {"error": "BDS Ionospheric payload too short"}

        return {
            "type": "BDS_IONOSPHERIC",
            "length": len(payload),
            "raw_data": payload.hex(),
        }

    def parse_gps_utc(self, payload: bytes) -> Dict[str, Any]:
        """解析 GPS UTC 数据"""
        if len(payload) < 20:
            return {"error": "GPS UTC payload too short"}

        return {"type": "GPS_UTC", "length": len(payload), "raw_data": payload.hex()}

    def parse_gps_ion(self, payload: bytes) -> Dict[str, Any]:
        """解析 GPS 电离层参数"""
        if len(payload) < 16:
            return {"error": "GPS Ionospheric payload too short"}

        return {
            "type": "GPS_IONOSPHERIC",
            "length": len(payload),
            "raw_data": payload.hex(),
        }

    def parse_file(self, filepath: str) -> bool:
        """解析文件"""
        try:
            with open(filepath, "rb") as f:
                data = f.read()
                self.stats["total_bytes"] = len(data)
                return self.parse_data(data)
        except FileNotFoundError:
            print(f"错误: 文件 '{filepath}' 不存在")
            return False
        except Exception as e:
            print(f"错误: 读取文件时出错 - {e}")
            return False

    def parse_data(self, data: bytes) -> bool:
        """解析二进制数据"""
        offset = 0

        while offset < len(data):
            # 查找起始字符
            header_pos = data.find(self.HEADER_MAGIC, offset)
            if header_pos == -1:
                break

            # 检查是否有足够的数据读取包头
            if header_pos + self.MIN_PACKET_SIZE > len(data):
                break

            try:
                packet = self.parse_packet_at(data, header_pos)
                if packet:
                    self.packets.append(packet)
                    self.stats["valid_packets"] += 1
                    # 移动到下一个包的位置
                    offset = (
                        header_pos + 6 + packet.length + 4
                    )  # Header(2) + Len(2) + Class(1) + ID(1) + Payload + Checksum(4)
                else:
                    self.stats["invalid_packets"] += 1
                    offset = header_pos + 1  # 继续搜索

            except Exception as e:
                print(f"警告: 解析包时出错 (偏移 {header_pos}): {e}")
                self.stats["invalid_packets"] += 1
                offset = header_pos + 1

        return True

    def parse_packet_at(self, data: bytes, offset: int) -> Optional[CasicPacket]:
        """在指定偏移处解析一个数据包"""
        packet = CasicPacket()

        # 解析包头
        packet.header = struct.unpack("<H", data[offset : offset + 2])[0]
        packet.length = struct.unpack("<H", data[offset + 2 : offset + 4])[0]
        packet.class_id = data[offset + 4]
        packet.message_id = data[offset + 5]

        # 检查长度是否合理
        total_packet_size = (
            6 + packet.length + 4
        )  # Header + Len + Class + ID + Payload + Checksum
        if offset + total_packet_size > len(data):
            return None

        # 提取 Payload
        payload_start = offset + 6
        payload_end = payload_start + packet.length
        packet.payload = data[payload_start:payload_end]

        # 提取校验和
        checksum_start = payload_end
        packet.checksum = struct.unpack(
            "<I", data[checksum_start : checksum_start + 4]
        )[0]

        # 验证校验和
        calculated_checksum = self.calculate_checksum(
            packet.class_id, packet.message_id, packet.length, packet.payload
        )

        if calculated_checksum != packet.checksum:
            self.stats["checksum_errors"] += 1
            print(
                f"警告: 校验和错误 (偏移 {offset}): "
                f"计算值=0x{calculated_checksum:08X}, "
                f"数据包值=0x{packet.checksum:08X}"
            )

        # 解析消息载荷
        packet.parsed_data = self.parse_message_payload(packet)

        return packet

    def print_summary(self):
        """打印解析摘要"""
        print("\n=== 解析摘要 ===")
        print(f"总字节数: {self.stats['total_bytes']}")
        print(f"有效数据包: {self.stats['valid_packets']}")
        print(f"无效数据包: {self.stats['invalid_packets']}")
        print(f"校验和错误: {self.stats['checksum_errors']}")

        if self.packets:
            print("\n=== 数据包类型统计 ===")
            class_stats = {}
            for packet in self.packets:
                key = (packet.class_id, packet.message_id)
                class_stats[key] = class_stats.get(key, 0) + 1

            for (class_id, msg_id), count in sorted(class_stats.items()):
                print(f"Class 0x{class_id:02X}, ID 0x{msg_id:02X}: {count} 个包")

    def print_packets(self, limit: Optional[int] = None, verbose: bool = False):
        """打印数据包信息"""
        if not self.packets:
            print("没有找到有效的数据包")
            return

        print("\n=== 数据包列表 ===")
        packets_to_show = self.packets[:limit] if limit else self.packets

        for i, packet in enumerate(packets_to_show):
            print(f"[{i + 1:4d}] {packet}")

            if verbose:
                # 显示解析后的数据
                if packet.parsed_data:
                    self.print_parsed_data(packet.parsed_data, indent="       ")

                # 显示原始 Payload (最多显示前32字节)
                if packet.payload:
                    payload_preview = packet.payload[:32]
                    hex_str = " ".join(f"{b:02X}" for b in payload_preview)
                    if len(packet.payload) > 32:
                        hex_str += "..."
                    print(
                        f"       Raw Payload ({len(packet.payload)} bytes): {hex_str}"
                    )

        if limit and len(self.packets) > limit:
            print(f"... 还有 {len(self.packets) - limit} 个数据包")

    def print_parsed_data(self, data: Dict[str, Any], indent: str = ""):
        """打印解析后的数据"""
        if "error" in data:
            print(f"{indent}解析错误: {data['error']}")
            return

        for key, value in data.items():
            if key == "raw_data":
                continue  # 跳过原始数据显示
            elif isinstance(value, dict):
                print(f"{indent}{key}:")
                self.print_parsed_data(value, indent + "  ")
            elif isinstance(value, float):
                if "latitude" in key.lower() or "longitude" in key.lower():
                    print(f"{indent}{key}: {value:.8f}°")
                elif "accuracy" in key.lower():
                    print(f"{indent}{key}: {value:.4f}")
                else:
                    print(f"{indent}{key}: {value:.6f}")
            elif key == "flags":
                print(f"{indent}{key}: 0x{value:02X}")
            else:
                print(f"{indent}{key}: {value}")

    def export_to_csv(self, output_file: str):
        """导出数据包信息到 CSV 文件"""
        try:
            import csv

            with open(output_file, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(
                    [
                        "序号",
                        "消息类型",
                        "Class",
                        "ID",
                        "长度",
                        "校验和",
                        "解析状态",
                        "Payload(Hex)",
                    ]
                )

                for i, packet in enumerate(self.packets):
                    msg_type = self.get_message_name(packet.class_id, packet.message_id)
                    payload_hex = packet.payload.hex().upper() if packet.payload else ""
                    parse_status = (
                        "成功"
                        if packet.parsed_data and "error" not in packet.parsed_data
                        else "失败"
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
            print(f"数据包信息已导出到: {output_file}")
        except Exception as e:
            print(f"导出CSV时出错: {e}")

    def analyze_agnss_session(self):
        """分析AGNSS会话"""
        print("\n=== AGNSS 会话分析 ===")

        aid_ini_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x0B, 0x01)
        ]
        ack_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x05, 0x01)
        ]
        nack_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x05, 0x00)
        ]
        gps_eph_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x07)
        ]
        bds_eph_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x02)
        ]
        gps_utc_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x05)
        ]
        gps_ion_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x06)
        ]
        bds_utc_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x00)
        ]
        bds_ion_packets = [
            p for p in self.packets if (p.class_id, p.message_id) == (0x08, 0x01)
        ]

        print(f"AID-INI 命令: {len(aid_ini_packets)} 个")
        print(f"ACK 确认: {len(ack_packets)} 个")
        print(f"NACK 否定: {len(nack_packets)} 个")
        print(f"GPS 星历: {len(gps_eph_packets)} 个")
        print(f"BDS 星历: {len(bds_eph_packets)} 个")
        print(f"GPS UTC: {len(gps_utc_packets)} 个")
        print(f"GPS 电离层: {len(gps_ion_packets)} 个")
        print(f"BDS UTC: {len(bds_utc_packets)} 个")
        print(f"BDS 电离层: {len(bds_ion_packets)} 个")

        # 分析卫星覆盖范围
        gps_satellites = set()
        bds_satellites = set()

        for packet in gps_eph_packets:
            if packet.parsed_data and "satellite_id" in packet.parsed_data:
                gps_satellites.add(packet.parsed_data["satellite_id"])

        for packet in bds_eph_packets:
            if packet.parsed_data and "satellite_id" in packet.parsed_data:
                bds_satellites.add(packet.parsed_data["satellite_id"])

        if gps_satellites:
            print(
                f"\nGPS 卫星覆盖: {len(gps_satellites)} 颗卫星 - {sorted(gps_satellites)}"
            )
        if bds_satellites:
            print(
                f"BDS 卫星覆盖: {len(bds_satellites)} 颗卫星 - {sorted(bds_satellites)}"
            )

        # 分析AID-INI数据
        if aid_ini_packets:
            print("\n--- AID-INI 信息 ---")
            for i, packet in enumerate(aid_ini_packets):
                if packet.parsed_data and "error" not in packet.parsed_data:
                    data = packet.parsed_data
                    print(f"AID-INI #{i + 1}:")
                    print(
                        f"  位置: {data.get('latitude', 'N/A'):.6f}°, {data.get('longitude', 'N/A'):.6f}°"
                    )
                    print(f"  高度: {data.get('altitude', 'N/A'):.2f}m")
                    print(f"  GPS周: {data.get('week_number', 'N/A')}")
                    print(f"  时间戳: {data.get('time_of_week', 'N/A'):.3f}s")
                    flags = data.get("flags_detail", {})
                    print(
                        f"  有效性: 位置={flags.get('position_valid', False)}, 时间={flags.get('time_valid', False)}"
                    )

        # 分析ACK/NACK模式
        if ack_packets or nack_packets:
            print("\n--- 确认消息分析 ---")
            ack_types = {}
            nack_types = {}

            for packet in ack_packets:
                if packet.parsed_data:
                    ack_type = packet.parsed_data.get("acknowledged_type", "UNKNOWN")
                    ack_types[ack_type] = ack_types.get(ack_type, 0) + 1

            for packet in nack_packets:
                if packet.parsed_data:
                    nack_type = packet.parsed_data.get("acknowledged_type", "UNKNOWN")
                    nack_types[nack_type] = nack_types.get(nack_type, 0) + 1

            for msg_type, count in ack_types.items():
                print(f"  {msg_type} ACK: {count} 个")

            for msg_type, count in nack_types.items():
                print(f"  {msg_type} NACK: {count} 个")

        # AGNSS传输成功率
        total_data_packets = (
            len(gps_eph_packets) + len(bds_eph_packets) + len(aid_ini_packets)
        )
        if total_data_packets > 0:
            success_rate = (
                len(ack_packets) / total_data_packets * 100
                if total_data_packets > 0
                else 0
            )
            print(
                f"\nAGNSS 传输成功率: {success_rate:.1f}% ({len(ack_packets)}/{total_data_packets})"
            )

        # 数据完整性分析
        print("\n--- 数据完整性分析 ---")
        has_gps_data = (
            len(gps_eph_packets) > 0
            or len(gps_utc_packets) > 0
            or len(gps_ion_packets) > 0
        )
        has_bds_data = (
            len(bds_eph_packets) > 0
            or len(bds_utc_packets) > 0
            or len(bds_ion_packets) > 0
        )

        print(f"GPS 数据集: {'完整' if has_gps_data else '不完整'}")
        if has_gps_data:
            print(f"  - 星历数据: {len(gps_eph_packets)} 个")
            print(f"  - UTC 数据: {len(gps_utc_packets)} 个")
            print(f"  - 电离层数据: {len(gps_ion_packets)} 个")

        print(f"BDS 数据集: {'完整' if has_bds_data else '不完整'}")
        if has_bds_data:
            print(f"  - 星历数据: {len(bds_eph_packets)} 个")
            print(f"  - UTC 数据: {len(bds_utc_packets)} 个")
            print(f"  - 电离层数据: {len(bds_ion_packets)} 个")

    def filter_packets_by_type(
        self, class_id: int, message_id: int
    ) -> List[CasicPacket]:
        """按消息类型过滤数据包"""
        return [
            p
            for p in self.packets
            if p.class_id == class_id and p.message_id == message_id
        ]

    def get_agnss_statistics(self) -> Dict[str, int]:
        """获取AGNSS统计信息"""
        stats = {}
        for packet in self.packets:
            msg_type = self.get_message_name(packet.class_id, packet.message_id)
            stats[msg_type] = stats.get(msg_type, 0) + 1
        return stats


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="CASIC 协议数据文件解析器 (支持AGNSS)")
    parser.add_argument("filepath", help="要解析的数据文件路径")
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="显示详细信息 (包括解析后的数据内容)",
    )
    parser.add_argument(
        "-l", "--limit", type=int, metavar="N", help="限制显示的数据包数量"
    )
    parser.add_argument(
        "-o", "--output", metavar="FILE", help="导出数据包信息到 CSV 文件"
    )
    parser.add_argument("--no-summary", action="store_true", help="不显示解析摘要")
    parser.add_argument("--agnss", action="store_true", help="显示AGNSS会话分析")
    parser.add_argument(
        "--filter",
        metavar="CLASS:ID",
        help="过滤特定消息类型 (格式: 0x0B:0x01 或 11:1)",
    )

    args = parser.parse_args()

    # 创建解析器并解析文件
    casic_parser = CasicParser()

    print(f"正在解析文件: {args.filepath}")
    if not casic_parser.parse_file(args.filepath):
        sys.exit(1)

    # 处理过滤器
    if args.filter:
        try:
            parts = args.filter.split(":")
            if len(parts) != 2:
                raise ValueError("格式错误")

            class_id = int(parts[0], 16 if parts[0].startswith("0x") else 10)
            msg_id = int(parts[1], 16 if parts[1].startswith("0x") else 10)

            filtered_packets = casic_parser.filter_packets_by_type(class_id, msg_id)
            print(
                f"\n过滤结果: 找到 {len(filtered_packets)} 个 {casic_parser.get_message_name(class_id, msg_id)} 消息"
            )

            # 临时替换包列表以显示过滤结果
            original_packets = casic_parser.packets
            casic_parser.packets = filtered_packets
            casic_parser.print_packets(limit=args.limit, verbose=args.verbose)
            casic_parser.packets = original_packets

        except ValueError:
            print("错误: 过滤器格式无效，应为 CLASS:ID (如 0x0B:0x01 或 11:1)")
            sys.exit(1)
    else:
        # 显示结果
        if not args.no_summary:
            casic_parser.print_summary()

        if args.agnss:
            casic_parser.analyze_agnss_session()

        casic_parser.print_packets(limit=args.limit, verbose=args.verbose)

    # 导出到CSV (如果指定)
    if args.output:
        casic_parser.export_to_csv(args.output)


if __name__ == "__main__":
    main()
