//! Apple Find My offline finding P-224 key derivation and BLE advertisement builder.
//!
//! Mirrors `firmware/src/findmy.rs` so PC simulation tests validate the exact
//! rolling-key cryptography, byte ordering, and 31-byte Legacy PDU payload used on hardware.

use p224::elliptic_curve::ops::Reduce;
use p224::elliptic_curve::sec1::ToEncodedPoint;
use p224::{FieldBytes, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

/// Key rotation interval in seconds (15 minutes).
pub const KEY_ROTATION_SECS: u64 = 900;

/// Fixed-size buffer for KDF output (max 72 bytes for "diversify").
struct KdfOutput {
    data: [u8; 72],
    len: usize,
}

impl KdfOutput {
    fn new() -> Self {
        Self {
            data: [0u8; 72],
            len: 0,
        }
    }

    fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }
}

/// ANSI X9.63 Key Derivation Function using SHA-256.
pub fn kdf(input: &[u8], shared_info: &[u8], bytes_to_return: usize) -> [u8; 72] {
    let mut result = KdfOutput::new();
    let mut counter: u32 = 1;

    while result.len < bytes_to_return {
        let mut sha = Sha256::new();
        sha.update(input);
        sha.update(counter.to_be_bytes());
        sha.update(shared_info);
        let hash = sha.finalize();

        let remaining = bytes_to_return - result.len;
        let to_copy = remaining.min(32);
        result.data[result.len..result.len + to_copy].copy_from_slice(&hash[..to_copy]);
        result.len += to_copy;
        counter += 1;
    }

    let _ = result.as_slice();
    result.data
}

/// Advance symmetric key from `start_sk` at `start_counter` to `target_counter`.
pub fn advance_sk(start_sk: &[u8; 32], start_counter: u32, target_counter: u32) -> [u8; 32] {
    let mut sk = *start_sk;
    for _ in start_counter..target_counter {
        let derived = kdf(&sk, b"update", 32);
        sk.copy_from_slice(&derived[..32]);
    }
    sk
}

fn bytes_to_scalar(bytes: &[u8]) -> Scalar {
    let mut buf = FieldBytes::default();
    let copy_len = bytes.len().min(28);
    buf[28 - copy_len..].copy_from_slice(&bytes[..copy_len]);
    Scalar::reduce_bytes(&buf)
}

fn bytes_to_scalar_nonzero(bytes: &[u8]) -> Scalar {
    let scalar = bytes_to_scalar(bytes);
    if bool::from(scalar.is_zero()) {
        Scalar::ONE
    } else {
        scalar
    }
}

/// Derive the 28-byte P-224 public key X-coordinate for rolling interval `counter`.
pub fn derive_key_at(master_private: &[u8; 28], sk0: &[u8; 32], counter: u32) -> [u8; 28] {
    let sk = advance_sk(sk0, 0, counter);
    let diversified = kdf(&sk, b"diversify", 72);
    let u_bytes = &diversified[..36];
    let v_bytes = &diversified[36..72];

    let d0 = bytes_to_scalar(master_private);
    let u_i = bytes_to_scalar_nonzero(u_bytes);
    let v_i = bytes_to_scalar_nonzero(v_bytes);
    let d_i = d0 * u_i + v_i;

    let p_i = ProjectivePoint::GENERATOR * d_i;
    let p_i_affine = p_i.to_affine();
    let encoded = p_i_affine.to_encoded_point(false);
    let x_bytes = encoded.x().expect("valid point");

    let mut public_key_x = [0u8; 28];
    public_key_x.copy_from_slice(x_bytes);
    public_key_x
}

/// Map battery percentage to Apple Find My status byte.
pub fn battery_to_status(battery_percent: u8) -> u8 {
    if battery_percent > 80 {
        0x10
    } else if battery_percent > 30 {
        0x50
    } else if battery_percent > 10 {
        0x90
    } else {
        0xD0
    }
}

/// Build the 31-byte Apple Find My Legacy BLE advertisement payload.
pub fn build_adv_payload(public_key_x: &[u8; 28], status: u8) -> [u8; 31] {
    let mut payload = [0u8; 31];
    payload[0] = 0x1e; // Length (30)
    payload[1] = 0xff; // Manufacturer Specific Data
    payload[2] = 0x4c; // Apple Company ID (little-endian)
    payload[3] = 0x00;
    payload[4] = 0x12; // Offline Finding type
    payload[5] = 0x19; // Payload length (25 bytes)
    payload[6] = status;
    payload[7..29].copy_from_slice(&public_key_x[6..28]);
    payload[29] = public_key_x[0] >> 6;
    payload[30] = 0x00; // Hint byte (reserved)
    payload
}

/// Extract BLE static random address (LSB-first) from `public_key_x`.
pub fn build_ble_address(public_key_x: &[u8; 28]) -> [u8; 6] {
    [
        public_key_x[5],
        public_key_x[4],
        public_key_x[3],
        public_key_x[2],
        public_key_x[1],
        public_key_x[0] | 0xC0,
    ]
}

/// Reconstruct the 28-byte `public_key_x` from over-the-air `(MAC_lsb, adv_payload)`.
pub fn reconstruct_public_key_x(ble_addr_lsb: &[u8; 6], adv_payload: &[u8; 31]) -> [u8; 28] {
    let mut key = [0u8; 28];
    key[0] = (ble_addr_lsb[5] & 0x3F) | ((adv_payload[29] & 0x03) << 6);
    key[1] = ble_addr_lsb[4];
    key[2] = ble_addr_lsb[3];
    key[3] = ble_addr_lsb[2];
    key[4] = ble_addr_lsb[1];
    key[5] = ble_addr_lsb[0];
    key[6..28].copy_from_slice(&adv_payload[7..29]);
    key
}

/// SHA-256 index hash Apple uses for Find My report lookup.
pub fn hashed_adv_key(public_key_x: &[u8; 28]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(public_key_x);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Derive full Find My advertisement bundle `(payload, ble_addr_lsb, public_key_x)` for `counter`.
pub fn derive_advertisement(
    master_private: &[u8; 28],
    sk0: &[u8; 32],
    counter: u32,
    battery_percent: u8,
) -> ([u8; 31], [u8; 6], [u8; 28]) {
    let pub_x = derive_key_at(master_private, sk0, counter);
    let status = battery_to_status(battery_percent);
    let payload = build_adv_payload(&pub_x, status);
    let addr = build_ble_address(&pub_x);
    (payload, addr, pub_x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_reconstruct_key_from_air_packet() {
        let priv_key = [0x11u8; 28];
        let sk0 = [0x22u8; 32];
        for counter in 0..4u32 {
            let (payload, addr, pub_x) = derive_advertisement(&priv_key, &sk0, counter, 95);
            assert_eq!(addr[5] & 0xC0, 0xC0, "static random address MSBs must be 0b11");
            assert_eq!(payload[0..6], [0x1e, 0xff, 0x4c, 0x00, 0x12, 0x19]);
            assert_eq!(payload[6], 0x10);
            let reconstructed = reconstruct_public_key_x(&addr, &payload);
            assert_eq!(reconstructed, pub_x, "counter {counter} key reconstruction mismatch");
        }
    }

    #[test]
    fn matches_python_findmy_reference_vectors() {
        let priv_key = [0x11u8; 28];
        let sk0 = [0x22u8; 32];
        // Generated via `tools/src/gps_tracker_tools/findmy.py` (`derive_key_at`, `ble_address_from_key`, `hashed_adv_key`)
        let expected_pub_x_hex = [
            "7b3e27529c226c17b019748b2aac9342663f5116de3002926a205ca9",
            "2c080f03d8786d27b84c8bb9fc49adc9ae3c16180ef7ad45ad02de00",
            "7cdbe427a5aee514e1c92ee29bfc01d03cca7f4aae3ba32aad10d307",
        ];
        // Python outputs big-endian AA:BB:CC:DD:EE:FF; BLE HCI / BdAddr is LSB-first [FF, EE, DD, CC, BB, AA]
        let expected_addr_lsb: [[u8; 6]; 3] = [
            [0x22, 0x9C, 0x52, 0x27, 0x3E, 0xFB], // FB:3E:27:52:9C:22
            [0x78, 0xD8, 0x03, 0x0F, 0x08, 0xEC], // EC:08:0F:03:D8:78
            [0xAE, 0xA5, 0x27, 0xE4, 0xDB, 0xFC], // FC:DB:E4:27:A5:AE
        ];

        for (counter, (&expected_hex, expected_addr)) in expected_pub_x_hex
            .iter()
            .zip(expected_addr_lsb.iter())
            .enumerate()
        {
            let (_, addr, pub_x) = derive_advertisement(&priv_key, &sk0, counter as u32, 95);
            let actual_hex: String = pub_x.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(actual_hex, expected_hex, "pub_x mismatch at counter {counter}");
            assert_eq!(&addr, expected_addr, "ble_addr mismatch at counter {counter}");
            let h = hashed_adv_key(&pub_x);
            assert_eq!(h.len(), 32);
        }
    }
}
