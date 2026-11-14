import type { LonLat } from "../types/track";

const EARTH_RADIUS_M = 6371000;
const EARTH_CIRCUMFERENCE_KM = 40075.016686;
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

export function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

export function wgs84ToGcj02(lat: number, lon: number): [number, number] {
  if (outOfChina(lat, lon)) {
    return [lat, lon];
  }
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lon + dLon];
}

export function gcj02ToWgs84(lat: number, lon: number): [number, number] {
  if (outOfChina(lat, lon)) {
    return [lat, lon];
  }
  const [gLat, gLon] = wgs84ToGcj02(lat, lon);
  return [lat * 2 - gLat, lon * 2 - gLon];
}

export function applyDisplayLonLat(
  lon: number,
  lat: number,
  useGcj02: boolean
): LonLat {
  if (!useGcj02) return [lon, lat];
  const [gLat, gLon] = wgs84ToGcj02(lat, lon);
  return [gLon, gLat];
}

export function clampMercatorLat(lat: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

export function latLonToTileFractional(
  lat: number,
  lon: number,
  zoom: number
): { fx: number; fy: number; tx: number; ty: number } {
  const n = 2 ** zoom;
  const clampedLat = clampMercatorLat(lat);
  const latRad = (clampedLat * PI) / 180;
  const fx = ((lon + 180) / 360) * n;
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / PI) / 2) * n;
  const maxTile = n - 1;
  const tx = Math.max(0, Math.min(maxTile, Math.floor(fx)));
  const ty = Math.max(0, Math.min(maxTile, Math.floor(fy)));
  return { fx, fy, tx, ty };
}

export function tileXYToLatLon(
  tx: number,
  ty: number,
  zoom: number
): [number, number] {
  const n = 2 ** zoom;
  const lon = (tx / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(PI * (1 - (2 * ty) / n)));
  const lat = (latRad * 180) / PI;
  return [lat, lon];
}

export function encodeTileKey(tx: number, ty: number): number {
  return (tx & 0xffff) * 65536 + (ty & 0xffff);
}

export function decodeTileKey(key: number): [number, number] {
  const tx = Math.floor(key / 65536);
  const ty = key & 0xffff;
  return [tx, ty];
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * PI) / 180;
  const dLon = ((lon2 - lon1) * PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * PI) / 180) *
      Math.cos((lat2 * PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function pointToSegmentDistanceMeters(
  lat: number,
  lon: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const cosLat = Math.cos((lat * PI) / 180);
  const mPerDegLat = 111319.9;
  const mPerDegLon = 111319.9 * cosLat;

  const x1 = (lon1 - lon) * mPerDegLon;
  const y1 = (lat1 - lat) * mPerDegLat;
  const x2 = (lon2 - lon) * mPerDegLon;
  const y2 = (lat2 - lat) * mPerDegLat;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    return Math.hypot(x1, y1);
  }
  const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(projX, projY);
}

export function cellAreaKm2AtTileY(ty: number, cellZoom: number, tileZoom: number): number {
  const [lat] = tileXYToLatLon(0, ty + 0.5, tileZoom);
  const cellSideKm =
    (EARTH_CIRCUMFERENCE_KM * Math.cos((lat * PI) / 180)) / 2 ** cellZoom;
  return cellSideKm * cellSideKm;
}

export function getZ15TilesForBbox(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  zoom = 15
): number[] {
  const nw = latLonToTileFractional(maxLat, minLon, zoom);
  const se = latLonToTileFractional(minLat, maxLon, zoom);
  const xStart = Math.min(nw.tx, se.tx);
  const xEnd = Math.max(nw.tx, se.tx);
  const yStart = Math.min(nw.ty, se.ty);
  const yEnd = Math.max(nw.ty, se.ty);

  const keys: number[] = [];
  for (let tx = xStart; tx <= xEnd; tx++) {
    for (let ty = yStart; ty <= yEnd; ty++) {
      keys.push(encodeTileKey(tx, ty));
    }
  }
  return keys;
}
