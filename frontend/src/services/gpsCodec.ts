import type { GpsPoint, LonLat } from "../types/track.ts";
import { haversineMeters } from "../utils/coordTransform.ts";

const FULL_BLOCK_INTERVAL = 64;
const INT32_MAX = 0x7fffffff;

function writeZigZagVarint(out: number[], value: number): void {
  const s32 = value | 0;
  let u = ((s32 << 1) ^ (s32 >> 31)) >>> 0;
  while (u >= 0x80) {
    out.push((u & 0x7f) | 0x80);
    u >>>= 7;
  }
  out.push(u);
}

function readVarintS32(
  view: DataView,
  offsetObj: { offset: number }
): number {
  let unsignedVal = 0;
  let shift = 0;
  const initialOffset = offsetObj.offset;

  for (let i = 0; i < 5; i++) {
    if (offsetObj.offset >= view.byteLength) {
      throw new Error(
        `Buffer underflow at offset ${initialOffset} while reading varint.`
      );
    }
    const byte = view.getUint8(offsetObj.offset++);
    unsignedVal |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      return (unsignedVal >>> 1) ^ -(unsignedVal & 1);
    }
  }
  throw new Error(`Varint too long at offset ${initialOffset}.`);
}

export function encodeGpsPointsV2(points: GpsPoint[]): Uint8Array {
  if (points.length === 0) {
    return new Uint8Array(0);
  }

  const out: number[] = [];
  let prev: GpsPoint | null = null;
  let deltaRun = 0;

  const pushFullBlock = (pt: GpsPoint) => {
    out.push(0xfe);
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint32(0, pt.timestamp >>> 0, true);
    view.setInt32(4, Math.round(pt.latitude_scaled_1e7), true);
    view.setInt32(8, Math.round(pt.longitude_scaled_1e7), true);
    view.setInt32(12, Math.round(pt.altitude_m_scaled_1e1), true);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < 16; i++) {
      out.push(bytes[i]);
    }
    prev = {
      timestamp: pt.timestamp >>> 0,
      latitude_scaled_1e7: Math.round(pt.latitude_scaled_1e7),
      longitude_scaled_1e7: Math.round(pt.longitude_scaled_1e7),
      altitude_m_scaled_1e1: Math.round(pt.altitude_m_scaled_1e1)
    };
    deltaRun = 0;
  };

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const ts = pt.timestamp >>> 0;
    const lat = Math.round(pt.latitude_scaled_1e7);
    const lon = Math.round(pt.longitude_scaled_1e7);
    const alt = Math.round(pt.altitude_m_scaled_1e1);

    if (!prev || deltaRun >= FULL_BLOCK_INTERVAL) {
      pushFullBlock({
        timestamp: ts,
        latitude_scaled_1e7: lat,
        longitude_scaled_1e7: lon,
        altitude_m_scaled_1e1: alt
      });
      continue;
    }

    const dTs = ts - prev.timestamp;
    const dLat = lat - prev.latitude_scaled_1e7;
    const dLon = lon - prev.longitude_scaled_1e7;
    const dAlt = alt - prev.altitude_m_scaled_1e1;

    if (
      Math.abs(dTs) > INT32_MAX ||
      Math.abs(dLat) > INT32_MAX ||
      Math.abs(dLon) > INT32_MAX ||
      Math.abs(dAlt) > INT32_MAX
    ) {
      pushFullBlock({
        timestamp: ts,
        latitude_scaled_1e7: lat,
        longitude_scaled_1e7: lon,
        altitude_m_scaled_1e1: alt
      });
      continue;
    }

    let flags = 0;
    if (dTs !== 0) flags |= 0x08;
    if (dLat !== 0) flags |= 0x04;
    if (dLon !== 0) flags |= 0x02;
    if (dAlt !== 0) flags |= 0x01;

    out.push(0x10 | flags);
    if (dTs !== 0) writeZigZagVarint(out, dTs);
    if (dLat !== 0) writeZigZagVarint(out, dLat);
    if (dLon !== 0) writeZigZagVarint(out, dLon);
    if (dAlt !== 0) writeZigZagVarint(out, dAlt);

    prev = {
      timestamp: ts,
      latitude_scaled_1e7: lat,
      longitude_scaled_1e7: lon,
      altitude_m_scaled_1e1: alt
    };
    deltaRun++;
  }

  return new Uint8Array(out);
}

export function decodeGpsPoints(
  input: ArrayBuffer | Uint8Array
): GpsPoint[] {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  const points: GpsPoint[] = [];
  if (bytes.byteLength === 0) return points;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsetObj = { offset: 0 };

  let previousPointV1: GpsPoint | null = null;
  let previousPointV2: GpsPoint | null = null;
  let currentVersion: "V1" | "V2" | null = null;

  while (offsetObj.offset < view.byteLength) {
    const pointStartOffset = offsetObj.offset;
    try {
      const header = view.getUint8(offsetObj.offset++);
      let currentPoint: GpsPoint;

      if (header === 0xff) {
        if (offsetObj.offset + 16 > view.byteLength) {
          throw new Error(`Buffer underflow for V1 full block at ${pointStartOffset}`);
        }
        currentPoint = {
          timestamp: view.getUint32(offsetObj.offset, true),
          latitude_scaled_1e7: view.getInt32(offsetObj.offset + 4, true) * 100,
          longitude_scaled_1e7: view.getInt32(offsetObj.offset + 8, true) * 100,
          altitude_m_scaled_1e1: view.getInt32(offsetObj.offset + 12, true)
        };
        offsetObj.offset += 16;
        currentVersion = "V1";
        previousPointV1 = currentPoint;
      } else if (header === 0xfe) {
        if (offsetObj.offset + 16 > view.byteLength) {
          throw new Error(`Buffer underflow for V2 full block at ${pointStartOffset}`);
        }
        currentPoint = {
          timestamp: view.getUint32(offsetObj.offset, true),
          latitude_scaled_1e7: view.getInt32(offsetObj.offset + 4, true),
          longitude_scaled_1e7: view.getInt32(offsetObj.offset + 8, true),
          altitude_m_scaled_1e1: view.getInt32(offsetObj.offset + 12, true)
        };
        offsetObj.offset += 16;
        currentVersion = "V2";
        previousPointV2 = currentPoint;
      } else if ((header & 0xf0) === 0x00) {
        if (currentVersion !== "V1" || !previousPointV1) {
          throw new Error(`V1 Delta without V1 Full block at ${pointStartOffset}`);
        }
        currentPoint = { ...previousPointV1 };
        const flags = header & 0x0f;
        if ((flags >> 3) & 1) {
          currentPoint.timestamp =
            (currentPoint.timestamp + readVarintS32(view, offsetObj)) >>> 0;
        }
        if ((flags >> 2) & 1) {
          currentPoint.latitude_scaled_1e7 += readVarintS32(view, offsetObj) * 100;
        }
        if ((flags >> 1) & 1) {
          currentPoint.longitude_scaled_1e7 += readVarintS32(view, offsetObj) * 100;
        }
        if (flags & 1) {
          currentPoint.altitude_m_scaled_1e1 += readVarintS32(view, offsetObj);
        }
        previousPointV1 = currentPoint;
      } else if ((header & 0xf0) === 0x10) {
        if (currentVersion !== "V2" || !previousPointV2) {
          throw new Error(`V2 Delta without V2 Full block at ${pointStartOffset}`);
        }
        currentPoint = { ...previousPointV2 };
        const flags = header & 0x0f;
        if ((flags >> 3) & 1) {
          currentPoint.timestamp =
            (currentPoint.timestamp + readVarintS32(view, offsetObj)) >>> 0;
        }
        if ((flags >> 2) & 1) {
          currentPoint.latitude_scaled_1e7 += readVarintS32(view, offsetObj);
        }
        if ((flags >> 1) & 1) {
          currentPoint.longitude_scaled_1e7 += readVarintS32(view, offsetObj);
        }
        if (flags & 1) {
          currentPoint.altitude_m_scaled_1e1 += readVarintS32(view, offsetObj);
        }
        previousPointV2 = currentPoint;
      } else {
        throw new Error(`Invalid block header 0x${header.toString(16)} at ${pointStartOffset}`);
      }

      points.push(currentPoint);
    } catch {
      if (offsetObj.offset <= pointStartOffset) {
        offsetObj.offset = pointStartOffset + 1;
      } else {
        break;
      }
    }
  }

  return points;
}

export function parseGpxXmlToPoints(
  xml: string,
  fallbackDateIso?: string
): GpsPoint[] {
  const rawPoints: GpsPoint[] = [];
  const fallbackBaseMs = fallbackDateIso
    ? Date.parse(`${fallbackDateIso}T08:00:00Z`)
    : Date.parse("2025-05-03T08:00:00Z");
  const baseSec = Number.isFinite(fallbackBaseMs)
    ? Math.floor(fallbackBaseMs / 1000)
    : 1746259200;

  // Match <trkpt ...>...</trkpt>, <rtept ...>...</rtept>, or self-closing variants
  const ptRe =
    /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  const latRe = /\blat=["']([+-]?\d+(?:\.\d+)?)["']/i;
  const lonRe = /\blon=["']([+-]?\d+(?:\.\d+)?)["']/i;
  const eleRe = /<ele>\s*([+-]?\d+(?:\.\d+)?)\s*<\/ele>/i;
  const timeRe = /<time>\s*([^<\s]+)\s*<\/time>/i;

  let lastTs = baseSec;
  let match: RegExpExecArray | null;
  while ((match = ptRe.exec(xml)) !== null) {
    const attrs = match[2] ?? "";
    const body = match[3] ?? "";

    const latMatch = latRe.exec(attrs);
    const lonMatch = lonRe.exec(attrs);
    if (!latMatch || !lonMatch) continue;

    const lat = Number.parseFloat(latMatch[1]);
    const lon = Number.parseFloat(lonMatch[1]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
    ) {
      continue;
    }

    const eleMatch = eleRe.exec(body);
    const ele = eleMatch ? Number.parseFloat(eleMatch[1]) : 0;

    let ts = lastTs + (rawPoints.length === 0 ? 0 : 2);
    const timeMatch = timeRe.exec(body);
    if (timeMatch) {
      const parsedMs = Date.parse(timeMatch[1]);
      if (Number.isFinite(parsedMs) && parsedMs > 0) {
        ts = Math.floor(parsedMs / 1000);
      }
    }
    lastTs = ts;

    rawPoints.push({
      timestamp: ts >>> 0,
      latitude_scaled_1e7: Math.round(lat * 1e7),
      longitude_scaled_1e7: Math.round(lon * 1e7),
      altitude_m_scaled_1e1: Number.isFinite(ele) ? Math.round(ele * 10) : 0
    });
  }

  if (rawPoints.length <= 1) return rawPoints;

  // Ensure monotonic timestamp order
  let needsSort = false;
  for (let i = 1; i < rawPoints.length; i++) {
    if (rawPoints[i].timestamp < rawPoints[i - 1].timestamp) {
      needsSort = true;
      break;
    }
  }
  if (needsSort) {
    rawPoints.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Deduplicate exact repeated (timestamp, lat, lon)
  const deduped: GpsPoint[] = [rawPoints[0]];
  for (let i = 1; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    const prev = deduped[deduped.length - 1];
    if (
      p.timestamp === prev.timestamp &&
      p.latitude_scaled_1e7 === prev.latitude_scaled_1e7 &&
      p.longitude_scaled_1e7 === prev.longitude_scaled_1e7
    ) {
      continue;
    }
    deduped.push(p);
  }

  return deduped;
}

export function pointsToGpxXml(points: GpsPoint[], name: string): string {
  const title = name.replace(/\.[^/.]+$/, "");
  const startIso =
    points.length > 0
      ? new Date(points[0].timestamp * 1000).toISOString()
      : new Date().toISOString();

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
    `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
    `  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"`,
    `  version="1.1" creator="MGT GPS">`,
    `  <metadata>`,
    `    <name>${title}</name>`,
    `    <time>${startIso}</time>`,
    `  </metadata>`,
    `  <trk>`,
    `    <name>${title}</name>`,
    `    <trkseg>`
  ];

  for (const pt of points) {
    const lat = pt.latitude_scaled_1e7 / 1e7;
    const lon = pt.longitude_scaled_1e7 / 1e7;
    const ele = pt.altitude_m_scaled_1e1 / 10;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    lines.push(
      `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`,
      `        <ele>${ele.toFixed(1)}</ele>`,
      `        <time>${new Date(pt.timestamp * 1000).toISOString()}</time>`,
      `      </trkpt>`
    );
  }

  lines.push(`    </trkseg>`, `  </trk>`, `</gpx>`);
  return lines.join("\n");
}

function perpendicularDistance(
  p: LonLat,
  a: LonLat,
  b: LonLat
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const magSq = dx * dx + dy * dy;
  if (magSq === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / magSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdpSimplify(coords: LonLat[], epsilon: number): LonLat[] {
  if (coords.length <= 2) return coords;

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;

    let maxDist = 0;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(coords[i], coords[start], coords[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const result: LonLat[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (keep[i]) result.push(coords[i]);
  }
  return result;
}

export type ComputedTrackSummary = {
  pointCount: number;
  distanceM: number;
  durationS: number;
  elevGainM: number;
  minEle: number;
  maxEle: number;
  startTime: number;
  endTime: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  overviewCoords: LonLat[][];
};

export function computeTrackStatsAndOverview(
  points: GpsPoint[]
): ComputedTrackSummary {
  if (points.length === 0) {
    return {
      pointCount: 0,
      distanceM: 0,
      durationS: 0,
      elevGainM: 0,
      minEle: 0,
      maxEle: 0,
      startTime: 0,
      endTime: 0,
      minLat: 0,
      maxLat: 0,
      minLon: 0,
      maxLon: 0,
      overviewCoords: []
    };
  }

  let distanceM = 0;
  let elevGainM = 0;
  const firstEle = points[0].altitude_m_scaled_1e1 / 10;
  let minEle = firstEle;
  let maxEle = firstEle;
  let eleRef = firstEle;

  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  let startTime = points[0].timestamp;
  let endTime = points[0].timestamp;

  const segments: LonLat[][] = [];
  let currentSeg: LonLat[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lat = p.latitude_scaled_1e7 / 1e7;
    const lon = p.longitude_scaled_1e7 / 1e7;
    const ele = p.altitude_m_scaled_1e1 / 10;

    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (ele < minEle) minEle = ele;
    if (ele > maxEle) maxEle = ele;
    if (p.timestamp < startTime) startTime = p.timestamp;
    if (p.timestamp > endTime) endTime = p.timestamp;

    // 3m hysteresis elevation gain filter
    if (ele - eleRef >= 3.0) {
      elevGainM += ele - eleRef;
      eleRef = ele;
    } else if (eleRef - ele >= 3.0) {
      eleRef = ele;
    }

    if (i > 0) {
      const prev = points[i - 1];
      const prevLat = prev.latitude_scaled_1e7 / 1e7;
      const prevLon = prev.longitude_scaled_1e7 / 1e7;
      const segDist = haversineMeters(prevLat, prevLon, lat, lon);
      if (segDist <= 5000) {
        distanceM += segDist;
      }
      if (segDist > 2000 && currentSeg.length > 0) {
        if (currentSeg.length >= 2) {
          segments.push(currentSeg);
        }
        currentSeg = [];
      }
    }

    currentSeg.push([
      Math.round(lon * 1e5) / 1e5,
      Math.round(lat * 1e5) / 1e5
    ]);
  }
  if (currentSeg.length >= 2) {
    segments.push(currentSeg);
  } else if (segments.length === 0 && currentSeg.length === 1) {
    segments.push(currentSeg);
  }

  // Simplify segments until total overview vertices <= 260
  let epsilon = 0.00015;
  let simplified = segments.map((seg) => rdpSimplify(seg, epsilon));
  let totalVerts = simplified.reduce((acc, s) => acc + s.length, 0);
  let guard = 0;
  while (totalVerts > 260 && guard < 12) {
    epsilon *= 1.65;
    simplified = segments.map((seg) => rdpSimplify(seg, epsilon));
    totalVerts = simplified.reduce((acc, s) => acc + s.length, 0);
    guard++;
  }

  return {
    pointCount: points.length,
    distanceM: Math.round(distanceM * 10) / 10,
    durationS: Math.max(0, endTime - startTime),
    elevGainM: Math.round(elevGainM * 10) / 10,
    minEle: Math.round(minEle * 10) / 10,
    maxEle: Math.round(maxEle * 10) / 10,
    startTime,
    endTime,
    minLat,
    maxLat,
    minLon,
    maxLon,
    overviewCoords: simplified
  };
}

export type TrackProfileSeries = {
  distancesKm: Float64Array;
  speedsKmh: Float32Array;
  elevationsM: Float32Array;
  timestamps: Uint32Array;
};

export function computePointSeries(points: GpsPoint[]): TrackProfileSeries {
  const n = points.length;
  const distancesKm = new Float64Array(n);
  const rawSpeeds = new Float32Array(n);
  const speedsKmh = new Float32Array(n);
  const elevationsM = new Float32Array(n);
  const timestamps = new Uint32Array(n);

  if (n === 0) {
    return { distancesKm, speedsKmh, elevationsM, timestamps };
  }

  let cumDistM = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    elevationsM[i] = p.altitude_m_scaled_1e1 / 10;
    timestamps[i] = p.timestamp >>> 0;

    if (i > 0) {
      const prev = points[i - 1];
      const segM = haversineMeters(
        prev.latitude_scaled_1e7 / 1e7,
        prev.longitude_scaled_1e7 / 1e7,
        p.latitude_scaled_1e7 / 1e7,
        p.longitude_scaled_1e7 / 1e7
      );
      if (segM <= 5000) {
        cumDistM += segM;
      }
      const dt = Math.max(1, p.timestamp - prev.timestamp);
      const kmh = segM <= 5000 ? (segM / dt) * 3.6 : 0;
      rawSpeeds[i] = kmh > 350 ? 0 : kmh;
    }
    distancesKm[i] = cumDistM / 1000;
  }

  // 3-point moving average for clean UI speed plotting
  for (let i = 0; i < n; i++) {
    const a = rawSpeeds[Math.max(0, i - 1)];
    const b = rawSpeeds[i];
    const c = rawSpeeds[Math.min(n - 1, i + 1)];
    speedsKmh[i] = (a + b + c) / 3;
  }

  return { distancesKm, speedsKmh, elevationsM, timestamps };
}
