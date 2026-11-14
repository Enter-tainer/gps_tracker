// GPSL0 benchmark dataset loader.
//
// Loads the 123 real tracks in frontend/local-data/r2/tracks/*.gpz, decodes the
// GPZ V2 stream with the production codec (single source of truth) and caches
// the result as flat Int32 arrays so repeated bench runs do not pay the GPZ
// decode cost again.
//
// Cache layout (little endian):
//   magic  8B  "GPSL0DS1"
//   u32    trackCount
//   per track:
//     u16 idLen, id utf8 bytes
//     u32 n
//     n * i32 t, n * i32 lat, n * i32 lon, n * i32 alt
//
// Arrays are Int32Array (timestamps fit u32, but i32 is enough for 2025-2026).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeGpsPoints } from "../../src/services/gpsCodec.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FRONTEND_ROOT = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
export const TRACKS_DIR = path.join(FRONTEND_ROOT, "local-data", "r2", "tracks");
export const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "tracks-v1.bin");
const CACHE_MAGIC = "GPSL0DS1";

export function listTrackFiles() {
  return fs
    .readdirSync(TRACKS_DIR)
    .filter((f) => f.endsWith(".gpz"))
    .sort();
}

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  const buf = fs.readFileSync(CACHE_FILE);
  if (buf.subarray(0, 8).toString("latin1") !== CACHE_MAGIC) return null;
  let off = 8;
  const trackCount = buf.readUInt32LE(off);
  off += 4;
  const tracks = [];
  for (let k = 0; k < trackCount; k++) {
    const idLen = buf.readUInt16LE(off);
    off += 2;
    const id = buf.subarray(off, off + idLen).toString("utf8");
    off += idLen;
    const n = buf.readUInt32LE(off);
    off += 4;
    if (off + n * 16 > buf.length) return null;
    const t = new Int32Array(n);
    const lat = new Int32Array(n);
    const lon = new Int32Array(n);
    const alt = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = buf.readInt32LE(off + i * 4);
      lat[i] = buf.readInt32LE(off + n * 4 + i * 4);
      lon[i] = buf.readInt32LE(off + n * 8 + i * 4);
      alt[i] = buf.readInt32LE(off + n * 12 + i * 4);
    }
    off += n * 16;
    tracks.push({ id, n, t, lat, lon, alt });
  }
  return tracks;
}

function writeCache(tracks) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const parts = [];
  const head = Buffer.alloc(12);
  head.write(CACHE_MAGIC, 0, "latin1");
  head.writeUInt32LE(tracks.length, 8);
  parts.push(head);
  for (const tr of tracks) {
    const idBuf = Buffer.from(tr.id, "utf8");
    const meta = Buffer.alloc(2 + idBuf.length + 4);
    meta.writeUInt16LE(idBuf.length, 0);
    idBuf.copy(meta, 2);
    meta.writeUInt32LE(tr.n, 2 + idBuf.length);
    parts.push(meta);
    const data = Buffer.alloc(tr.n * 16);
    for (let i = 0; i < tr.n; i++) {
      data.writeInt32LE(tr.t[i], i * 4);
      data.writeInt32LE(tr.lat[i], tr.n * 4 + i * 4);
      data.writeInt32LE(tr.lon[i], tr.n * 8 + i * 4);
      data.writeInt32LE(tr.alt[i], tr.n * 12 + i * 4);
    }
    parts.push(data);
  }
  fs.writeFileSync(CACHE_FILE, Buffer.concat(parts));
}

/**
 * @param {{ useCache?: boolean, verbose?: boolean }} opts
 * @returns {{ id: string, n: number, t: Int32Array, lat: Int32Array, lon: Int32Array, alt: Int32Array }[]}
 */
export function loadDataset(opts = {}) {
  const { useCache = true, verbose = false } = opts;
  if (useCache) {
    const cached = readCache();
    if (cached) {
      if (verbose) {
        const total = cached.reduce((a, tr) => a + tr.n, 0);
        console.log(`[dataset] cache hit: ${cached.length} tracks, ${total} points`);
      }
      return cached;
    }
  }
  const files = listTrackFiles();
  const t0 = Date.now();
  const tracks = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(TRACKS_DIR, file));
    const points = decodeGpsPoints(bytes);
    const n = points.length;
    const tr = {
      id: file.replace(/\.gpz$/, ""),
      n,
      t: new Int32Array(n),
      lat: new Int32Array(n),
      lon: new Int32Array(n),
      alt: new Int32Array(n),
    };
    for (let i = 0; i < n; i++) {
      tr.t[i] = points[i].timestamp | 0;
      tr.lat[i] = points[i].latitude_scaled_1e7;
      tr.lon[i] = points[i].longitude_scaled_1e7;
      tr.alt[i] = points[i].altitude_m_scaled_1e1;
    }
    tracks.push(tr);
  }
  if (useCache) writeCache(tracks);
  if (verbose) {
    const total = tracks.reduce((a, tr) => a + tr.n, 0);
    console.log(
      `[dataset] loaded ${tracks.length} tracks, ${total} points in ${Date.now() - t0} ms`
    );
  }
  return tracks;
}

/** Raw GPZ byte sizes keyed by track id (to compute the GPZ baseline). */
export function loadGpzSizes() {
  const out = new Map();
  for (const file of listTrackFiles()) {
    out.set(
      file.replace(/\.gpz$/, ""),
      fs.statSync(path.join(TRACKS_DIR, file)).size
    );
  }
  return out;
}

export function totalPoints(tracks) {
  return tracks.reduce((a, tr) => a + tr.n, 0);
}

/** Map an Int32Array of points through a rescaled copy (e.g. 1e7 -> 1e6). */
export function rescale(arr, divisor) {
  const out = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = Math.round(arr[i] / divisor);
  }
  return out;
}
