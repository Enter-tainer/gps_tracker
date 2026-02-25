#!/usr/bin/env python3
"""
Owner-side companion for gps_tracker's Find My module.

Key derivation matches firmware/src/findmy.rs exactly:
- ANSI X9.63 KDF with SHA-256
- P-224 rolling key derivation (d_i = d * u_i' + v_i' mod q)
- BLE address and payload construction

Subcommands:
    generate  - Generate fresh key material for provisioning
    keys      - Derive and display rolling public keys (no auth needed)
    fetch     - Derive keys + query Apple API + decrypt location reports

Dependencies:
    pip install cryptography requests

For 'fetch' mode, you also need:
    1. auth.json with Apple ID credentials (dsid + searchPartyToken)
       Generate via: https://github.com/biemster/FindMy
    2. An anisette-v3-server running locally
       https://github.com/Dadoum/anisette-v3-server
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import struct
import sys
import time

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# P-224 curve order
P224_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFF16A2E0B8F03E13DD29455C5C2A3D

# Key rotation interval (must match firmware KEY_ROTATION_SECS)
KEY_ROTATION_SECS = 900  # 15 minutes


def counter_at(ts: int, epoch: int) -> int:
    """Counter index at unix timestamp `ts`, aligned to absolute 15-min slots."""
    return (ts // KEY_ROTATION_SECS) - (epoch // KEY_ROTATION_SECS)


# ---------------------------------------------------------------------------
# ANSI X9.63 KDF (SHA-256) — matches firmware kdf()
# ---------------------------------------------------------------------------


def kdf_x963(input_data: bytes, shared_info: bytes, output_len: int) -> bytes:
    """ANSI X9.63 Key Derivation Function using SHA-256.

    output = SHA256(input || counter_be32 || shared_info), iterated.
    """
    result = b""
    counter = 1
    while len(result) < output_len:
        h = hashlib.sha256()
        h.update(input_data)
        h.update(counter.to_bytes(4, "big"))
        h.update(shared_info)
        result += h.digest()
        counter += 1
    return result[:output_len]


# ---------------------------------------------------------------------------
# P-224 scalar arithmetic — matches firmware bytes_to_scalar / _nonzero
# ---------------------------------------------------------------------------


def bytes_to_scalar(data: bytes) -> int:
    """Convert bytes to P-224 scalar: take first 28 bytes, big-endian, reduce mod q."""
    if len(data) >= 28:
        buf = data[:28]
    else:
        buf = b"\x00" * (28 - len(data)) + data
    return int.from_bytes(buf, "big") % P224_ORDER


def bytes_to_scalar_nonzero(data: bytes) -> int:
    """Same as bytes_to_scalar but returns 1 if result is zero."""
    s = bytes_to_scalar(data)
    return s if s != 0 else 1


# ---------------------------------------------------------------------------
# Rolling key derivation — matches firmware derive_key_at()
# ---------------------------------------------------------------------------


def derive_key_at(
    master_private: bytes, sk0: bytes, counter: int
) -> tuple[int, bytes]:
    """Derive rolling key pair for time interval `counter`.

    Returns (private_key_int, public_key_x_bytes).
    """
    # Step 1: Iteratively derive SK_counter
    sk = sk0
    for _ in range(counter):
        sk = kdf_x963(sk, b"update", 32)

    # Step 2: Diversify to get u_i (36B) and v_i (36B)
    diversified = kdf_x963(sk, b"diversify", 72)
    u_bytes = diversified[:36]
    v_bytes = diversified[36:72]

    # Step 3: Scalar arithmetic
    d0 = bytes_to_scalar(master_private)
    u_i = bytes_to_scalar_nonzero(u_bytes)
    v_i = bytes_to_scalar_nonzero(v_bytes)

    # d_i = d0 * u_i + v_i (mod q)
    d_i = (d0 * u_i + v_i) % P224_ORDER

    # Step 4: P_i = d_i * G
    priv_key = ec.derive_private_key(d_i, ec.SECP224R1(), default_backend())
    pub_key = priv_key.public_key()
    x = pub_key.public_numbers().x
    x_bytes = x.to_bytes(28, "big")

    return d_i, x_bytes


def hashed_adv_key(public_key_x: bytes) -> str:
    """SHA-256 hash of public key x-coordinate, base64-encoded.

    This is the identifier Apple uses to index location reports.
    """
    return base64.b64encode(hashlib.sha256(public_key_x).digest()).decode()


def ble_address_from_key(public_key_x: bytes) -> str:
    """Extract BLE random static address from public key (matches firmware)."""
    addr = bytearray(public_key_x[:6])
    addr[0] |= 0xC0  # Set two MSBs for random static address
    return ":".join(f"{b:02X}" for b in addr)


# ---------------------------------------------------------------------------
# Apple API fetch + report decryption
# ---------------------------------------------------------------------------

APPLE_EPOCH = 978307200  # 2001-01-01 00:00:00 UTC


def load_auth(auth_path: str) -> tuple[str, str]:
    """Load Apple authentication from JSON file."""
    with open(auth_path) as f:
        j = json.load(f)
    return j["dsid"], j["searchPartyToken"]


def fetch_anisette_headers(anisette_url: str) -> dict:
    """Fetch anisette headers from a local anisette-v3-server."""
    import requests

    r = requests.get(anisette_url, timeout=5)
    h = r.json()
    return {
        "X-Apple-I-MD": h["X-Apple-I-MD"],
        "X-Apple-I-MD-M": h["X-Apple-I-MD-M"],
    }


def fetch_reports(
    dsid: str,
    token: str,
    key_hashes: list[str],
    hours: int,
    anisette_url: str,
) -> list[dict]:
    """Fetch location reports from Apple's acsnservice/fetch endpoint."""
    import requests

    now = int(time.time())
    start = now - (60 * 60 * hours)

    data = {
        "search": [
            {
                "startDate": start * 1000,
                "endDate": now * 1000,
                "ids": key_hashes,
            }
        ]
    }

    headers = fetch_anisette_headers(anisette_url)

    r = requests.post(
        "https://gateway.icloud.com/acsnservice/fetch",
        auth=(dsid, token),
        headers=headers,
        json=data,
    )

    if r.status_code != 200:
        print(f"Error: Apple API returned {r.status_code}", file=sys.stderr)
        print(r.text[:500], file=sys.stderr)
        return []

    return json.loads(r.content.decode()).get("results", [])


def decrypt_report(
    report_payload_b64: str, private_key_int: int
) -> dict | None:
    """Decrypt a single location report.

    Returns dict with lat, lon, confidence, status, timestamp.
    """
    data = base64.b64decode(report_payload_b64)

    # Handle variable-length payload (some have extra byte at offset 4)
    if len(data) > 88:
        data = data[:4] + data[5:]

    timestamp = int.from_bytes(data[0:4], "big") + APPLE_EPOCH

    # Ephemeral EC public key (SEC1 uncompressed, 57 bytes for P-224)
    eph_key_bytes = data[5:62]
    try:
        eph_key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP224R1(), eph_key_bytes
        )
    except Exception:
        return None

    # ECDH shared secret
    priv_key = ec.derive_private_key(
        private_key_int, ec.SECP224R1(), default_backend()
    )
    shared_key = priv_key.exchange(ec.ECDH(), eph_key)

    # Derive symmetric key
    sym_key = hashlib.sha256(
        shared_key + b"\x00\x00\x00\x01" + eph_key_bytes
    ).digest()
    decryption_key = sym_key[:16]
    iv = sym_key[16:]

    enc_data = data[62:72]
    tag = data[72:]

    # AES-GCM decrypt
    try:
        cipher = Cipher(algorithms.AES(decryption_key), modes.GCM(iv, tag))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(enc_data) + decryptor.finalize()
    except Exception:
        return None

    lat = struct.unpack(">i", plaintext[0:4])[0] / 10000000.0
    lon = struct.unpack(">i", plaintext[4:8])[0] / 10000000.0
    confidence = plaintext[8]
    status = plaintext[9]

    return {
        "lat": lat,
        "lon": lon,
        "confidence": confidence,
        "status": status,
        "timestamp": timestamp,
        "datetime": datetime.datetime.fromtimestamp(
            timestamp, tz=datetime.timezone.utc
        ).isoformat(),
    }


# ---------------------------------------------------------------------------
# Key material generation
# ---------------------------------------------------------------------------


def generate_keys() -> dict:
    """Generate fresh key material for provisioning."""
    import secrets

    # Generate random P-224 private key
    priv_key = ec.generate_private_key(ec.SECP224R1(), default_backend())
    d = priv_key.private_numbers().private_value
    private_key_bytes = d.to_bytes(28, "big")

    # Generate random symmetric key SK₀
    symmetric_key = secrets.token_bytes(32)

    # Epoch = current time (rounded to nearest 15-minute boundary)
    now = int(time.time())
    epoch = now - (now % KEY_ROTATION_SECS)

    return {
        "private_key": private_key_bytes.hex(),
        "symmetric_key": symmetric_key.hex(),
        "epoch": epoch,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_key_material(args) -> tuple[bytes, bytes, int]:
    """Load key material from CLI args or JSON file."""
    if args.keyfile:
        with open(args.keyfile) as f:
            j = json.load(f)
        return (
            bytes.fromhex(j["private_key"]),
            bytes.fromhex(j["symmetric_key"]),
            j["epoch"],
        )
    return (
        bytes.fromhex(args.private_key),
        bytes.fromhex(args.symmetric_key),
        args.epoch,
    )


def cmd_generate(args):
    """Generate fresh key material."""
    keys = generate_keys()

    if args.output:
        with open(args.output, "w") as f:
            json.dump(keys, f, indent=2)
        print(f"Keys written to {args.output}")
    else:
        print(json.dumps(keys, indent=2))

    print(f"\nProvision these to firmware via BLE:")
    print(f"  private_key  : {keys['private_key']}")
    print(f"  symmetric_key: {keys['symmetric_key']}")
    print(f"  epoch        : {keys['epoch']}")

    # Also derive and show the initial public key (counter=0) for verification
    d_0, x_0 = derive_key_at(
        bytes.fromhex(keys["private_key"]),
        bytes.fromhex(keys["symmetric_key"]),
        0,
    )
    print(f"\nInitial public key x (counter=0): {x_0.hex()}")
    print(f"  Hashed adv key: {hashed_adv_key(x_0)}")
    print(f"  BLE address   : {ble_address_from_key(x_0)}")


def cmd_keys(args):
    """Derive and display rolling keys."""
    priv, sk0, epoch = load_key_material(args)

    now = int(time.time())
    start = now - (60 * 60 * args.hours)

    # Compute counter range
    if start < epoch:
        start = epoch
    counter_start = counter_at(start, epoch)
    counter_end = counter_at(now, epoch)

    print(f"Epoch: {epoch} ({datetime.datetime.fromtimestamp(epoch, tz=datetime.timezone.utc).isoformat()})")
    print(f"Counter range: {counter_start} - {counter_end}")
    print(f"Keys to derive: {counter_end - counter_start + 1}")
    print()

    for i in range(counter_start, counter_end + 1):
        d_i, x_i = derive_key_at(priv, sk0, i)
        ts = (epoch // KEY_ROTATION_SECS + i) * KEY_ROTATION_SECS
        dt = datetime.datetime.fromtimestamp(
            ts, tz=datetime.timezone.utc
        ).strftime("%Y-%m-%d %H:%M UTC")
        h = hashed_adv_key(x_i)
        addr = ble_address_from_key(x_i)
        print(f"  [{i:4d}] {dt}  addr={addr}  hash={h[:12]}...")


def cmd_fetch(args):
    """Derive keys, fetch reports from Apple, decrypt."""
    priv, sk0, epoch = load_key_material(args)

    # Load auth
    auth_path = args.auth or os.path.join(os.path.dirname(__file__), "auth.json")
    if not os.path.exists(auth_path):
        print(
            f"Error: auth.json not found at {auth_path}\n"
            "Generate it using the FindMy project's authentication flow:\n"
            "  https://github.com/biemster/FindMy",
            file=sys.stderr,
        )
        sys.exit(1)

    dsid, token = load_auth(auth_path)

    now = int(time.time())
    start = now - (60 * 60 * args.hours)
    if start < epoch:
        start = epoch

    counter_start = counter_at(start, epoch)
    counter_end = counter_at(now, epoch)

    print(f"Deriving {counter_end - counter_start + 1} keys (counter {counter_start}-{counter_end})...")

    # Derive all keys for the time range
    # Map: hashed_adv_key -> (counter, private_key_int, public_key_x)
    key_map: dict[str, tuple[int, int, bytes]] = {}
    for i in range(counter_start, counter_end + 1):
        d_i, x_i = derive_key_at(priv, sk0, i)
        h = hashed_adv_key(x_i)
        key_map[h] = (i, d_i, x_i)

    print(f"Querying Apple with {len(key_map)} key hashes...")

    reports = fetch_reports(
        dsid, token, list(key_map.keys()), args.hours, args.anisette_url
    )
    print(f"Received {len(reports)} raw reports.")

    # Decrypt reports
    results = []
    for report in reports:
        key_hash = report["id"]
        if key_hash not in key_map:
            continue
        counter, d_i, x_i = key_map[key_hash]
        loc = decrypt_report(report["payload"], d_i)
        if loc:
            loc["counter"] = counter
            loc["maps_url"] = (
                f"https://maps.google.com/maps?q={loc['lat']},{loc['lon']}"
            )
            results.append(loc)

    results.sort(key=lambda r: r["timestamp"])

    print(f"\n{len(results)} locations decoded:\n")
    for r in results:
        print(
            f"  {r['datetime']}  "
            f"({r['lat']:.6f}, {r['lon']:.6f})  "
            f"conf={r['confidence']}  "
            f"counter={r['counter']}"
        )
        print(f"    {r['maps_url']}")

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nResults saved to {args.output}")


def main():
    parser = argparse.ArgumentParser(
        description="Owner-side Find My companion for gps_tracker"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # --- generate ---
    p_gen = sub.add_parser("generate", help="Generate fresh key material")
    p_gen.add_argument("-o", "--output", help="Output JSON file path")

    # --- keys ---
    p_keys = sub.add_parser("keys", help="Derive and display rolling keys")
    _add_key_args(p_keys)
    p_keys.add_argument(
        "-H", "--hours", type=int, default=24, help="Hours to look back (default: 24)"
    )

    # --- fetch ---
    p_fetch = sub.add_parser("fetch", help="Fetch and decrypt location reports")
    _add_key_args(p_fetch)
    p_fetch.add_argument(
        "-H", "--hours", type=int, default=24, help="Hours to look back (default: 24)"
    )
    p_fetch.add_argument("--auth", help="Path to auth.json")
    p_fetch.add_argument(
        "--anisette-url",
        default="http://localhost:6969",
        help="Anisette v3 server URL (default: http://localhost:6969)",
    )
    p_fetch.add_argument("-o", "--output", help="Save results to JSON file")

    args = parser.parse_args()

    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "keys":
        cmd_keys(args)
    elif args.command == "fetch":
        cmd_fetch(args)


def _add_key_args(parser):
    """Add key material arguments to a subparser."""
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "-k", "--keyfile", help="JSON file with private_key, symmetric_key, epoch"
    )
    group.add_argument(
        "--private-key", help="Master private key (56 hex chars, 28 bytes)"
    )
    parser.add_argument(
        "--symmetric-key", help="Initial symmetric key SK₀ (64 hex chars, 32 bytes)"
    )
    parser.add_argument("--epoch", type=int, help="Epoch unix timestamp")


if __name__ == "__main__":
    main()
