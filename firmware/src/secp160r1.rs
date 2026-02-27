//! Pure Rust implementation of the SECP160R1 elliptic curve.
//!
//! Provides 160-bit modular arithmetic and Weierstrass curve point operations
//! for computing FMDN Ephemeral Identifiers (EIDs).
//!
//! # Curve parameters (SEC 2)
//!
//! - p = 0xFFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF 7FFFFFFF
//! - a = 0xFFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF 7FFFFFFC
//! - b = 0x1C97BEFC 54BD7A8B 65ACF89F 81D4D4AD C565FA45
//! - G = (0x4A96B568 8EF57328 4664698968C38BB9 13CBFC82,
//!        0x23A62855 3168947D 59DCC912 04235137 7AC5FB32)
//! - n = 0x01000000 00000000 00000001 F4C8F927 AED3CA75 2257
//! - h = 1
//!
//! All arithmetic is `no_std` with zero external dependencies.

/// 160-bit unsigned integer stored as 5 × 32-bit limbs in little-endian order.
/// `limbs[0]` is the least significant word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U160 {
    pub limbs: [u32; 5],
}

/// 192-bit unsigned integer for the curve order `n` (which is 161 bits).
/// Stored as 6 × 32-bit limbs in little-endian order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U192 {
    pub limbs: [u32; 6],
}

/// A point on the SECP160R1 curve in projective (Jacobian) coordinates.
///
/// The affine point (x, y) is represented as (X, Y, Z) where:
///   x = X / Z²
///   y = Y / Z³
///
/// The point at infinity is represented by Z = 0.
#[derive(Clone, Copy, Debug)]
pub struct ProjectivePoint {
    pub x: U160,
    pub y: U160,
    pub z: U160,
}

/// An affine point (x, y) on the curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AffinePoint {
    pub x: U160,
    pub y: U160,
}

// ============================================================================
// Curve constants
// ============================================================================

/// Field prime p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFF
pub const P: U160 = U160::from_be_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFF");

/// Curve parameter a = p - 3
pub const A: U160 = U160::from_be_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFC");

/// Curve parameter b
pub const B: U160 = U160::from_be_hex("1C97BEFC54BD7A8B65ACF89F81D4D4ADC565FA45");

/// Generator x-coordinate
pub const GX: U160 = U160::from_be_hex("4A96B5688EF573284664698968C38BB913CBFC82");

/// Generator y-coordinate
pub const GY: U160 = U160::from_be_hex("23A628553168947D59DCC912042351377AC5FB32");

/// Curve order n = 0x0100000000000000000001F4C8F927AED3CA752257
pub const N: U192 = U192::from_be_hex("0100000000000000000001F4C8F927AED3CA752257");

/// Generator point in affine coordinates.
pub const GENERATOR_AFFINE: AffinePoint = AffinePoint { x: GX, y: GY };

// ============================================================================
// U160 implementation
// ============================================================================

impl U160 {
    pub const ZERO: U160 = U160 { limbs: [0; 5] };
    pub const ONE: U160 = U160 {
        limbs: [1, 0, 0, 0, 0],
    };

    /// Parse a 40-character big-endian hex string at compile time.
    pub const fn from_be_hex(hex: &str) -> Self {
        let bytes = hex.as_bytes();
        assert!(bytes.len() == 40, "hex string must be 40 chars");
        let mut limbs = [0u32; 5];
        // Parse from most significant to least significant
        let mut i = 0;
        while i < 5 {
            let limb_idx = 4 - i; // big-endian: first 8 chars = most significant limb
            let offset = i * 8;
            limbs[limb_idx] = parse_hex_u32(bytes, offset);
            i += 1;
        }
        U160 { limbs }
    }

    /// Create from a 20-byte big-endian array.
    pub fn from_be_bytes(bytes: &[u8; 20]) -> Self {
        let mut limbs = [0u32; 5];
        // bytes[0..4] is most significant
        limbs[4] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        limbs[3] = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        limbs[2] = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        limbs[1] = u32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
        limbs[0] = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        U160 { limbs }
    }

    /// Serialize to a 20-byte big-endian array.
    pub fn to_be_bytes(&self) -> [u8; 20] {
        let mut out = [0u8; 20];
        let b4 = self.limbs[4].to_be_bytes();
        let b3 = self.limbs[3].to_be_bytes();
        let b2 = self.limbs[2].to_be_bytes();
        let b1 = self.limbs[1].to_be_bytes();
        let b0 = self.limbs[0].to_be_bytes();
        out[0..4].copy_from_slice(&b4);
        out[4..8].copy_from_slice(&b3);
        out[8..12].copy_from_slice(&b2);
        out[12..16].copy_from_slice(&b1);
        out[16..20].copy_from_slice(&b0);
        out
    }

    /// Returns true if this value is zero.
    pub fn is_zero(&self) -> bool {
        self.limbs[0] == 0
            && self.limbs[1] == 0
            && self.limbs[2] == 0
            && self.limbs[3] == 0
            && self.limbs[4] == 0
    }

    /// Compare: returns true if self >= other.
    fn gte(&self, other: &U160) -> bool {
        let mut i = 4;
        loop {
            if self.limbs[i] > other.limbs[i] {
                return true;
            }
            if self.limbs[i] < other.limbs[i] {
                return false;
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
        true // equal
    }

    /// Addition with carry, returning (result, carry).
    fn add_with_carry(&self, other: &U160) -> (U160, bool) {
        let mut result = U160::ZERO;
        let mut carry = 0u64;
        for i in 0..5 {
            let sum = self.limbs[i] as u64 + other.limbs[i] as u64 + carry;
            result.limbs[i] = sum as u32;
            carry = sum >> 32;
        }
        (result, carry != 0)
    }

    /// Subtraction with borrow, returning (result, borrow).
    fn sub_with_borrow(&self, other: &U160) -> (U160, bool) {
        let mut result = U160::ZERO;
        let mut borrow = 0i64;
        for i in 0..5 {
            let diff = self.limbs[i] as i64 - other.limbs[i] as i64 - borrow;
            if diff < 0 {
                result.limbs[i] = (diff + (1i64 << 32)) as u32;
                borrow = 1;
            } else {
                result.limbs[i] = diff as u32;
                borrow = 0;
            }
        }
        (result, borrow != 0)
    }
}

// ============================================================================
// U192 implementation
// ============================================================================

impl U192 {
    pub const ZERO: U192 = U192 { limbs: [0; 6] };

    /// Parse a big-endian hex string (up to 48 chars, left-padded with zeros).
    pub const fn from_be_hex(hex: &str) -> Self {
        let bytes = hex.as_bytes();
        let len = bytes.len();
        // Pad to 48 characters
        let mut padded = [b'0'; 48];
        let start = 48 - len;
        let mut i = 0;
        while i < len {
            padded[start + i] = bytes[i];
            i += 1;
        }
        let mut limbs = [0u32; 6];
        i = 0;
        while i < 6 {
            let limb_idx = 5 - i;
            let offset = i * 8;
            limbs[limb_idx] = parse_hex_u32(&padded, offset);
            i += 1;
        }
        U192 { limbs }
    }

    /// Create from a 32-byte big-endian array (AES output), taking lowest 24 bytes.
    /// The full 256-bit value is reduced mod n.
    pub fn from_be_bytes_32(bytes: &[u8; 32]) -> Self {
        // Convert full 256 bits into a wider representation, then reduce mod n.
        // We'll use schoolbook reduction.
        reduce_256_mod_n(bytes)
    }

    pub fn is_zero(&self) -> bool {
        self.limbs[0] == 0
            && self.limbs[1] == 0
            && self.limbs[2] == 0
            && self.limbs[3] == 0
            && self.limbs[4] == 0
            && self.limbs[5] == 0
    }

    fn gte(&self, other: &U192) -> bool {
        let mut i = 5;
        loop {
            if self.limbs[i] > other.limbs[i] {
                return true;
            }
            if self.limbs[i] < other.limbs[i] {
                return false;
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
        true
    }

    fn sub_with_borrow(&self, other: &U192) -> (U192, bool) {
        let mut result = U192::ZERO;
        let mut borrow = 0i64;
        for i in 0..6 {
            let diff = self.limbs[i] as i64 - other.limbs[i] as i64 - borrow;
            if diff < 0 {
                result.limbs[i] = (diff + (1i64 << 32)) as u32;
                borrow = 1;
            } else {
                result.limbs[i] = diff as u32;
                borrow = 0;
            }
        }
        (result, borrow != 0)
    }

    /// Get bit at position `bit` (0 = LSB).
    pub fn bit(&self, bit: usize) -> bool {
        let word = bit / 32;
        let offset = bit % 32;
        if word >= 6 {
            return false;
        }
        (self.limbs[word] >> offset) & 1 == 1
    }

    /// Returns the position of the highest set bit (0-indexed), or None if zero.
    pub fn bit_length(&self) -> Option<usize> {
        for i in (0..6).rev() {
            if self.limbs[i] != 0 {
                return Some(i * 32 + (31 - self.limbs[i].leading_zeros() as usize));
            }
        }
        None
    }

    /// Convert to U160 (truncate upper limb). Caller must ensure value fits.
    pub fn to_u160(&self) -> U160 {
        U160 {
            limbs: [
                self.limbs[0],
                self.limbs[1],
                self.limbs[2],
                self.limbs[3],
                self.limbs[4],
            ],
        }
    }

    /// Encode as big-endian bytes, right-aligned in a buffer of `len` bytes.
    /// For FMDN hashed flags, we need r as big-endian bytes.
    pub fn to_be_bytes_padded(&self, buf: &mut [u8]) {
        let full = [
            self.limbs[5].to_be_bytes(),
            self.limbs[4].to_be_bytes(),
            self.limbs[3].to_be_bytes(),
            self.limbs[2].to_be_bytes(),
            self.limbs[1].to_be_bytes(),
            self.limbs[0].to_be_bytes(),
        ];
        // Flatten 24 bytes
        let mut flat = [0u8; 24];
        for (i, chunk) in full.iter().enumerate() {
            flat[i * 4..(i + 1) * 4].copy_from_slice(chunk);
        }
        // Copy right-aligned into output buffer
        let src_start = if flat.len() > buf.len() {
            flat.len() - buf.len()
        } else {
            0
        };
        let dst_start = if buf.len() > flat.len() {
            buf.len() - flat.len()
        } else {
            0
        };
        // Zero-fill leading
        for b in buf[..dst_start].iter_mut() {
            *b = 0;
        }
        buf[dst_start..].copy_from_slice(&flat[src_start..]);
    }
}

// ============================================================================
// Modular arithmetic over F_p (160-bit prime field)
// ============================================================================

/// Modular addition: (a + b) mod p
fn fp_add(a: &U160, b: &U160) -> U160 {
    let (sum, carry) = a.add_with_carry(b);
    if carry || sum.gte(&P) {
        let (result, _) = sum.sub_with_borrow(&P);
        result
    } else {
        sum
    }
}

/// Modular subtraction: (a - b) mod p
fn fp_sub(a: &U160, b: &U160) -> U160 {
    let (diff, borrow) = a.sub_with_borrow(b);
    if borrow {
        let (result, _) = diff.add_with_carry(&P);
        result
    } else {
        diff
    }
}

/// Modular multiplication: (a * b) mod p
///
/// Uses schoolbook multiplication to a 320-bit product, then Barrett-like reduction.
fn fp_mul(a: &U160, b: &U160) -> U160 {
    // Compute full 320-bit product in 10 limbs
    let mut product = [0u64; 10];
    for i in 0..5 {
        let mut carry = 0u64;
        for j in 0..5 {
            let v = product[i + j] + (a.limbs[i] as u64) * (b.limbs[j] as u64) + carry;
            product[i + j] = v & 0xFFFF_FFFF;
            carry = v >> 32;
        }
        product[i + 5] = carry;
    }

    reduce_320_mod_p(&product)
}

/// Modular squaring: a² mod p (uses generic mul for simplicity)
fn fp_sqr(a: &U160) -> U160 {
    fp_mul(a, a)
}

/// Reduce a 320-bit product modulo p.
///
/// p = 2^160 - (2^31 + 1), so 2^160 ≡ 2^31 + 1 = 0x80000001 (mod p).
///
/// For V = V_hi * 2^160 + V_lo:
///   V ≡ V_lo + V_hi * 0x80000001 (mod p)
///
/// We iterate since V_hi * 0x80000001 may still exceed 160 bits.
fn reduce_320_mod_p(product: &[u64; 10]) -> U160 {
    // Wide accumulator: 7 limbs to hold lo (5) + hi*c (up to 6)
    let mut acc = [0u64; 7];

    // Initialize with lo part
    for i in 0..5 {
        acc[i] = product[i];
    }

    // Add hi * 0x80000001 using scalar multiplication
    let c: u64 = 0x8000_0001;
    let mut carry = 0u64;
    for i in 0..5 {
        let v = acc[i] + product[i + 5] * c + carry;
        acc[i] = v & 0xFFFF_FFFF;
        carry = v >> 32;
    }
    acc[5] = carry;

    // Second reduction pass if needed (acc might be > 160 bits)
    loop {
        if acc[5] == 0 && acc[6] == 0 {
            break;
        }

        let mut new_acc = [0u64; 7];
        for i in 0..5 {
            new_acc[i] = acc[i];
        }

        carry = 0;
        for i in 0..2 {
            let v = new_acc[i] + acc[i + 5] * c + carry;
            new_acc[i] = v & 0xFFFF_FFFF;
            carry = v >> 32;
        }
        for i in 2..5 {
            let v = new_acc[i] + carry;
            new_acc[i] = v & 0xFFFF_FFFF;
            carry = v >> 32;
        }
        new_acc[5] = carry;
        new_acc[6] = 0;

        acc = new_acc;
    }

    let mut r = U160 {
        limbs: [
            acc[0] as u32,
            acc[1] as u32,
            acc[2] as u32,
            acc[3] as u32,
            acc[4] as u32,
        ],
    };

    while r.gte(&P) {
        let (sub, _) = r.sub_with_borrow(&P);
        r = sub;
    }

    r
}

/// Modular inversion using Fermat's little theorem: a^(-1) = a^(p-2) mod p
fn fp_inv(a: &U160) -> U160 {
    // p - 2 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFD
    let exp = U160::from_be_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFD");
    fp_pow(a, &exp)
}

/// Modular exponentiation via square-and-multiply.
fn fp_pow(base: &U160, exp: &U160) -> U160 {
    let mut result = U160::ONE;
    // Find highest set bit
    let mut top_bit = None;
    for i in (0..5).rev() {
        if exp.limbs[i] != 0 {
            top_bit = Some(i * 32 + (31 - exp.limbs[i].leading_zeros() as usize));
            break;
        }
    }
    let top_bit = match top_bit {
        Some(b) => b,
        None => return U160::ONE,
    };

    for i in (0..=top_bit).rev() {
        result = fp_sqr(&result);
        let word = i / 32;
        let bit = i % 32;
        if (exp.limbs[word] >> bit) & 1 == 1 {
            result = fp_mul(&result, base);
        }
    }
    result
}

// ============================================================================
// Reduction of 256-bit AES output mod n (curve order)
// ============================================================================

/// Reduce a 256-bit big-endian value mod n.
///
/// n is 161 bits, so we need multi-precision division.
/// We use simple repeated subtraction with shifting for embedded use.
fn reduce_256_mod_n(bytes: &[u8; 32]) -> U192 {
    // Convert 32 bytes (256 bits) into 8 × 32-bit limbs (little-endian)
    let mut val = [0u32; 8];
    for i in 0..8 {
        let offset = 28 - i * 4;
        val[i] = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
    }

    // Simple: compute val mod n using schoolbook long division
    // Since n is 161 bits and val is 256 bits, we need at most ~95 bit shifts.
    // For embedded simplicity, we use subtract-and-shift.

    // Convert n to 8 limbs for matching width
    let n8: [u32; 8] = [
        N.limbs[0], N.limbs[1], N.limbs[2], N.limbs[3], N.limbs[4], N.limbs[5], 0, 0,
    ];

    // Find highest bit of val
    let val_bits = {
        let mut b = 0;
        for i in (0..8).rev() {
            if val[i] != 0 {
                b = i * 32 + (32 - val[i].leading_zeros() as usize);
                break;
            }
        }
        b
    };

    let n_bits = 161; // n is 161 bits

    if val_bits <= n_bits {
        // Already fits, just check >= n
        let mut v = U192 {
            limbs: [val[0], val[1], val[2], val[3], val[4], val[5]],
        };
        while v.gte(&N) {
            let (r, _) = v.sub_with_borrow(&N);
            v = r;
        }
        return v;
    }

    // Shift n left to align with val, then subtract
    let shift = val_bits - n_bits;

    for bit in (0..=shift).rev() {
        // Compute n << bit in 8-limb form
        let mut n_shifted = [0u32; 8];
        let word_shift = bit / 32;
        let bit_shift = bit % 32;
        for i in 0..8usize {
            if i >= word_shift {
                let src = i - word_shift;
                n_shifted[i] = n8[src] << bit_shift;
                if bit_shift > 0 && src > 0 {
                    n_shifted[i] |= n8[src - 1] >> (32 - bit_shift);
                }
            }
        }

        // If val >= n_shifted, subtract
        let mut ge = true;
        for i in (0..8).rev() {
            if val[i] > n_shifted[i] {
                break;
            }
            if val[i] < n_shifted[i] {
                ge = false;
                break;
            }
        }

        if ge {
            let mut borrow = 0i64;
            for i in 0..8 {
                let diff = val[i] as i64 - n_shifted[i] as i64 - borrow;
                if diff < 0 {
                    val[i] = (diff + (1i64 << 32)) as u32;
                    borrow = 1;
                } else {
                    val[i] = diff as u32;
                    borrow = 0;
                }
            }
        }
    }

    U192 {
        limbs: [val[0], val[1], val[2], val[3], val[4], val[5]],
    }
}

// ============================================================================
// Projective point operations (Jacobian coordinates)
// ============================================================================

impl ProjectivePoint {
    /// The point at infinity.
    pub const IDENTITY: Self = ProjectivePoint {
        x: U160::ONE,
        y: U160::ONE,
        z: U160::ZERO,
    };

    /// The generator point.
    pub const GENERATOR: Self = ProjectivePoint {
        x: GX,
        y: GY,
        z: U160::ONE,
    };

    pub fn is_identity(&self) -> bool {
        self.z.is_zero()
    }

    /// Convert projective to affine coordinates.
    ///
    /// Returns `None` if this is the point at infinity.
    pub fn to_affine(&self) -> Option<AffinePoint> {
        if self.is_identity() {
            return None;
        }
        let z_inv = fp_inv(&self.z);
        let z_inv2 = fp_sqr(&z_inv);
        let z_inv3 = fp_mul(&z_inv2, &z_inv);
        let x = fp_mul(&self.x, &z_inv2);
        let y = fp_mul(&self.y, &z_inv3);
        Some(AffinePoint { x, y })
    }

    /// Point doubling in Jacobian coordinates.
    ///
    /// Uses the standard formula for curves where a = -3 (which is the case
    /// for SECP160R1: a = p - 3).
    pub fn double(&self) -> Self {
        if self.is_identity() {
            return *self;
        }

        // For a = -3 (our case since a = p - 3):
        // M = 3 * (X - Z²)(X + Z²)
        // S = 4 * X * Y²
        // X' = M² - 2*S
        // Y' = M * (S - X') - 8 * Y⁴
        // Z' = 2 * Y * Z

        let z2 = fp_sqr(&self.z);
        let x_sub_z2 = fp_sub(&self.x, &z2);
        let x_add_z2 = fp_add(&self.x, &z2);
        let m3 = fp_mul(&x_sub_z2, &x_add_z2); // (X-Z²)(X+Z²)
        let m = fp_add(&fp_add(&m3, &m3), &m3); // 3 * (X-Z²)(X+Z²)

        let y2 = fp_sqr(&self.y);
        let s = fp_mul(&self.x, &y2);
        let s4 = fp_add(&fp_add(&s, &s), &fp_add(&s, &s)); // 4 * X * Y²

        let m2 = fp_sqr(&m);
        let x_new = fp_sub(&m2, &fp_add(&s4, &s4)); // M² - 2*S

        let y4 = fp_sqr(&y2);
        let y4_8 = {
            let y4_2 = fp_add(&y4, &y4);
            let y4_4 = fp_add(&y4_2, &y4_2);
            fp_add(&y4_4, &y4_4)
        };
        let s4_sub_x = fp_sub(&s4, &x_new);
        let y_new = fp_sub(&fp_mul(&m, &s4_sub_x), &y4_8);

        let z_new = fp_mul(&self.y, &self.z);
        let z_new = fp_add(&z_new, &z_new); // 2 * Y * Z

        ProjectivePoint {
            x: x_new,
            y: y_new,
            z: z_new,
        }
    }

    /// Point addition in Jacobian coordinates (mixed: self is projective, other is affine).
    pub fn add_affine(&self, other: &AffinePoint) -> Self {
        if self.is_identity() {
            return ProjectivePoint {
                x: other.x,
                y: other.y,
                z: U160::ONE,
            };
        }

        // U1 = X1, U2 = X2 * Z1², S1 = Y1, S2 = Y2 * Z1³
        let z1_sqr = fp_sqr(&self.z);
        let z1_cub = fp_mul(&z1_sqr, &self.z);
        let u2 = fp_mul(&other.x, &z1_sqr);
        let s2 = fp_mul(&other.y, &z1_cub);

        let h = fp_sub(&u2, &self.x);
        let r = fp_sub(&s2, &self.y);

        if h.is_zero() {
            if r.is_zero() {
                // Same point: double
                return self.double();
            }
            // Point and its inverse: return identity
            return Self::IDENTITY;
        }

        let h2 = fp_sqr(&h);
        let h3 = fp_mul(&h2, &h);

        let u1_h2 = fp_mul(&self.x, &h2);

        let x3 = fp_sub(&fp_sub(&fp_sqr(&r), &h3), &fp_add(&u1_h2, &u1_h2));
        let y3 = fp_sub(&fp_mul(&r, &fp_sub(&u1_h2, &x3)), &fp_mul(&self.y, &h3));
        let z3 = fp_mul(&self.z, &h);

        ProjectivePoint {
            x: x3,
            y: y3,
            z: z3,
        }
    }
}

// ============================================================================
// Scalar multiplication
// ============================================================================

/// Compute `scalar * G` where G is the generator point.
///
/// Uses double-and-add (left-to-right) with mixed affine addition.
pub fn scalar_mul_generator(scalar: &U192) -> ProjectivePoint {
    if scalar.is_zero() {
        return ProjectivePoint::IDENTITY;
    }

    let top = match scalar.bit_length() {
        Some(b) => b,
        None => return ProjectivePoint::IDENTITY,
    };

    let mut result = ProjectivePoint::IDENTITY;
    for i in (0..=top).rev() {
        result = result.double();
        if scalar.bit(i) {
            result = result.add_affine(&GENERATOR_AFFINE);
        }
    }

    result
}

// ============================================================================
// Compile-time hex parsing helpers
// ============================================================================

const fn hex_digit(c: u8) -> u32 {
    match c {
        b'0'..=b'9' => (c - b'0') as u32,
        b'a'..=b'f' => (c - b'a' + 10) as u32,
        b'A'..=b'F' => (c - b'A' + 10) as u32,
        _ => panic!("invalid hex digit"),
    }
}

const fn parse_hex_u32(bytes: &[u8], offset: usize) -> u32 {
    let mut val = 0u32;
    let mut i = 0;
    while i < 8 {
        val = (val << 4) | hex_digit(bytes[offset + i]);
        i += 1;
    }
    val
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_u160_from_be_hex() {
        let v = U160::from_be_hex("0000000000000000000000000000000000000001");
        assert_eq!(v, U160::ONE);

        let v = U160::from_be_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFF");
        assert_eq!(v, P);
    }

    #[test]
    fn test_u160_be_bytes_roundtrip() {
        let bytes = GX.to_be_bytes();
        let reconstructed = U160::from_be_bytes(&bytes);
        assert_eq!(reconstructed, GX);
    }

    #[test]
    fn test_generator_on_curve() {
        // Verify y² = x³ + ax + b (mod p)
        let x = GX;
        let y = GY;
        let y2 = fp_sqr(&y);
        let x2 = fp_sqr(&x);
        let x3 = fp_mul(&x2, &x);
        let ax = fp_mul(&A, &x);
        let rhs = fp_add(&fp_add(&x3, &ax), &B);
        assert_eq!(y2, rhs, "Generator G must be on the curve");
    }

    #[test]
    fn test_scalar_mul_1g() {
        // 1 * G = G
        let scalar = U192 {
            limbs: [1, 0, 0, 0, 0, 0],
        };
        let result = scalar_mul_generator(&scalar);
        let affine = result.to_affine().unwrap();
        assert_eq!(affine.x, GX);
        assert_eq!(affine.y, GY);
    }

    #[test]
    fn test_scalar_mul_2g() {
        // 2 * G
        let scalar = U192 {
            limbs: [2, 0, 0, 0, 0, 0],
        };
        let result = scalar_mul_generator(&scalar);
        let affine = result.to_affine().unwrap();
        let expected_x = U160::from_be_hex("02F997F33C5ED04C55D3EDF8675D3E92E8F46686");
        let expected_y = U160::from_be_hex("F083A323482993E9440E817E21CFB7737DF8797B");
        assert_eq!(affine.x, expected_x, "2*G x-coordinate mismatch");
        assert_eq!(affine.y, expected_y, "2*G y-coordinate mismatch");
    }

    #[test]
    fn test_scalar_mul_3g() {
        // 3 * G
        let scalar = U192 {
            limbs: [3, 0, 0, 0, 0, 0],
        };
        let result = scalar_mul_generator(&scalar);
        let affine = result.to_affine().unwrap();
        let expected_x = U160::from_be_hex("7B76FF541EF363F2DF13DE1650BD48DAA958BC59");
        let expected_y = U160::from_be_hex("C915CA790D8C8877B55BE0079D12854FFE9F6F5A");
        assert_eq!(affine.x, expected_x, "3*G x-coordinate mismatch");
        assert_eq!(affine.y, expected_y, "3*G y-coordinate mismatch");
    }

    #[test]
    fn test_scalar_mul_7g() {
        // 7 * G
        let scalar = U192 {
            limbs: [7, 0, 0, 0, 0, 0],
        };
        let result = scalar_mul_generator(&scalar);
        let affine = result.to_affine().unwrap();
        let expected_x = U160::from_be_hex("7A7F99D56472F619577C4E8C9B3A35E961472188");
        let expected_y = U160::from_be_hex("8955C17A4AA7B3CA673C6D55EE00FAE62552E356");
        assert_eq!(affine.x, expected_x, "7*G x-coordinate mismatch");
        assert_eq!(affine.y, expected_y, "7*G y-coordinate mismatch");
    }

    #[test]
    fn test_scalar_mul_n_minus_1() {
        // (n-1) * G should have same x as G but negated y (i.e., y = p - Gy)
        let n_minus_1 = U192 {
            limbs: [
                N.limbs[0].wrapping_sub(1),
                N.limbs[1],
                N.limbs[2],
                N.limbs[3],
                N.limbs[4],
                N.limbs[5],
            ],
        };
        // Handle borrow from limb 0
        let n_minus_1 = if N.limbs[0] == 0 {
            // Need to propagate borrow — but n.limbs[0] = 0x52257 != 0, so no issue
            n_minus_1
        } else {
            n_minus_1
        };
        let result = scalar_mul_generator(&n_minus_1);
        let affine = result.to_affine().unwrap();
        assert_eq!(affine.x, GX, "(n-1)*G x should equal Gx");
        let expected_y = U160::from_be_hex("DC59D7AACE976B82A62336EDFBDCAEC8053A04CD");
        assert_eq!(affine.y, expected_y, "(n-1)*G y should equal p - Gy");
    }

    #[test]
    fn test_scalar_mul_large() {
        // Test with a larger scalar: 0xAA55AA55AA55AA55AA55
        let scalar = U192 {
            limbs: [0xAA55AA55, 0xAA55AA55, 0x0000AA55, 0, 0, 0],
        };
        let result = scalar_mul_generator(&scalar);
        let affine = result.to_affine().unwrap();
        let expected_x = U160::from_be_hex("4A186ECC7AD21B80FAEEDD30E2C8B8840BCD0F04");
        let expected_y = U160::from_be_hex("398321CA04D2C106ACAE698477661F8FE54F312A");
        assert_eq!(affine.x, expected_x, "large scalar x mismatch");
        assert_eq!(affine.y, expected_y, "large scalar y mismatch");
    }

    #[test]
    fn test_scalar_mul_ng_is_identity() {
        // n * G should be the point at infinity
        let result = scalar_mul_generator(&N);
        assert!(result.is_identity(), "n*G must be the point at infinity");
    }

    #[test]
    fn test_point_double_equals_add() {
        // 2*G via doubling should equal G + G via addition
        let g_proj = ProjectivePoint::GENERATOR;
        let doubled = g_proj.double();
        let added = g_proj.add_affine(&GENERATOR_AFFINE);

        let d_affine = doubled.to_affine().unwrap();
        let a_affine = added.to_affine().unwrap();
        assert_eq!(d_affine.x, a_affine.x, "double vs add: x mismatch");
        assert_eq!(d_affine.y, a_affine.y, "double vs add: y mismatch");
    }

    #[test]
    fn test_fp_add_sub_inverse() {
        let a = GX;
        let b = GY;
        let sum = fp_add(&a, &b);
        let diff = fp_sub(&sum, &b);
        assert_eq!(diff, a, "a + b - b should equal a");
    }

    #[test]
    fn test_fp_mul_identity() {
        let result = fp_mul(&GX, &U160::ONE);
        assert_eq!(result, GX, "x * 1 should equal x");
    }

    #[test]
    fn test_fp_inv() {
        let inv = fp_inv(&GX);
        let product = fp_mul(&GX, &inv);
        assert_eq!(product, U160::ONE, "x * x^(-1) should equal 1");
    }

    #[test]
    fn test_reduce_256_mod_n() {
        // Test: a 256-bit value that is exactly n should reduce to 0
        let mut bytes = [0u8; 32];
        // n = 0x0100000000000000000001F4C8F927AED3CA752257
        // In 32 bytes (right-aligned):
        // bytes[11..32] = n (21 bytes)
        bytes[11] = 0x01;
        // bytes[12..16] = 0x00000000
        // bytes[16..20] = 0x00000000
        bytes[20] = 0x00;
        bytes[21] = 0x01;
        bytes[22] = 0xF4;
        bytes[23] = 0xC8;
        bytes[24] = 0xF9;
        bytes[25] = 0x27;
        bytes[26] = 0xAE;
        bytes[27] = 0xD3;
        bytes[28] = 0xCA;
        bytes[29] = 0x75;
        bytes[30] = 0x22;
        bytes[31] = 0x57;
        let result = U192::from_be_bytes_32(&bytes);
        assert!(result.is_zero(), "n mod n should be 0");
    }

    #[test]
    fn test_reduce_256_small_value() {
        // Small value (42) should stay as-is
        let mut bytes = [0u8; 32];
        bytes[31] = 42;
        let result = U192::from_be_bytes_32(&bytes);
        assert_eq!(result.limbs[0], 42);
        assert_eq!(result.limbs[1], 0);
    }
}
