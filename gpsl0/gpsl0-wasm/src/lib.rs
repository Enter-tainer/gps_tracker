use core::ptr::NonNull;
use gpsl0_core::{
    decode, decode_window, encode, inspect_header, AltMode, CoordMode, DecodedTrack, EncodeOptions,
    Gpsl0Meta, QuantumSpec,
};

#[no_mangle]
pub extern "C" fn gpsl0_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return NonNull::<u8>::dangling().as_ptr();
    }
    let mut v = vec![0u8; size];
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn gpsl0_dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, size, size));
    }
}

#[no_mangle]
pub extern "C" fn gpsl0_free_result(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let len_bytes = core::slice::from_raw_parts(ptr, 4);
        let total = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
        if total >= 4 {
            drop(Vec::from_raw_parts(ptr, total, total));
        }
    }
}

fn make_result_buf(body_len: usize, fill: impl FnOnce(&mut [u8])) -> *mut u8 {
    let total = 4usize + body_len;
    let mut buf = vec![0u8; total];
    buf[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    fill(&mut buf[4..]);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

fn make_error_buf(msg: &str) -> *mut u8 {
    let bytes = msg.as_bytes();
    make_result_buf(8 + bytes.len(), |body| {
        body[0..4].copy_from_slice(&1u32.to_le_bytes());
        body[4..8].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
        body[8..8 + bytes.len()].copy_from_slice(bytes);
    })
}

#[inline]
fn write_u32(out: &mut [u8], off: usize, v: u32) {
    out[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

#[inline]
fn write_i32_slice(out: &mut [u8], off: usize, src: &[i32]) {
    let mut p = off;
    for &v in src {
        out[p..p + 4].copy_from_slice(&v.to_le_bytes());
        p += 4;
    }
}

fn pack_meta_and_track(meta: &Gpsl0Meta, track: Option<&DecodedTrack>) -> *mut u8 {
    let n_blocks = meta.block_index.len();
    let out_points = track.map_or(0usize, |tr| tr.t.len());
    // body: status(4) + meta(52) + block_index(n_blocks * 24) + 4 * out_points * 4
    let body_len = 4 + 52 + n_blocks * 24 + out_points * 16;
    make_result_buf(body_len, |body| {
        write_u32(body, 0, 0); // status = 0
        write_u32(body, 4, meta.version as u32);
        let mut flags_mode: u32 = 0;
        if meta.tier0 {
            flags_mode |= 1;
        }
        if meta.has_alt {
            flags_mode |= 2;
        }
        if meta.alt_damped {
            flags_mode |= 4;
        }
        flags_mode |= (meta.coord_mode as u32) << 8;
        write_u32(body, 8, flags_mode);
        write_u32(body, 12, meta.coord_quantum);
        write_u32(body, 16, meta.alt_quantum);
        write_u32(body, 20, meta.n_points);
        write_u32(body, 24, meta.block_points);
        write_u32(body, 28, meta.sync_blocks);
        write_u32(body, 32, meta.n_blocks);
        write_u32(body, 36, meta.model_id);
        write_u32(body, 40, meta.header_crc32);
        write_u32(body, 44, meta.index_crc32);
        write_u32(body, 48, meta.byte_length as u32);
        write_u32(body, 52, out_points as u32);

        let mut off = 56;
        for b in &meta.block_index {
            write_u32(body, off, b.start_ts);
            write_u32(body, off + 4, b.end_ts);
            write_u32(body, off + 8, b.point_count);
            write_u32(body, off + 12, b.byte_offset);
            write_u32(body, off + 16, b.byte_length);
            write_u32(body, off + 20, b.crc32);
            off += 24;
        }
        if let Some(tr) = track {
            write_i32_slice(body, off, &tr.t);
            off += out_points * 4;
            write_i32_slice(body, off, &tr.lat);
            off += out_points * 4;
            write_i32_slice(body, off, &tr.lon);
            off += out_points * 4;
            write_i32_slice(body, off, &tr.alt);
        }
    })
}

#[no_mangle]
pub extern "C" fn gpsl0_encode(
    t_ptr: *const i32,
    lat_ptr: *const i32,
    lon_ptr: *const i32,
    alt_ptr: *const i32,
    n_points: u32,
    version: u32,
    model_id: u32,
    coord_quantum: u32,
    alt_quantum: u32,
    block_points: u32,
    sync_blocks: u32,
    alt_mode: u32,
    coord_mode: u32,
) -> *mut u8 {
    let n = n_points as usize;
    let (t, lat, lon, alt) = if n == 0 {
        (&[][..], &[][..], &[][..], &[][..])
    } else {
        if t_ptr.is_null() || lat_ptr.is_null() || lon_ptr.is_null() || alt_ptr.is_null() {
            return make_error_buf("GPSL0: null input pointer");
        }
        unsafe {
            (
                core::slice::from_raw_parts(t_ptr, n),
                core::slice::from_raw_parts(lat_ptr, n),
                core::slice::from_raw_parts(lon_ptr, n),
                core::slice::from_raw_parts(alt_ptr, n),
            )
        }
    };

    let ver = if version == 0 { 2 } else { version as u16 };
    let mid = if model_id == 0 { None } else { Some(model_id) };
    let cq = if coord_quantum == 0 {
        QuantumSpec::Auto
    } else {
        QuantumSpec::Fixed(coord_quantum)
    };
    let aq = if alt_quantum == 0 {
        QuantumSpec::Auto
    } else {
        QuantumSpec::Fixed(alt_quantum)
    };
    let bp = if block_points == 0 {
        None
    } else {
        Some(block_points)
    };
    let am = match alt_mode {
        0 => None,
        1 => Some(AltMode::D1),
        2 => Some(AltMode::Damped),
        other => return make_error_buf(&format!("GPSL0: bad altMode {other}")),
    };
    let cm = match coord_mode {
        255 => None,
        0 => Some(CoordMode::Tn),
        1 => Some(CoordMode::Naive),
        2 => Some(CoordMode::TnClamped),
        3 => Some(CoordMode::D1),
        other => return make_error_buf(&format!("GPSL0: unknown coordPredictor {other}")),
    };

    let opts = EncodeOptions {
        version: ver,
        model_id: mid,
        coord_quantum: cq,
        alt_quantum: aq,
        block_points: bp,
        sync_blocks,
        alt_mode: am,
        coord_mode: cm,
    };

    match encode(t, lat, lon, alt, &opts) {
        Ok(bytes) => make_result_buf(8 + bytes.len(), |body| {
            write_u32(body, 0, 0);
            write_u32(body, 4, bytes.len() as u32);
            body[8..8 + bytes.len()].copy_from_slice(&bytes);
        }),
        Err(e) => make_error_buf(&e.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn gpsl0_decode(bytes_ptr: *const u8, bytes_len: u32) -> *mut u8 {
    let bytes = if bytes_len == 0 {
        &[][..]
    } else if bytes_ptr.is_null() {
        return make_error_buf("GPSL0: null bytes pointer");
    } else {
        unsafe { core::slice::from_raw_parts(bytes_ptr, bytes_len as usize) }
    };
    match decode(bytes) {
        Ok(tr) => pack_meta_and_track(&tr.meta, Some(&tr)),
        Err(e) => make_error_buf(&e.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn gpsl0_decode_window(
    bytes_ptr: *const u8,
    bytes_len: u32,
    start_point: u32,
    len: u32,
) -> *mut u8 {
    let bytes = if bytes_len == 0 {
        &[][..]
    } else if bytes_ptr.is_null() {
        return make_error_buf("GPSL0: null bytes pointer");
    } else {
        unsafe { core::slice::from_raw_parts(bytes_ptr, bytes_len as usize) }
    };
    match decode_window(bytes, start_point as usize, len as usize) {
        Ok(tr) => pack_meta_and_track(&tr.meta, Some(&tr)),
        Err(e) => make_error_buf(&e.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn gpsl0_inspect_header(bytes_ptr: *const u8, bytes_len: u32) -> *mut u8 {
    let bytes = if bytes_len == 0 {
        &[][..]
    } else if bytes_ptr.is_null() {
        return make_error_buf("GPSL0: null bytes pointer");
    } else {
        unsafe { core::slice::from_raw_parts(bytes_ptr, bytes_len as usize) }
    };
    match inspect_header(bytes) {
        Ok(meta) => pack_meta_and_track(&meta, None),
        Err(e) => make_error_buf(&e.to_string()),
    }
}
