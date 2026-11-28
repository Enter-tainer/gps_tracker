//! Pure `no_std` integer math and prediction primitives shared by v1, v2, and streaming codecs.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CoordMode {
    Tn = 0,
    Naive = 1,
    TnClamped = 2,
    D1 = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AltMode {
    D1 = 1,
    Damped = 2,
}

pub const TN_CLAMP: i64 = 2;

#[inline]
pub fn mag3(e: i32) -> usize {
    let a = e.unsigned_abs();
    if a == 0 {
        0
    } else if a == 1 {
        1
    } else {
        2
    }
}

#[inline]
pub fn mag4(e: i32) -> usize {
    let a = e.unsigned_abs();
    if a == 0 {
        0
    } else if a == 1 {
        1
    } else if a <= 3 {
        2
    } else {
        3
    }
}

#[inline]
pub fn mag6(e: i32) -> usize {
    let a = e.unsigned_abs();
    if a == 0 {
        0
    } else if a == 1 {
        1
    } else if a <= 3 {
        2
    } else if a <= 7 {
        3
    } else if a <= 31 {
        4
    } else {
        5
    }
}

#[inline]
pub fn run_bucket4(run: u32) -> usize {
    if run == 0 {
        0
    } else if run == 1 {
        1
    } else if run <= 3 {
        2
    } else {
        3
    }
}

#[inline]
fn vmag_bucket_u64(a: u64) -> usize {
    if a == 0 {
        0
    } else if a <= 2 {
        1
    } else if a <= 8 {
        2
    } else if a <= 32 {
        3
    } else {
        4
    }
}

#[inline]
pub fn vmag_bucket(v: i32) -> usize {
    vmag_bucket_u64(v.unsigned_abs() as u64)
}

#[inline]
pub fn vel_step_bucket(v: i32, dt_prev: i32, pred_dt: i32) -> usize {
    let d0 = dt_prev as i64;
    let d1 = pred_dt as i64;
    let s = if d0 > 0 && d1 > 0 && d0 != d1 {
        round_div((v as i64) * d1.min(2 * d0), d0)
    } else {
        v as i64
    };
    vmag_bucket_u64(s.unsigned_abs())
}

#[inline]
pub fn accel_bucket3(v: i32, v2: i32) -> usize {
    let a = v.unsigned_abs();
    let b = v2.unsigned_abs();
    if a > b {
        2
    } else if a < b {
        0
    } else {
        1
    }
}

#[inline]
pub fn accel_growing(v: i32, v2: i32) -> usize {
    usize::from(v.unsigned_abs() > v2.unsigned_abs())
}

#[inline]
pub fn agree_bit(e_prev: i32, v_prev: i32) -> usize {
    usize::from(e_prev != 0 && v_prev != 0 && e_prev.signum() == v_prev.signum())
}

#[inline]
pub fn zigzag(e: i32) -> u32 {
    ((e << 1) ^ (e >> 31)) as u32
}

#[inline]
pub fn unzigzag(u: u32) -> i32 {
    ((u >> 1) as i32) ^ (-((u & 1) as i32))
}

#[inline]
pub fn q1(e: i32, levels: usize) -> usize {
    if e == 0 {
        return 0;
    }
    let a = e.unsigned_abs();
    let b = ((31 - a.leading_zeros()) as usize).min(levels - 1);
    1 + 2 * b + usize::from(e < 0)
}

#[inline]
pub fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

#[inline]
pub fn round_div(a: i64, b: i64) -> i64 {
    debug_assert!(b > 0);
    let half = b >> 1;
    if a >= 0 {
        (a + half) / b
    } else {
        -((-a + half) / b)
    }
}

/// Matches JS `Math.round(val / q)` for integer `val` and integer `q >= 1`
/// (ties `.5` round toward `+infinity`).
#[inline]
pub fn round_div_half_up_pos(val: i32, q: u32) -> i32 {
    let v = val as i64;
    let qq = q as i64;
    (2 * v + qq).div_euclid(2 * qq) as i32
}

#[inline]
pub fn dt_bucket(dt: i32, levels: usize) -> usize {
    if dt <= 0 {
        return 0;
    }
    if dt == 1 {
        return 1;
    }
    if levels <= 2 {
        return 2;
    }
    if dt == 2 {
        return 2;
    }
    if levels <= 3 {
        return 2;
    }
    if dt <= 5 {
        return 3;
    }
    if levels <= 4 {
        return 3;
    }
    if dt <= 15 {
        return 4;
    }
    levels - 1
}

#[inline]
pub fn predict_coord_v1(
    x_prev2: i32,
    x_prev: i32,
    dt_prev: i32,
    dt_cur: i32,
    coord_mode: u8,
) -> i64 {
    let xp2 = x_prev2 as i64;
    let xp = x_prev as i64;
    if coord_mode == CoordMode::Naive as u8 {
        return 2 * xp - xp2;
    }
    if dt_prev > 0 && dt_cur > 0 {
        if coord_mode != CoordMode::TnClamped as u8 && dt_cur == dt_prev {
            return 2 * xp - xp2;
        }
        let dp = dt_prev as i64;
        let dc = dt_cur as i64;
        let d = if coord_mode == CoordMode::TnClamped as u8 {
            dc.min(dp * TN_CLAMP)
        } else {
            dc
        };
        // Avoid 64-bit software division on Cortex-M when cadence is steady.
        if d == dp {
            return 2 * xp - xp2;
        }
        return xp + round_div((xp - xp2) * d, dp);
    }
    xp
}
