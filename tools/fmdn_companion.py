#!/usr/bin/env python3
"""
Owner-side companion for gps_tracker's Google FMDN module.

EID computation matches firmware/src/google_fmdn.rs exactly:
- AES-ECB-256 with 32-byte input block (K=10, 1024s rotation)
- SECP160R1 scalar multiplication for 20-byte EID
- Hashed flags byte via SHA-256

Subcommands:
    generate  - Generate a random 32-byte EIK
    keys      - Derive and display EID sequence for recent/future time windows
    key-ids   - Precompute truncated key IDs for Spot API upload

Dependencies:
    pip install cryptography

Note: Device registration and location report fetching require integration
with GoogleFindMyTools (https://github.com/leonboe1/GoogleFindMyTools) and
Google OAuth authentication via the Spot gRPC API. These advanced operations
are not yet implemented in this standalone tool.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# SECP160R1 curve parameters (matching firmware secp160r1.rs)
SECP160R1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFF
SECP160R1_A = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFC
SECP160R1_B = 0x1C97BEFC54BD7A8B65ACF89F81D4D4ADC565FA45
SECP160R1_N = 0x0100000000000000000001F4C8F927AED3CA752257
SECP160R1_GX = 0x4A96B5688EF573284664698968C38BB913CBFC82
SECP160R1_GY = 0x23A628553168947D59DCC912042351377AC5FB32

EID_ROTATION_SECS = 1024
K = 10
EIK_SIZE = 32


# ---------------------------------------------------------------------------
# SECP160R1 arithmetic (matches firmware secp160r1.rs)
# ---------------------------------------------------------------------------

def modinv(a: int, m: int) -> int:
    """Modular inverse via extended Euclidean algorithm."""
    if a < 0:
        a = a % m
    g, x, _ = _extended_gcd(a, m)
    if g != 1:
        raise ValueError("No modular inverse")
    return x % m


def _extended_gcd(a: int, b: int):
    if a == 0:
        return b, 0, 1
    g, x, y = _extended_gcd(b % a, a)
    return g, y - (b // a) * x, x


def point_add(x1: int, y1: int, x2: int, y2: int) -> tuple[int, int]:
    """Add two points on SECP160R1."""
    p = SECP160R1_P
    if x1 == 0 and y1 == 0:
        return x2, y2
    if x2 == 0 and y2 == 0:
        return x1, y1

    if x1 == x2 and y1 == y2:
        # Point doubling
        lam = (3 * x1 * x1 + SECP160R1_A) * modinv(2 * y1, p) % p
    elif x1 == x2:
        return 0, 0  # Point at infinity
    else:
        lam = (y2 - y1) * modinv(x2 - x1, p) % p

    x3 = (lam * lam - x1 - x2) % p
    y3 = (lam * (x1 - x3) - y1) % p
    return x3, y3


def scalar_mul(k: int, x: int, y: int) -> tuple[int, int]:
    """Scalar multiplication on SECP160R1 using double-and-add."""
    rx, ry = 0, 0
    qx, qy = x, y

    while k > 0:
        if k & 1:
            rx, ry = point_add(rx, ry, qx, qy)
        qx, qy = point_add(qx, qy, qx, qy)
        k >>= 1

    return rx, ry


# ---------------------------------------------------------------------------
# EID computation (matches firmware compute_eid)
# ---------------------------------------------------------------------------

def compute_eid(eik: bytes, unix_ts: int, battery_flags: int = 0x20) -> dict:
    """Compute EID for a given timestamp.

    Returns dict with: eid (20 bytes), hashed_flags, masked_ts, scalar_r.
    """
    assert len(eik) == EIK_SIZE

    # Mask timestamp: zero K lowest bits
    mask = ~((1 << K) - 1) & 0xFFFFFFFF
    masked_ts = unix_ts & mask

    # Build 32-byte AES input block
    block = bytearray(32)
    block[0:11] = b"\xff" * 11
    block[11] = K
    struct.pack_into(">I", block, 12, masked_ts)
    # bytes 16-26 are 0x00 (already)
    block[27] = K
    struct.pack_into(">I", block, 28, masked_ts)

    # AES-ECB-256 encrypt
    cipher = Cipher(algorithms.AES(eik), modes.ECB())
    encryptor = cipher.encryptor()
    r_prime = encryptor.update(bytes(block)) + encryptor.finalize()

    # Reduce r' mod n (SECP160R1 order)
    r_int = int.from_bytes(r_prime, "big") % SECP160R1_N

    # Scalar multiplication: R = r * G
    rx, ry = scalar_mul(r_int, SECP160R1_GX, SECP160R1_GY)

    # EID = x-coordinate of R, 20 bytes big-endian
    eid = rx.to_bytes(20, "big")

    # Hashed flags: SHA256(r_bytes)[0] XOR flags_raw
    r_bytes = r_int.to_bytes(20, "big")  # Right-aligned to curve size
    sha = hashlib.sha256(r_bytes).digest()
    hashed_flags = sha[0] ^ battery_flags

    return {
        "eid": eid,
        "hashed_flags": hashed_flags,
        "masked_ts": masked_ts,
        "scalar_r": r_int,
    }


# ---------------------------------------------------------------------------
# Key hierarchy (matches research doc section 4)
# ---------------------------------------------------------------------------

def derive_recovery_key(eik: bytes) -> bytes:
    return hashlib.sha256(eik + b"\x01").digest()[:8]


def derive_ring_key(eik: bytes) -> bytes:
    return hashlib.sha256(eik + b"\x02").digest()[:8]


def derive_tracking_key(eik: bytes) -> bytes:
    return hashlib.sha256(eik + b"\x03").digest()[:8]


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_generate(args):
    """Generate a random EIK."""
    eik = os.urandom(EIK_SIZE)

    result = {
        "eik": eik.hex(),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "recovery_key": derive_recovery_key(eik).hex(),
        "ring_key": derive_ring_key(eik).hex(),
        "tracking_key": derive_tracking_key(eik).hex(),
    }

    json_str = json.dumps(result, indent=2)
    print(json_str)

    if args.output:
        with open(args.output, "w") as f:
            f.write(json_str + "\n")
        print(f"\nSaved to {args.output}", file=sys.stderr)


def cmd_keys(args):
    """Derive and display EID sequence."""
    eik = load_eik(args.keys)

    now = int(time.time())
    hours = args.hours
    start_ts = now - hours * 3600
    end_ts = now + 3600  # Include 1 hour into the future

    # Align to rotation boundaries
    start_ts = start_ts & ~((1 << K) - 1)

    print(f"EIK: {eik.hex()}")
    print(f"Time range: {hours}h back + 1h forward")
    print(f"Rotation period: {EID_ROTATION_SECS}s")
    print()
    print(f"{'Counter':>8}  {'Timestamp':>10}  {'UTC Time':23}  {'EID (hex)':40}  {'HF':>4}")
    print("-" * 95)

    ts = start_ts
    counter = 0
    while ts <= end_ts:
        result = compute_eid(eik, ts)
        utc = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))
        marker = " <-- now" if abs(ts - now) < EID_ROTATION_SECS else ""
        print(
            f"{counter:>8}  {ts:>10}  {utc}  {result['eid'].hex()}  0x{result['hashed_flags']:02x}{marker}"
        )
        ts += EID_ROTATION_SECS
        counter += 1


def cmd_key_ids(args):
    """Precompute truncated key IDs for Spot API upload."""
    eik = load_eik(args.keys)

    now = int(time.time())
    hours = args.hours
    # Start 3 hours before now (matching Google's upload window)
    start_ts = (now - 3 * 3600) & ~((1 << K) - 1)
    end_ts = now + hours * 3600

    key_ids = []
    ts = start_ts
    while ts <= end_ts:
        result = compute_eid(eik, ts)
        # Truncated key ID = first 10 bytes of EID
        truncated = result["eid"][:10]
        key_ids.append({
            "timestamp": ts,
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
            "key_id": truncated.hex(),
        })
        ts += EID_ROTATION_SECS

    output = {
        "eik": eik.hex(),
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_ts)),
        "end": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end_ts)),
        "count": len(key_ids),
        "key_ids": key_ids,
    }

    json_str = json.dumps(output, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(json_str + "\n")
        print(f"Wrote {len(key_ids)} key IDs to {args.output}", file=sys.stderr)
    else:
        print(json_str)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_eik(path: str) -> bytes:
    """Load EIK from a JSON file."""
    with open(path) as f:
        data = json.load(f)

    eik_hex = data.get("eik")
    if not eik_hex or not isinstance(eik_hex, str):
        print("Error: JSON must contain an 'eik' field (hex string).", file=sys.stderr)
        sys.exit(1)

    eik = bytes.fromhex(eik_hex)
    if len(eik) != EIK_SIZE:
        print(f"Error: EIK must be {EIK_SIZE} bytes, got {len(eik)}.", file=sys.stderr)
        sys.exit(1)

    return eik


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Google FMDN companion tool for gps_tracker.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  # Generate EIK and save to file
  python fmdn_companion.py generate -o eik.json

  # Show EID sequence for last 24 hours
  python fmdn_companion.py keys -k eik.json -H 24

  # Precompute key IDs for Spot API upload (96 hours)
  python fmdn_companion.py key-ids -k eik.json -H 96 -o key_ids.json
""",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # generate
    gen = sub.add_parser("generate", help="Generate a random EIK")
    gen.add_argument("-o", "--output", help="Save JSON to file")

    # keys
    keys = sub.add_parser("keys", help="Derive and display EID sequence")
    keys.add_argument("-k", "--keys", required=True, help="EIK JSON file")
    keys.add_argument("-H", "--hours", type=int, default=24, help="Hours back (default: 24)")

    # key-ids
    kid = sub.add_parser("key-ids", help="Precompute truncated key IDs for API upload")
    kid.add_argument("-k", "--keys", required=True, help="EIK JSON file")
    kid.add_argument("-H", "--hours", type=int, default=96, help="Hours forward (default: 96)")
    kid.add_argument("-o", "--output", help="Save JSON to file")

    args = parser.parse_args()

    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "keys":
        cmd_keys(args)
    elif args.command == "key-ids":
        cmd_key_ids(args)


if __name__ == "__main__":
    main()
