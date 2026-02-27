"""
UF2 firmware build tool.

Builds firmware, converts to Intel HEX, merges with SoftDevice, and generates UF2.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # uf2.py -> gps_tracker_tools -> src -> tools -> repo root
FIRMWARE_DIR = ROOT / "firmware"
TARGET = "thumbv7em-none-eabihf"
PROFILE = "release"
TARGET_DIR = FIRMWARE_DIR / "target" / TARGET / PROFILE

DEFAULT_ELF = TARGET_DIR / "gps-tracker-firmware"
DEFAULT_APP_HEX = TARGET_DIR / "gps-tracker-firmware.hex"
DEFAULT_SD_HEX = ROOT / "s140_nrf52_7.3.0_softdevice.hex"
DEFAULT_COMBINED_HEX = TARGET_DIR / "gps-tracker-combined.hex"
DEFAULT_UF2 = TARGET_DIR / "gps-tracker-combined.uf2"
UF2CONV = ROOT / "uf2conv.py"
UF2_FAMILY_ID = "0xADA52840"


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def build_firmware() -> None:
    run(
        [
            "cargo",
            "build",
            "--manifest-path",
            str(FIRMWARE_DIR / "Cargo.toml"),
            "--release",
            "--target",
            TARGET,
        ],
        cwd=FIRMWARE_DIR,
    )


def objcopy_to_hex(elf: Path, out_hex: Path) -> None:
    out_hex.parent.mkdir(parents=True, exist_ok=True)
    try:
        run(
            [
                "cargo",
                "objcopy",
                "--manifest-path",
                str(FIRMWARE_DIR / "Cargo.toml"),
                "--release",
                "--target",
                TARGET,
                "--",
                "-O",
                "ihex",
                str(out_hex),
            ],
            cwd=FIRMWARE_DIR,
        )
        return
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    try:
        run(
            [
                "llvm-objcopy",
                "-O",
                "ihex",
                str(elf),
                str(out_hex),
            ],
            cwd=FIRMWARE_DIR,
        )
        return
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    try:
        run(
            [
                "arm-none-eabi-objcopy",
                "-O",
                "ihex",
                str(elf),
                str(out_hex),
            ],
            cwd=FIRMWARE_DIR,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        raise RuntimeError(
            "objcopy not found. Install cargo-binutils (cargo install cargo-binutils), "
            "llvm-objcopy, or arm-none-eabi-objcopy."
        ) from err


def parse_ihex(path: Path) -> dict[int, int]:
    mem: dict[int, int] = {}
    upper = 0
    line_no = 0
    for line in path.read_text().splitlines():
        line_no += 1
        line = line.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise ValueError(f"{path}:{line_no}: missing ':'")
        try:
            count = int(line[1:3], 16)
            addr = int(line[3:7], 16)
            rectype = int(line[7:9], 16)
            data = bytes.fromhex(line[9 : 9 + count * 2])
            checksum = int(
                line[9 + count * 2 : 9 + count * 2 + 2], 16
            )
        except ValueError as err:
            raise ValueError(
                f"{path}:{line_no}: invalid hex record"
            ) from err

        total = (
            count + (addr >> 8) + (addr & 0xFF) + rectype + sum(data)
        )
        if ((-total) & 0xFF) != checksum:
            raise ValueError(
                f"{path}:{line_no}: checksum mismatch"
            )

        if rectype == 0x00:
            base = upper + addr
            for idx, byte in enumerate(data):
                abs_addr = base + idx
                prev = mem.get(abs_addr)
                if prev is not None and prev != byte:
                    raise ValueError(
                        f"{path}:{line_no}: overlap at 0x{abs_addr:08X}"
                    )
                mem[abs_addr] = byte
        elif rectype == 0x01:
            break
        elif rectype == 0x04:
            if len(data) != 2:
                raise ValueError(
                    f"{path}:{line_no}: bad type 04 length"
                )
            upper = ((data[0] << 8) | data[1]) << 16
        elif rectype == 0x02:
            if len(data) != 2:
                raise ValueError(
                    f"{path}:{line_no}: bad type 02 length"
                )
            upper = ((data[0] << 8) | data[1]) << 4
        else:
            continue
    return mem


def format_record(addr: int, rectype: int, data: bytes) -> str:
    count = len(data)
    parts = [
        count,
        (addr >> 8) & 0xFF,
        addr & 0xFF,
        rectype,
    ] + list(data)
    checksum = (-sum(parts)) & 0xFF
    return ":" + "".join(f"{b:02X}" for b in parts + [checksum])


def write_ihex(mem: dict[int, int], path: Path) -> None:
    if not mem:
        raise ValueError("no data to write")
    addresses = sorted(mem)
    lines: list[str] = []
    current_upper = None
    i = 0
    while i < len(addresses):
        addr = addresses[i]
        upper = addr >> 16
        if current_upper != upper:
            current_upper = upper
            data = upper.to_bytes(2, "big")
            lines.append(format_record(0, 0x04, data))

        low = addr & 0xFFFF
        chunk = [mem[addr]]
        i += 1
        while i < len(addresses):
            next_addr = addresses[i]
            if next_addr != addr + len(chunk):
                break
            if (next_addr >> 16) != current_upper:
                break
            if len(chunk) >= 16:
                break
            chunk.append(mem[next_addr])
            i += 1

        lines.append(format_record(low, 0x00, bytes(chunk)))

    lines.append(":00000001FF")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


def merge_hex(
    app_hex: Path, sd_hex: Path | None, out_hex: Path
) -> None:
    mem = parse_ihex(app_hex)
    if sd_hex is not None:
        sd_mem = parse_ihex(sd_hex)
        for addr, byte in sd_mem.items():
            prev = mem.get(addr)
            if prev is not None and prev != byte:
                raise ValueError(
                    f"overlap at 0x{addr:08X}"
                )
            mem[addr] = byte
    write_ihex(mem, out_hex)


def convert_to_uf2(in_hex: Path, out_uf2: Path) -> None:
    if not UF2CONV.is_file():
        raise FileNotFoundError(
            f"uf2conv.py not found at {UF2CONV}"
        )
    out_uf2.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            sys.executable,
            str(UF2CONV),
            str(in_hex),
            "-c",
            "-f",
            UF2_FAMILY_ID,
            "-o",
            str(out_uf2),
        ],
        cwd=ROOT,
    )


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_build(args) -> int:
    app_hex = args.app_hex or DEFAULT_APP_HEX
    combined_hex = DEFAULT_COMBINED_HEX

    if not args.no_build and args.app_hex is None:
        build_firmware()
        objcopy_to_hex(args.elf, app_hex)

    if not app_hex.is_file():
        raise FileNotFoundError(
            f"app hex not found: {app_hex}"
        )

    sd_hex = None if args.no_softdevice else args.softdevice
    if sd_hex is not None and not sd_hex.is_file():
        raise FileNotFoundError(
            f"SoftDevice hex not found: {sd_hex}"
        )

    merge_hex(app_hex, sd_hex, combined_hex)
    convert_to_uf2(combined_hex, args.out)
    print(f"UF2 ready: {args.out}")
    return 0


# ---------------------------------------------------------------------------
# CLI setup
# ---------------------------------------------------------------------------


def add_subcommands(subparsers) -> None:
    """Register UF2 subcommands."""
    p = subparsers.add_parser(
        "build",
        help="Build firmware + SoftDevice and generate a combined UF2",
    )
    p.add_argument(
        "--no-build",
        action="store_true",
        help="Skip cargo build.",
    )
    p.add_argument(
        "--app-hex",
        type=Path,
        default=None,
        help="Use existing app hex.",
    )
    p.add_argument(
        "--elf",
        type=Path,
        default=DEFAULT_ELF,
        help="App ELF path.",
    )
    p.add_argument(
        "--softdevice",
        type=Path,
        default=DEFAULT_SD_HEX,
        help="SoftDevice hex to merge.",
    )
    p.add_argument(
        "--no-softdevice",
        action="store_true",
        help="Skip SoftDevice merge (app-only UF2).",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_UF2,
        help="Output UF2 file path.",
    )
    p.set_defaults(func=cmd_build)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build firmware + SoftDevice and generate a combined UF2."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    add_subcommands(sub)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
