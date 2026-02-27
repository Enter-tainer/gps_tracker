"""
Google FMDN location report fetching and decryption.

Implements the full flow:
1. Google OAuth authentication (Chrome → oauth_token → AAS token → ADM/Spot tokens)
2. Spot API (gRPC over HTTP/2) for key retrieval
3. Nova API for device listing and location requests
4. EID-based location report decryption (SECP160R1 + HKDF-SHA256 + AES-EAX-256)

Reference: GoogleFindMyTools (https://github.com/leonboe1/GoogleFindMyTools)
"""

import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path

from gps_tracker_tools.fmdn import (
    EID_ROTATION_SECS,
    EIK_SIZE,
    K,
    SECP160R1_A,
    SECP160R1_B,
    SECP160R1_GX,
    SECP160R1_GY,
    SECP160R1_N,
    SECP160R1_P,
    _sqrt_mod,
    compute_eid,
    scalar_mul,
)

# ---------------------------------------------------------------------------
# Token cache
# ---------------------------------------------------------------------------

DEFAULT_TOKEN_CACHE = "~/.config/gps-tracker/google_tokens.json"

# Google ADM FCM project credentials (public, used by official app)
FCM_PROJECT_ID = "google.com:api-project-289722593072"
FCM_APP_ID = "1:289722593072:android:3cfcf5bc359f0308"
FCM_API_KEY = "AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc"
FCM_SENDER_ID = "289722593072"

# Google Play Services OAuth parameters
ADM_SERVICE = "oauth2:https://www.googleapis.com/auth/android_device_manager"
ADM_APP = "com.google.android.apps.adm"
ADM_CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788"

SPOT_SERVICE = "oauth2:https://www.googleapis.com/auth/spot"
SPOT_APP = "com.google.android.gms"
SPOT_CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788"


def _load_token_cache(path: str) -> dict:
    p = Path(path).expanduser()
    if p.exists():
        return json.loads(p.read_text())
    return {}


def _save_token_cache(path: str, cache: dict) -> None:
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, indent=2))


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


def _get_android_id(cache: dict) -> str:
    """Get or create an Android ID for Google authentication."""
    if "android_id" in cache:
        return cache["android_id"]

    # Generate a random 16-digit hex Android ID
    android_id = os.urandom(8).hex()
    cache["android_id"] = android_id
    return android_id


def _request_oauth_token() -> str:
    """Open Chrome for interactive Google login, extract oauth_token cookie."""
    import undetected_chromedriver as uc
    from selenium.webdriver.support.ui import WebDriverWait

    print("Opening Chrome for Google login...", file=sys.stderr)
    print(
        "Please sign in to your Google account in the browser window.",
        file=sys.stderr,
    )

    options = uc.ChromeOptions()
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")

    driver = uc.Chrome(options=options)
    try:
        driver.get("https://accounts.google.com/EmbeddedSetup")

        # Wait up to 300 seconds for user to complete login
        WebDriverWait(driver, 300).until(
            lambda d: d.get_cookie("oauth_token") is not None
        )

        oauth_token = driver.get_cookie("oauth_token")["value"]
        print("Login successful!", file=sys.stderr)
        return oauth_token
    finally:
        driver.quit()


def _get_aas_token(cache: dict) -> str:
    """Get AAS token, refreshing via Chrome if needed."""
    if "aas_token" in cache:
        return cache["aas_token"]

    import gpsoauth

    android_id = _get_android_id(cache)
    oauth_token = _request_oauth_token()

    # Exchange oauth_token for AAS token
    response = gpsoauth.exchange_token(
        email=cache.get("username", ""),
        token=oauth_token,
        android_id=android_id,
    )

    if "Token" not in response:
        print(
            f"Error: AAS token exchange failed: {response}",
            file=sys.stderr,
        )
        sys.exit(1)

    aas_token = response["Token"]
    if "Email" in response:
        cache["username"] = response["Email"]
    cache["aas_token"] = aas_token
    return aas_token


def _get_adm_token(cache: dict) -> str:
    """Get ADM token for Nova API."""
    if "adm_token" in cache:
        return cache["adm_token"]

    import gpsoauth

    aas_token = _get_aas_token(cache)
    android_id = _get_android_id(cache)
    username = cache.get("username", "")

    response = gpsoauth.perform_oauth(
        email=username,
        master_token=aas_token,
        android_id=android_id,
        service=ADM_SERVICE,
        app=ADM_APP,
        client_sig=ADM_CLIENT_SIG,
    )

    if "Auth" not in response:
        print(
            f"Error: ADM token retrieval failed: {response}",
            file=sys.stderr,
        )
        # Clear cached AAS token as it may have expired
        cache.pop("aas_token", None)
        sys.exit(1)

    adm_token = response["Auth"]
    cache["adm_token"] = adm_token
    return adm_token


def _get_spot_token(cache: dict) -> str:
    """Get Spot token for Spot API."""
    if "spot_token" in cache:
        return cache["spot_token"]

    import gpsoauth

    aas_token = _get_aas_token(cache)
    android_id = _get_android_id(cache)
    username = cache.get("username", "")

    response = gpsoauth.perform_oauth(
        email=username,
        master_token=aas_token,
        android_id=android_id,
        service=SPOT_SERVICE,
        app=SPOT_APP,
        client_sig=SPOT_CLIENT_SIG,
    )

    if "Auth" not in response:
        print(
            f"Error: Spot token retrieval failed: {response}",
            file=sys.stderr,
        )
        cache.pop("aas_token", None)
        sys.exit(1)

    spot_token = response["Auth"]
    cache["spot_token"] = spot_token
    return spot_token


# ---------------------------------------------------------------------------
# gRPC helpers
# ---------------------------------------------------------------------------


def _construct_grpc(payload: bytes) -> bytes:
    """Wrap protobuf payload in gRPC wire format."""
    # 1 byte: compressed flag (0x00) | 4 bytes: big-endian length | payload
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def _extract_grpc_payload(grpc_data: bytes) -> bytes:
    """Extract protobuf payload from gRPC wire format."""
    if len(grpc_data) < 5:
        return b""
    length = struct.unpack(">I", grpc_data[1:5])[0]
    return grpc_data[5 : 5 + length]


# ---------------------------------------------------------------------------
# Minimal protobuf encoding (avoids requiring .proto compilation)
# ---------------------------------------------------------------------------


def _encode_varint(value: int) -> bytes:
    """Encode an unsigned integer as a protobuf varint."""
    result = bytearray()
    while value > 0x7F:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def _encode_field(field_number: int, wire_type: int, data: bytes) -> bytes:
    """Encode a single protobuf field."""
    tag = _encode_varint((field_number << 3) | wire_type)
    if wire_type == 0:  # Varint
        return tag + data
    elif wire_type == 2:  # Length-delimited
        return tag + _encode_varint(len(data)) + data
    elif wire_type == 5:  # 32-bit (sfixed32)
        return tag + data
    return tag + data


def _decode_varint(data: bytes, offset: int) -> tuple[int, int]:
    """Decode a varint from data at offset. Returns (value, new_offset)."""
    result = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError("Varint extends beyond data")
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, offset


def _decode_protobuf_fields(data: bytes) -> dict[int, list]:
    """Decode protobuf message into {field_number: [values]} dict.

    Values are (wire_type, raw_bytes) tuples.
    """
    fields: dict[int, list] = {}
    offset = 0
    while offset < len(data):
        tag, offset = _decode_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:  # Varint
            value, offset = _decode_varint(data, offset)
            fields.setdefault(field_number, []).append(
                (wire_type, value)
            )
        elif wire_type == 2:  # Length-delimited
            length, offset = _decode_varint(data, offset)
            value = data[offset : offset + length]
            offset += length
            fields.setdefault(field_number, []).append(
                (wire_type, value)
            )
        elif wire_type == 5:  # 32-bit
            value = data[offset : offset + 4]
            offset += 4
            fields.setdefault(field_number, []).append(
                (wire_type, value)
            )
        elif wire_type == 1:  # 64-bit
            value = data[offset : offset + 8]
            offset += 8
            fields.setdefault(field_number, []).append(
                (wire_type, value)
            )
        else:
            break  # Unknown wire type

    return fields


# ---------------------------------------------------------------------------
# Spot API
# ---------------------------------------------------------------------------

SPOT_BASE = "https://spot-pa.googleapis.com/google.internal.spot.v1.SpotService"

SPOT_HEADERS = {
    "User-Agent": "com.google.android.gms/244433022 grpc-java-cronet/1.69.0-SNAPSHOT",
    "Content-Type": "application/grpc",
    "Te": "trailers",
    "Grpc-Accept-Encoding": "gzip",
}


def _spot_request(method: str, payload: bytes, spot_token: str) -> bytes:
    """Make a gRPC request to the Spot API."""
    import httpx

    url = f"{SPOT_BASE}/{method}"
    headers = {
        **SPOT_HEADERS,
        "Authorization": f"Bearer {spot_token}",
    }
    grpc_payload = _construct_grpc(payload)

    with httpx.Client(http2=True, timeout=30.0) as client:
        response = client.post(url, headers=headers, content=grpc_payload)
        if response.status_code != 200:
            print(
                f"Spot API error: {response.status_code}",
                file=sys.stderr,
            )
            return b""
        return _extract_grpc_payload(response.content)


# ---------------------------------------------------------------------------
# Nova API
# ---------------------------------------------------------------------------

NOVA_BASE = "https://android.googleapis.com/nova"


def _nova_request(scope: str, payload: bytes, adm_token: str) -> bytes:
    """Make a request to the Nova API."""
    import requests

    url = f"{NOVA_BASE}/{scope}"
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Authorization": f"Bearer {adm_token}",
        "Accept-Language": "en-US",
        "User-Agent": "fmd/20006320; gzip",
    }
    response = requests.post(url, headers=headers, data=payload)
    if response.status_code != 200:
        print(
            f"Nova API error: {response.status_code}",
            file=sys.stderr,
        )
        return b""
    return response.content


# ---------------------------------------------------------------------------
# Device listing and EIK retrieval
# ---------------------------------------------------------------------------


def _build_list_devices_request() -> bytes:
    """Build protobuf request for nbe_list_devices.

    DevicesListRequest {
      DevicesListRequestPayload deviceListRequestPayload = 1 {
        DeviceType type = 1;  // SPOT_DEVICE = 2
        string id = 3;        // Random UUID
      }
    }
    """
    import uuid

    random_id = str(uuid.uuid4())
    inner = (
        _encode_field(1, 0, _encode_varint(2))  # type = SPOT_DEVICE
        + _encode_field(3, 2, random_id.encode())  # id = UUID
    )
    return _encode_field(1, 2, inner)


def _parse_device_list(data: bytes) -> list[dict]:
    """Parse DevicesList response to extract device info and encrypted EIKs."""
    fields = _decode_protobuf_fields(data)
    devices = []

    # DevicesList.deviceMetadata = field 2 (repeated)
    for _, device_bytes in fields.get(2, []):
        if not isinstance(device_bytes, bytes):
            continue
        device_fields = _decode_protobuf_fields(device_bytes)

        # Extract device name (field 5)
        name = ""
        for _, val in device_fields.get(5, []):
            if isinstance(val, bytes):
                name = val.decode("utf-8", errors="replace")

        # Extract identifier info (field 1)
        canonic_id = ""
        for _, id_bytes in device_fields.get(1, []):
            if isinstance(id_bytes, bytes):
                id_fields = _decode_protobuf_fields(id_bytes)
                for _, cid_val in id_fields.get(1, []):
                    if isinstance(cid_val, bytes):
                        canonic_id = cid_val.decode(
                            "utf-8", errors="replace"
                        )

        # Extract device info -> registration -> encryptedUserSecrets
        encrypted_eik = b""
        for _, info_bytes in device_fields.get(4, []):
            if not isinstance(info_bytes, bytes):
                continue
            info_fields = _decode_protobuf_fields(info_bytes)
            for _, reg_bytes in info_fields.get(1, []):
                if not isinstance(reg_bytes, bytes):
                    continue
                reg_fields = _decode_protobuf_fields(reg_bytes)
                for _, secrets_bytes in reg_fields.get(19, []):
                    if not isinstance(secrets_bytes, bytes):
                        continue
                    secrets_fields = _decode_protobuf_fields(
                        secrets_bytes
                    )
                    for _, eik_val in secrets_fields.get(1, []):
                        if isinstance(eik_val, bytes):
                            encrypted_eik = eik_val

        # Extract location reports
        locations = []
        for _, info_bytes in device_fields.get(4, []):
            if not isinstance(info_bytes, bytes):
                continue
            info_fields = _decode_protobuf_fields(info_bytes)
            for _, loc_info_bytes in info_fields.get(2, []):
                if not isinstance(loc_info_bytes, bytes):
                    continue
                loc_fields = _decode_protobuf_fields(loc_info_bytes)

                # networkLocations (field 5, repeated)
                for _, loc_bytes in loc_fields.get(5, []):
                    if isinstance(loc_bytes, bytes):
                        locations.append(loc_bytes)

                # networkLocationTimestamps (field 6, repeated)
                timestamps = []
                for _, ts_bytes in loc_fields.get(6, []):
                    if isinstance(ts_bytes, bytes):
                        ts_fields = _decode_protobuf_fields(ts_bytes)
                        for _, ts_val in ts_fields.get(1, []):
                            if isinstance(ts_val, int):
                                timestamps.append(ts_val)

        devices.append(
            {
                "name": name,
                "canonic_id": canonic_id,
                "encrypted_eik": encrypted_eik,
                "raw_locations": locations,
                "location_timestamps": timestamps,
            }
        )

    return devices


def _decrypt_eik(owner_key: bytes, encrypted_eik: bytes) -> bytes:
    """Decrypt EIK using owner_key.

    Supports both AES-CBC (48-byte) and AES-GCM (60-byte) formats.
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7

    if len(encrypted_eik) == 48:
        # AES-CBC: 16-byte IV + 32-byte ciphertext (no padding needed for 32 bytes)
        iv = encrypted_eik[:16]
        ciphertext = encrypted_eik[16:]
        cipher = Cipher(algorithms.AES(owner_key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
        # Remove PKCS7 padding if present
        try:
            unpadder = PKCS7(128).unpadder()
            plaintext = unpadder.update(plaintext) + unpadder.finalize()
        except Exception:
            pass
        return plaintext
    elif len(encrypted_eik) == 60:
        # AES-GCM: 12-byte IV + 32-byte ciphertext + 16-byte tag
        iv = encrypted_eik[:12]
        tag = encrypted_eik[-16:]
        ciphertext = encrypted_eik[12:-16]
        cipher = Cipher(algorithms.AES(owner_key), modes.GCM(iv, tag))
        decryptor = cipher.decryptor()
        return decryptor.update(ciphertext) + decryptor.finalize()
    else:
        raise ValueError(
            f"Invalid encrypted EIK length: {len(encrypted_eik)} "
            "(expected 48 for AES-CBC or 60 for AES-GCM)"
        )


# ---------------------------------------------------------------------------
# Location report decryption
# ---------------------------------------------------------------------------


def _decrypt_crowdsourced_report(
    eik: bytes,
    encrypted_location: bytes,
    sender_pubkey_x: bytes,
    beacon_time_counter: int,
) -> dict | None:
    """Decrypt a crowdsourced FMDN location report.

    Algorithm:
    1. Recompute r from EIK + timestamp (same as EID generation)
    2. Recover sender's full public key S from x-coordinate
    3. ECDH: shared_point = r * S (SECP160R1)
    4. HKDF-SHA256(ikm=shared_x, len=32) → AES key
    5. nonce = last_8_bytes(R.x) || last_8_bytes(S.x)
    6. AES-EAX-256 decrypt
    """
    from Cryptodome.Cipher import AES as AES_Cryptodome
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    # Step 1: Recompute r from EID generation
    eid_result = compute_eid(eik, beacon_time_counter)
    r_int = eid_result["scalar_r"]

    # Recompute R = r * G (to get R.x for nonce)
    rx, ry = scalar_mul(r_int, SECP160R1_GX, SECP160R1_GY)
    r_x_bytes = rx.to_bytes(20, "big")

    # Step 2: Recover sender point S from Sx
    sx_int = int.from_bytes(sender_pubkey_x, "big")
    rhs = (pow(sx_int, 3, SECP160R1_P) + SECP160R1_A * sx_int + SECP160R1_B) % SECP160R1_P
    sy = _sqrt_mod(rhs, SECP160R1_P)
    if sy is None:
        return None
    # Pick even y
    if sy % 2 != 0:
        sy = SECP160R1_P - sy

    # Step 3: ECDH shared secret
    shared_x, shared_y = scalar_mul(r_int, sx_int, sy)
    if shared_x == 0 and shared_y == 0:
        return None
    shared_secret = shared_x.to_bytes(20, "big")

    # Step 4: HKDF-SHA256 → 32-byte AES key
    aes_key = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=None,
        info=b"",
    ).derive(shared_secret)

    # Step 5: Nonce = last 8 bytes of R.x || last 8 bytes of S.x
    nonce = r_x_bytes[12:] + sender_pubkey_x[12:]  # 16 bytes

    # Step 6: Split ciphertext and tag
    if len(encrypted_location) < 16:
        return None
    ciphertext = encrypted_location[:-16]
    tag = encrypted_location[-16:]

    # AES-EAX-256 decrypt
    try:
        cipher = AES_Cryptodome.new(aes_key, AES_Cryptodome.MODE_EAX, nonce=nonce)
        plaintext = cipher.decrypt_and_verify(ciphertext, tag)
    except (ValueError, KeyError):
        return None

    # Parse Location protobuf
    return _parse_location_protobuf(plaintext, beacon_time_counter)


def _decrypt_own_report(
    eik: bytes,
    encrypted_location: bytes,
    beacon_time_counter: int,
) -> dict | None:
    """Decrypt an own-device FMDN location report.

    Own reports use AES-GCM with SHA256(identity_key) as key.
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    identity_key_hash = hashlib.sha256(eik).digest()

    if len(encrypted_location) < 28:
        return None

    # AES-GCM: 12-byte IV + ciphertext + 16-byte tag
    iv = encrypted_location[:12]
    tag = encrypted_location[-16:]
    ciphertext = encrypted_location[12:-16]

    try:
        cipher = Cipher(
            algorithms.AES(identity_key_hash),
            modes.GCM(iv, tag),
        )
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    except Exception:
        return None

    return _parse_location_protobuf(plaintext, beacon_time_counter)


def _parse_location_protobuf(data: bytes, timestamp: int) -> dict | None:
    """Parse a decrypted Location protobuf message.

    message Location {
        sfixed32 latitude = 1;   // field 1, wire type 5
        sfixed32 longitude = 2;  // field 2, wire type 5
        int32 altitude = 3;      // field 3, wire type 0
    }
    """
    fields = _decode_protobuf_fields(data)

    lat_e7 = None
    lon_e7 = None
    altitude = 0

    # latitude (field 1, sfixed32 = wire type 5)
    for wt, val in fields.get(1, []):
        if wt == 5 and isinstance(val, bytes) and len(val) == 4:
            lat_e7 = struct.unpack("<i", val)[0]

    # longitude (field 2, sfixed32 = wire type 5)
    for wt, val in fields.get(2, []):
        if wt == 5 and isinstance(val, bytes) and len(val) == 4:
            lon_e7 = struct.unpack("<i", val)[0]

    # altitude (field 3, varint)
    for wt, val in fields.get(3, []):
        if wt == 0 and isinstance(val, int):
            altitude = val

    if lat_e7 is None or lon_e7 is None:
        return None

    return {
        "lat": lat_e7 / 1e7,
        "lon": lon_e7 / 1e7,
        "altitude": altitude,
        "timestamp": timestamp,
        "datetime": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)
        ),
    }


def _decrypt_location_report(
    eik: bytes,
    location_report_bytes: bytes,
    timestamp: int,
) -> dict | None:
    """Decrypt a LocationReport from the Nova API response.

    LocationReport structure:
      field 10: GeoLocation {
        field 1: EncryptedReport {
          field 1: bytes publicKeyRandom (Sx)
          field 2: bytes encryptedLocation
          field 3: bool isOwnReport
        }
        field 2: uint32 deviceTimeOffset
        field 3: float accuracy
      }
    """
    fields = _decode_protobuf_fields(location_report_bytes)

    # GeoLocation (field 10)
    for _, geo_bytes in fields.get(10, []):
        if not isinstance(geo_bytes, bytes):
            continue
        geo_fields = _decode_protobuf_fields(geo_bytes)

        # EncryptedReport (field 1)
        for _, enc_bytes in geo_fields.get(1, []):
            if not isinstance(enc_bytes, bytes):
                continue
            enc_fields = _decode_protobuf_fields(enc_bytes)

            sender_pubkey_x = b""
            encrypted_location = b""
            is_own = False

            for _, val in enc_fields.get(1, []):
                if isinstance(val, bytes):
                    sender_pubkey_x = val

            for _, val in enc_fields.get(2, []):
                if isinstance(val, bytes):
                    encrypted_location = val

            for _, val in enc_fields.get(3, []):
                if isinstance(val, int):
                    is_own = bool(val)

            if not encrypted_location:
                continue

            # deviceTimeOffset (field 2 of GeoLocation)
            device_time_offset = 0
            for _, val in geo_fields.get(2, []):
                if isinstance(val, int):
                    device_time_offset = val

            # accuracy (field 3 of GeoLocation, float)
            accuracy = 0.0
            for _, val in geo_fields.get(3, []):
                if isinstance(val, bytes) and len(val) == 4:
                    accuracy = struct.unpack("<f", val)[0]

            report_ts = timestamp + device_time_offset

            if is_own or not sender_pubkey_x:
                result = _decrypt_own_report(
                    eik, encrypted_location, report_ts
                )
            else:
                result = _decrypt_crowdsourced_report(
                    eik,
                    encrypted_location,
                    sender_pubkey_x,
                    report_ts,
                )

            if result:
                result["accuracy"] = accuracy
                result["is_own_report"] = is_own
                return result

    return None


# ---------------------------------------------------------------------------
# High-level fetch API
# ---------------------------------------------------------------------------


def fetch_fmdn_reports(
    eik: bytes,
    hours: int = 24,
    token_cache: str = DEFAULT_TOKEN_CACHE,
) -> list[dict]:
    """Fetch and decrypt FMDN location reports from Google.

    This is the main entry point for the FMDN fetch functionality.

    Args:
        eik: 32-byte Ephemeral Identity Key
        hours: Hours to look back
        token_cache: Path to token cache file

    Returns:
        List of decrypted location dicts with lat, lon, accuracy, timestamp.
    """
    cache = _load_token_cache(token_cache)

    # Get authentication tokens
    print("Authenticating with Google...", file=sys.stderr)
    adm_token = _get_adm_token(cache)
    _save_token_cache(token_cache, cache)

    # List devices to get location reports
    print("Listing devices...", file=sys.stderr)
    request_payload = _build_list_devices_request()
    response = _nova_request(
        "nbe_list_devices", request_payload, adm_token
    )

    if not response:
        print(
            "Error: No response from Nova API.",
            file=sys.stderr,
        )
        return []

    devices = _parse_device_list(response)
    print(
        f"Found {len(devices)} device(s).",
        file=sys.stderr,
    )

    # Find the device matching our EIK
    # Since we already have the EIK, we decrypt location reports directly
    all_results = []

    for device in devices:
        name = device["name"] or "Unknown"
        print(f"  Device: {name}", file=sys.stderr)

        raw_locations = device["raw_locations"]
        timestamps = device["location_timestamps"]

        if not raw_locations:
            print("    No location reports.", file=sys.stderr)
            continue

        print(
            f"    {len(raw_locations)} location report(s).",
            file=sys.stderr,
        )

        # Try to decrypt each location report with our EIK
        for i, loc_bytes in enumerate(raw_locations):
            ts = timestamps[i] if i < len(timestamps) else int(
                time.time()
            )
            result = _decrypt_location_report(eik, loc_bytes, ts)
            if result:
                result["device_name"] = name
                all_results.append(result)

    if not all_results:
        print(
            "\nNo locations could be decrypted with the provided EIK.",
            file=sys.stderr,
        )
        print(
            "Possible causes:",
            file=sys.stderr,
        )
        print(
            "  - EIK doesn't match any registered device",
            file=sys.stderr,
        )
        print(
            "  - No recent crowdsourced reports available",
            file=sys.stderr,
        )

    _save_token_cache(token_cache, cache)
    return all_results
