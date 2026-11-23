import { decodeGpsl0 } from "../../frontend/src/services/gpsl0/index.ts";
import {
  gcj02ToWgs84,
  haversineMeters,
  pointToSegmentDistanceMeters
} from "../../frontend/src/utils/coordTransform.ts";
import type { AgentTrackItem } from "./api.ts";

export type CoordSystem = "wgs84" | "gcj02";

export interface DecodedPoint {
  ts: number;
  lat: number;
  lon: number;
  alt: number;
}

export interface StopCluster {
  index: number;
  start_ts: number;
  end_ts: number;
  start_iso: string;
  end_iso: string;
  duration_s: number;
  lat: number;
  lon: number;
  point_count: number;
}

export interface MovingSegment {
  index: number;
  start_ts: number;
  end_ts: number;
  start_iso: string;
  end_iso: string;
  duration_s: number;
  distance_m: number;
  distance_km: number;
  avg_speed_kmh: number;
  elev_gain_m: number;
  inferred_mode: "stationary" | "walk" | "run" | "bike" | "vehicle" | "high_speed";
}

export interface TrackAnalysisSummary {
  point_count: number;
  start_ts: number | null;
  end_ts: number | null;
  start_iso: string | null;
  end_iso: string | null;
  duration_s: number;
  distance_m: number;
  distance_km: number;
  elev_gain_m: number;
  min_alt_m: number | null;
  max_alt_m: number | null;
  max_speed_kmh: number;
  avg_moving_speed_kmh: number;
  stops: StopCluster[];
  segments: MovingSegment[];
  waypoints: Array<{
    ts: number;
    iso: string;
    lat: number;
    lon: number;
    alt: number;
  }>;
}

export interface TimestampLocationResult {
  mode: "interpolated" | "nearest" | "empty";
  target_ts: number;
  target_iso: string;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  speed_kmh: number | null;
  delta_s: number | null;
  nearest_point_ts: number | null;
  nearest_point_iso: string | null;
}

export interface ExactProximityResult {
  min_distance_m: number;
  closest_ts: number;
  closest_iso: string;
  closest_lat: number;
  closest_lon: number;
  within_radius: boolean;
  visits: Array<{
    enter_ts: number;
    exit_ts: number;
    enter_iso: string;
    exit_iso: string;
    dwell_s: number;
    point_count: number;
    min_distance_m: number;
  }>;
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function toIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export function normalizeCoordInput(
  lat: number,
  lon: number,
  coord: CoordSystem
): [number, number] {
  if (coord === "gcj02") {
    return gcj02ToWgs84(lat, lon);
  }
  return [lat, lon];
}

export function decodeTrackPoints(bytes: Uint8Array): DecodedPoint[] {
  const decoded = decodeGpsl0(bytes);
  const n = decoded.t.length;
  const points: DecodedPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = {
      ts: decoded.t[i] >>> 0,
      lat: round(decoded.lat[i] / 1e7, 7),
      lon: round(decoded.lon[i] / 1e7, 7),
      alt: round(decoded.alt[i] / 10, 1)
    };
  }
  return points;
}

export function locateAtTimestamp(
  points: DecodedPoint[],
  targetTs: number
): TimestampLocationResult {
  if (points.length === 0) {
    return {
      mode: "empty",
      target_ts: targetTs,
      target_iso: toIso(targetTs),
      lat: null,
      lon: null,
      alt: null,
      speed_kmh: null,
      delta_s: null,
      nearest_point_ts: null,
      nearest_point_iso: null
    };
  }

  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = points[mid].ts;
    if (t === targetTs) {
      const p = points[mid];
      let speedKmh = 0;
      if (mid > 0) {
        const prev = points[mid - 1];
        const dt = p.ts - prev.ts;
        if (dt > 0 && dt <= 600) {
          speedKmh =
            (haversineMeters(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6;
        }
      }
      return {
        mode: "interpolated",
        target_ts: targetTs,
        target_iso: toIso(targetTs),
        lat: p.lat,
        lon: p.lon,
        alt: p.alt,
        speed_kmh: round(speedKmh, 1),
        delta_s: 0,
        nearest_point_ts: p.ts,
        nearest_point_iso: toIso(p.ts)
      };
    }
    if (t < targetTs) lo = mid + 1;
    else hi = mid - 1;
  }

  const leftIdx = Math.max(0, Math.min(points.length - 1, hi));
  const rightIdx = Math.max(0, Math.min(points.length - 1, lo));
  const left = points[leftIdx];
  const right = points[rightIdx];

  if (
    leftIdx !== rightIdx &&
    targetTs >= left.ts &&
    targetTs <= right.ts &&
    right.ts - left.ts <= 600 &&
    right.ts > left.ts
  ) {
    const dt = right.ts - left.ts;
    const ratio = (targetTs - left.ts) / dt;
    const lat = round(left.lat + (right.lat - left.lat) * ratio, 7);
    const lon = round(left.lon + (right.lon - left.lon) * ratio, 7);
    const alt = round(left.alt + (right.alt - left.alt) * ratio, 1);
    const dist = haversineMeters(left.lat, left.lon, right.lat, right.lon);
    const speedKmh = round((dist / dt) * 3.6, 1);
    const dLeft = Math.abs(targetTs - left.ts);
    const dRight = Math.abs(right.ts - targetTs);
    const nearest = dLeft <= dRight ? left : right;
    return {
      mode: "interpolated",
      target_ts: targetTs,
      target_iso: toIso(targetTs),
      lat,
      lon,
      alt,
      speed_kmh: speedKmh,
      delta_s: 0,
      nearest_point_ts: nearest.ts,
      nearest_point_iso: toIso(nearest.ts)
    };
  }

  const dLeft = Math.abs(targetTs - left.ts);
  const dRight = Math.abs(right.ts - targetTs);
  const nearest = dLeft <= dRight ? left : right;
  return {
    mode: "nearest",
    target_ts: targetTs,
    target_iso: toIso(targetTs),
    lat: nearest.lat,
    lon: nearest.lon,
    alt: nearest.alt,
    speed_kmh: null,
    delta_s: Math.abs(targetTs - nearest.ts),
    nearest_point_ts: nearest.ts,
    nearest_point_iso: toIso(nearest.ts)
  };
}

export function computeExactProximity(
  points: DecodedPoint[],
  targetLat: number,
  targetLon: number,
  radiusM: number
): ExactProximityResult | null {
  if (points.length === 0) return null;

  let minDist = Number.POSITIVE_INFINITY;
  let closestTs = points[0].ts;
  let closestLat = points[0].lat;
  let closestLon = points[0].lon;

  const visits: ExactProximityResult["visits"] = [];
  let activeVisit: {
    enter_ts: number;
    exit_ts: number;
    point_count: number;
    min_distance_m: number;
  } | null = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dPt = haversineMeters(targetLat, targetLon, p.lat, p.lon);
    if (dPt < minDist) {
      minDist = dPt;
      closestTs = p.ts;
      closestLat = p.lat;
      closestLon = p.lon;
    }

    if (i > 0) {
      const prev = points[i - 1];
      const segSpan = haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
      if (segSpan <= 2000) {
        const dSeg = pointToSegmentDistanceMeters(
          targetLat,
          targetLon,
          prev.lat,
          prev.lon,
          p.lat,
          p.lon
        );
        if (dSeg < minDist) {
          minDist = dSeg;
          closestTs = Math.round((prev.ts + p.ts) / 2);
          closestLat = round((prev.lat + p.lat) / 2, 7);
          closestLon = round((prev.lon + p.lon) / 2, 7);
        }
      }
    }

    if (dPt <= radiusM) {
      if (!activeVisit) {
        activeVisit = {
          enter_ts: p.ts,
          exit_ts: p.ts,
          point_count: 1,
          min_distance_m: dPt
        };
      } else {
        activeVisit.exit_ts = p.ts;
        activeVisit.point_count++;
        if (dPt < activeVisit.min_distance_m) activeVisit.min_distance_m = dPt;
      }
    } else if (activeVisit) {
      visits.push({
        enter_ts: activeVisit.enter_ts,
        exit_ts: activeVisit.exit_ts,
        enter_iso: toIso(activeVisit.enter_ts),
        exit_iso: toIso(activeVisit.exit_ts),
        dwell_s: Math.max(0, activeVisit.exit_ts - activeVisit.enter_ts),
        point_count: activeVisit.point_count,
        min_distance_m: round(activeVisit.min_distance_m, 1)
      });
      activeVisit = null;
    }
  }

  if (activeVisit) {
    visits.push({
      enter_ts: activeVisit.enter_ts,
      exit_ts: activeVisit.exit_ts,
      enter_iso: toIso(activeVisit.enter_ts),
      exit_iso: toIso(activeVisit.exit_ts),
      dwell_s: Math.max(0, activeVisit.exit_ts - activeVisit.enter_ts),
      point_count: activeVisit.point_count,
      min_distance_m: round(activeVisit.min_distance_m, 1)
    });
  }

  return {
    min_distance_m: round(minDist, 1),
    closest_ts: closestTs,
    closest_iso: toIso(closestTs),
    closest_lat: closestLat,
    closest_lon: closestLon,
    within_radius: minDist <= radiusM,
    visits
  };
}

function inferTravelMode(
  avgSpeedKmh: number
): MovingSegment["inferred_mode"] {
  if (avgSpeedKmh < 1.2) return "stationary";
  if (avgSpeedKmh < 7.0) return "walk";
  if (avgSpeedKmh < 14.0) return "run";
  if (avgSpeedKmh < 28.0) return "bike";
  if (avgSpeedKmh < 130.0) return "vehicle";
  return "high_speed";
}

function computeRangeMetrics(points: DecodedPoint[], startIdx: number, endIdx: number) {
  let distanceM = 0;
  let elevGainM = 0;
  let maxSpeedKmh = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const d = haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon);
    const dt = cur.ts - prev.ts;
    if (d <= 50_000) {
      distanceM += d;
      if (dt > 0 && d / dt < 120) {
        const kmh = (d / dt) * 3.6;
        if (kmh > maxSpeedKmh) maxSpeedKmh = kmh;
      }
    }
    const dAlt = cur.alt - prev.alt;
    if (dAlt > 0.5 && dAlt < 500) {
      elevGainM += dAlt;
    }
  }
  return { distanceM, elevGainM, maxSpeedKmh };
}

export function analyzeTrack(
  points: DecodedPoint[],
  opts?: {
    stopRadiusM?: number;
    stopMinDurationS?: number;
    maxWaypoints?: number;
  }
): TrackAnalysisSummary {
  const stopRadiusM = opts?.stopRadiusM ?? 100;
  const stopMinDurationS = opts?.stopMinDurationS ?? 300;
  const maxWaypoints = opts?.maxWaypoints ?? 24;

  if (points.length === 0) {
    return {
      point_count: 0,
      start_ts: null,
      end_ts: null,
      start_iso: null,
      end_iso: null,
      duration_s: 0,
      distance_m: 0,
      distance_km: 0,
      elev_gain_m: 0,
      min_alt_m: null,
      max_alt_m: null,
      max_speed_kmh: 0,
      avg_moving_speed_kmh: 0,
      stops: [],
      segments: [],
      waypoints: []
    };
  }

  let minAlt = points[0].alt;
  let maxAlt = points[0].alt;
  for (const p of points) {
    if (p.alt < minAlt) minAlt = p.alt;
    if (p.alt > maxAlt) maxAlt = p.alt;
  }

  const totalMetrics = computeRangeMetrics(points, 0, points.length - 1);
  const startTs = points[0].ts;
  const endTs = points[points.length - 1].ts;
  const durationS = Math.max(0, endTs - startTs);

  // Stop detection: sliding anchor cluster (bounded against both mean and anchor to prevent drift)
  const stopRanges: Array<{ startIdx: number; endIdx: number }> = [];
  let anchorIdx = 0;
  while (anchorIdx < points.length) {
    const anchor = points[anchorIdx];
    let j = anchorIdx + 1;
    let sumLat = anchor.lat;
    let sumLon = anchor.lon;
    let count = 1;
    while (j < points.length) {
      const meanLat = sumLat / count;
      const meanLon = sumLon / count;
      const dMean = haversineMeters(meanLat, meanLon, points[j].lat, points[j].lon);
      const dAnchor = haversineMeters(anchor.lat, anchor.lon, points[j].lat, points[j].lon);
      if (dMean > stopRadiusM || dAnchor > stopRadiusM * 1.5) break;
      sumLat += points[j].lat;
      sumLon += points[j].lon;
      count++;
      j++;
    }
    const lastIdx = j - 1;
    const spanS = points[lastIdx].ts - anchor.ts;
    if (spanS >= stopMinDurationS && count >= 2) {
      stopRanges.push({ startIdx: anchorIdx, endIdx: lastIdx });
      anchorIdx = lastIdx + 1;
    } else {
      anchorIdx++;
    }
  }

  const stops: StopCluster[] = stopRanges.map((sr, idx) => {
    let sumLat = 0;
    let sumLon = 0;
    const cnt = sr.endIdx - sr.startIdx + 1;
    for (let i = sr.startIdx; i <= sr.endIdx; i++) {
      sumLat += points[i].lat;
      sumLon += points[i].lon;
    }
    const sTs = points[sr.startIdx].ts;
    const eTs = points[sr.endIdx].ts;
    return {
      index: idx + 1,
      start_ts: sTs,
      end_ts: eTs,
      start_iso: toIso(sTs),
      end_iso: toIso(eTs),
      duration_s: Math.max(0, eTs - sTs),
      lat: round(sumLat / cnt, 6),
      lon: round(sumLon / cnt, 6),
      point_count: cnt
    };
  });

  // Moving segments between stops
  const segments: MovingSegment[] = [];
  let cursor = 0;
  for (const sr of stopRanges) {
    if (sr.startIdx > cursor) {
      const m = computeRangeMetrics(points, cursor, sr.startIdx);
      const sTs = points[cursor].ts;
      const eTs = points[sr.startIdx].ts;
      const dur = Math.max(1, eTs - sTs);
      const avgKmh = (m.distanceM / dur) * 3.6;
      if (m.distanceM >= 20) {
        segments.push({
          index: segments.length + 1,
          start_ts: sTs,
          end_ts: eTs,
          start_iso: toIso(sTs),
          end_iso: toIso(eTs),
          duration_s: eTs - sTs,
          distance_m: Math.round(m.distanceM),
          distance_km: round(m.distanceM / 1000, 3),
          avg_speed_kmh: round(avgKmh, 1),
          elev_gain_m: Math.round(m.elevGainM),
          inferred_mode: inferTravelMode(avgKmh)
        });
      }
    }
    cursor = sr.endIdx;
  }
  if (cursor < points.length - 1) {
    const m = computeRangeMetrics(points, cursor, points.length - 1);
    const sTs = points[cursor].ts;
    const eTs = points[points.length - 1].ts;
    const dur = Math.max(1, eTs - sTs);
    const avgKmh = (m.distanceM / dur) * 3.6;
    if (m.distanceM >= 20 || segments.length === 0) {
      segments.push({
        index: segments.length + 1,
        start_ts: sTs,
        end_ts: eTs,
        start_iso: toIso(sTs),
        end_iso: toIso(eTs),
        duration_s: eTs - sTs,
        distance_m: Math.round(m.distanceM),
        distance_km: round(m.distanceM / 1000, 3),
        avg_speed_kmh: round(avgKmh, 1),
        elev_gain_m: Math.round(m.elevGainM),
        inferred_mode: inferTravelMode(avgKmh)
      });
    }
  }

  const movingDur = segments.reduce((s, seg) => s + seg.duration_s, 0);
  const movingDist = segments.reduce((s, seg) => s + seg.distance_m, 0);
  const avgMovingKmh = movingDur > 0 ? (movingDist / movingDur) * 3.6 : 0;

  const sampled = downsamplePoints(points, maxWaypoints);
  const waypoints = sampled.map((p) => ({
    ts: p.ts,
    iso: toIso(p.ts),
    lat: p.lat,
    lon: p.lon,
    alt: p.alt
  }));

  return {
    point_count: points.length,
    start_ts: startTs,
    end_ts: endTs,
    start_iso: toIso(startTs),
    end_iso: toIso(endTs),
    duration_s: durationS,
    distance_m: Math.round(totalMetrics.distanceM),
    distance_km: round(totalMetrics.distanceM / 1000, 3),
    elev_gain_m: Math.round(totalMetrics.elevGainM),
    min_alt_m: round(minAlt, 1),
    max_alt_m: round(maxAlt, 1),
    max_speed_kmh: round(totalMetrics.maxSpeedKmh, 1),
    avg_moving_speed_kmh: round(avgMovingKmh, 1),
    stops,
    segments,
    waypoints
  };
}

export function downsamplePoints(
  points: DecodedPoint[],
  maxPoints: number
): DecodedPoint[] {
  if (maxPoints <= 0 || points.length <= maxPoints) {
    return points.slice();
  }
  if (maxPoints === 1) {
    return [points[0]];
  }
  const out: DecodedPoint[] = [];
  const step = (points.length - 1) / (maxPoints - 1);
  let lastIdx = -1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = i === maxPoints - 1 ? points.length - 1 : Math.round(i * step);
    if (idx !== lastIdx) {
      out.push(points[idx]);
      lastIdx = idx;
    }
  }
  return out;
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatGpx(
  track: Pick<AgentTrackItem, "id" | "title">,
  points: DecodedPoint[]
): string {
  const trkpts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.alt.toFixed(1)}</ele><time>${toIso(p.ts)}</time></trkpt>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="traceveil-cli" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(track.title || track.id)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function formatGeoJson(
  track: AgentTrackItem,
  points: DecodedPoint[]
): string {
  const featureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          id: track.id,
          date: track.date,
          title: track.title,
          distance_km: track.distance_km,
          duration_s: track.duration_s,
          elev_gain_m: track.elev_gain_m,
          point_count: points.length,
          timestamps: points.map((p) => p.ts)
        },
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lon, p.lat, p.alt])
        }
      }
    ]
  };
  return JSON.stringify(featureCollection, null, 2) + "\n";
}
