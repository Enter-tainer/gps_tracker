import type { FogPackData, FogTileEntry, GpsPoint } from "../types/track.ts";
import {
  cellAreaKm2AtTileY,
  decodeTileKey,
  encodeTileKey,
  haversineMeters,
  latLonToTileFractional
} from "../utils/coordTransform.ts";

export const FOG_TILE_ZOOM = 15;
export const FOG_SUBGRID_BITS = 6; // 64 x 64 cells per Z15 tile
export const FOG_SUBGRID_SIZE = 1 << FOG_SUBGRID_BITS; // 64
export const FOG_CELL_ZOOM = FOG_TILE_ZOOM + FOG_SUBGRID_BITS; // 21 (~16m cell)
export const FOG_BITMASK_BYTES = (FOG_SUBGRID_SIZE * FOG_SUBGRID_SIZE) / 8; // 512 bytes
export const FOG_MAX_SEGMENT_METERS = 500;

const MAGIC_BYTES = [0x46, 0x47, 0x50, 0x31]; // "FGP1"

export type RasterizedTrackTile = {
  tx: number;
  ty: number;
  tileKey: number;
  bitmask: Uint8Array;
  pointCount: number;
  firstTs: number;
  lastTs: number;
};

function setGlobalCell(
  tiles: Map<number, RasterizedTrackTile>,
  gx: number,
  gy: number,
  ts: number,
  countHit: boolean
): void {
  const maxCell = (1 << FOG_CELL_ZOOM) - 1;
  if (gx < 0 || gx > maxCell || gy < 0 || gy > maxCell) return;

  const tx = gx >> FOG_SUBGRID_BITS;
  const ty = gy >> FOG_SUBGRID_BITS;
  const lx = gx & (FOG_SUBGRID_SIZE - 1);
  const ly = gy & (FOG_SUBGRID_SIZE - 1);
  const key = encodeTileKey(tx, ty);

  let entry = tiles.get(key);
  if (!entry) {
    entry = {
      tx,
      ty,
      tileKey: key,
      bitmask: new Uint8Array(FOG_BITMASK_BYTES),
      pointCount: 0,
      firstTs: ts,
      lastTs: ts
    };
    tiles.set(key, entry);
  }

  const bitIdx = ly * FOG_SUBGRID_SIZE + lx;
  entry.bitmask[bitIdx >> 3] |= 1 << (bitIdx & 7);
  if (countHit) {
    entry.pointCount++;
    if (ts < entry.firstTs) entry.firstTs = ts;
    if (ts > entry.lastTs) entry.lastTs = ts;
  }
}

export function rasterizeTrackToFogTiles(
  points: GpsPoint[]
): Map<number, RasterizedTrackTile> {
  const tiles = new Map<number, RasterizedTrackTile>();
  if (points.length === 0) return tiles;

  const nCells = 1 << FOG_CELL_ZOOM;
  let prevLat = 0;
  let prevLon = 0;
  let prevGx = -1;
  let prevGy = -1;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const lat = pt.latitude_scaled_1e7 / 1e7;
    const lon = pt.longitude_scaled_1e7 / 1e7;
    const ts = pt.timestamp >>> 0;

    if (lat < -85.0511 || lat > 85.0511 || lon < -180 || lon > 180) {
      prevGx = -1;
      continue;
    }

    const frac = latLonToTileFractional(lat, lon, FOG_CELL_ZOOM);
    const gx = Math.min(nCells - 1, Math.max(0, Math.floor(frac.fx)));
    const gy = Math.min(nCells - 1, Math.max(0, Math.floor(frac.fy)));

    setGlobalCell(tiles, gx, gy, ts, true);

    if (prevGx >= 0) {
      const distM = haversineMeters(prevLat, prevLon, lat, lon);
      if (distM <= FOG_MAX_SEGMENT_METERS && (gx !== prevGx || gy !== prevGy)) {
        // 4-connected integer Bresenham line so diagonal tracks never skip cells
        let x = prevGx;
        let y = prevGy;
        const dx = Math.abs(gx - prevGx);
        const dy = Math.abs(gy - prevGy);
        const sx = prevGx < gx ? 1 : -1;
        const sy = prevGy < gy ? 1 : -1;
        let err = dx - dy;

        let safety = 0;
        while ((x !== gx || y !== gy) && safety < 256) {
          safety++;
          const e2 = 2 * err;
          const prevX = x;
          let steppedX = false;
          if (e2 > -dy) {
            err -= dy;
            x += sx;
            steppedX = true;
          }
          if (e2 < dx) {
            if (steppedX) {
              setGlobalCell(tiles, prevX, y + sy, ts, false);
            }
            err += dx;
            y += sy;
          }
          setGlobalCell(tiles, x, y, ts, false);
        }
      }
    }

    prevLat = lat;
    prevLon = lon;
    prevGx = gx;
    prevGy = gy;
  }

  return tiles;
}

export function countSetBitsInMask(bitmask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bitmask.length; i++) {
    let b = bitmask[i];
    if (b === 0) continue;
    while (b !== 0) {
      b &= b - 1;
      count++;
    }
  }
  return count;
}

export function createEmptyFogPack(): FogPackData {
  return {
    version: 1,
    tileCount: 0,
    totalCells: 0,
    exploredAreaKm2: 0,
    tiles: new Map<number, FogTileEntry>()
  };
}

export function recomputeFogStats(pack: FogPackData): FogPackData {
  let totalCells = 0;
  let areaKm2 = 0;
  for (const tile of pack.tiles.values()) {
    const c = countSetBitsInMask(tile.bitmask);
    tile.cellCount = c;
    totalCells += c;
    areaKm2 += c * cellAreaKm2AtTileY(tile.ty, FOG_CELL_ZOOM, FOG_TILE_ZOOM);
  }
  pack.tileCount = pack.tiles.size;
  pack.totalCells = totalCells;
  pack.exploredAreaKm2 = Math.round(areaKm2 * 1000) / 1000;
  return pack;
}

export function mergeTrackTilesIntoFogPack(
  pack: FogPackData,
  trackTiles: Map<number, RasterizedTrackTile>,
  incrementVisitCount = true
): FogPackData {
  for (const [key, src] of trackTiles.entries()) {
    let existing = pack.tiles.get(key);
    if (!existing) {
      existing = {
        tx: src.tx,
        ty: src.ty,
        tileKey: key,
        visitCount: incrementVisitCount ? 1 : 0,
        cellCount: 0,
        bitmask: new Uint8Array(FOG_BITMASK_BYTES)
      };
      pack.tiles.set(key, existing);
    } else if (incrementVisitCount) {
      existing.visitCount = Math.min(65535, existing.visitCount + 1);
    }

    for (let i = 0; i < FOG_BITMASK_BYTES; i++) {
      existing.bitmask[i] |= src.bitmask[i];
    }
  }

  return recomputeFogStats(pack);
}

export function encodeFogPack(pack: FogPackData): Uint8Array {
  recomputeFogStats(pack);
  const sortedKeys = Array.from(pack.tiles.keys()).sort((a, b) => a - b);
  const tileCount = sortedKeys.length;
  const headerBytes = 16;
  const dirBytes = tileCount * 8;
  const dataBytes = tileCount * FOG_BITMASK_BYTES;
  const totalSize = headerBytes + dirBytes + dataBytes;

  const out = new Uint8Array(totalSize);
  out[0] = MAGIC_BYTES[0];
  out[1] = MAGIC_BYTES[1];
  out[2] = MAGIC_BYTES[2];
  out[3] = MAGIC_BYTES[3];

  const view = new DataView(out.buffer);
  view.setUint32(4, 1, true); // version
  view.setUint32(8, tileCount, true);
  view.setUint32(12, pack.totalCells >>> 0, true);

  let dirOffset = headerBytes;
  let maskOffset = headerBytes + dirBytes;

  for (const key of sortedKeys) {
    const entry = pack.tiles.get(key)!;
    view.setUint16(dirOffset, entry.tx, true);
    view.setUint16(dirOffset + 2, entry.ty, true);
    view.setUint16(dirOffset + 4, Math.min(65535, entry.visitCount), true);
    view.setUint16(dirOffset + 6, Math.min(65535, entry.cellCount), true);
    dirOffset += 8;

    out.set(entry.bitmask, maskOffset);
    maskOffset += FOG_BITMASK_BYTES;
  }

  return out;
}

export function decodeFogPack(input: ArrayBuffer | Uint8Array): FogPackData {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  if (bytes.byteLength < 16) {
    return createEmptyFogPack();
  }

  if (
    bytes[0] !== MAGIC_BYTES[0] ||
    bytes[1] !== MAGIC_BYTES[1] ||
    bytes[2] !== MAGIC_BYTES[2] ||
    bytes[3] !== MAGIC_BYTES[3]
  ) {
    throw new Error("Invalid FGP1 fog pack header.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const tileCount = view.getUint32(8, true);
  const totalCells = view.getUint32(12, true);

  const expectedSize = 16 + tileCount * (8 + FOG_BITMASK_BYTES);
  if (bytes.byteLength < expectedSize) {
    throw new Error(
      `Truncated fog pack: expected ${expectedSize} bytes, got ${bytes.byteLength}`
    );
  }

  const tiles = new Map<number, FogTileEntry>();
  let dirOffset = 16;
  let maskOffset = 16 + tileCount * 8;
  let areaKm2 = 0;

  for (let i = 0; i < tileCount; i++) {
    const tx = view.getUint16(dirOffset, true);
    const ty = view.getUint16(dirOffset + 2, true);
    const visitCount = view.getUint16(dirOffset + 4, true);
    const cellCount = view.getUint16(dirOffset + 6, true);
    dirOffset += 8;

    const tileKey = encodeTileKey(tx, ty);
    const bitmask = bytes.slice(maskOffset, maskOffset + FOG_BITMASK_BYTES);
    maskOffset += FOG_BITMASK_BYTES;

    areaKm2 +=
      cellCount * cellAreaKm2AtTileY(ty, FOG_CELL_ZOOM, FOG_TILE_ZOOM);

    tiles.set(tileKey, {
      tx,
      ty,
      tileKey,
      visitCount,
      cellCount,
      bitmask
    });
  }

  return {
    version,
    tileCount,
    totalCells,
    exploredAreaKm2: Math.round(areaKm2 * 1000) / 1000,
    tiles
  };
}

export function tileKeyToLonLatBounds(
  tileKey: number
): [number, number, number, number] {
  const [tx, ty] = decodeTileKey(tileKey);
  const n = 2 ** FOG_TILE_ZOOM;
  const west = (tx / n) * 360 - 180;
  const east = ((tx + 1) / n) * 360 - 180;
  const north =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  const south =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / n))) * 180) /
    Math.PI;
  return [west, south, east, north];
}
