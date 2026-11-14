import type {
  FogPackData,
  GpsPoint,
  SpatialQueryMatch
} from "../types/track.ts";
import { pointToSegmentDistanceMeters, haversineMeters } from "../utils/coordTransform.ts";
import { decodeFogPack } from "./fogEngine.ts";
import { decodeGpsPoints } from "./gpsCodec.ts";

const trackPointsCache = new Map<string, GpsPoint[]>();
const inflightRequests = new Map<string, Promise<GpsPoint[]>>();

export function getCachedTrackPoints(trackId: string): GpsPoint[] | undefined {
  return trackPointsCache.get(trackId);
}

export function setTrackPointsInCache(trackId: string, points: GpsPoint[]): void {
  trackPointsCache.set(trackId, points);
}

export function removeTrackFromCache(trackId: string): void {
  trackPointsCache.delete(trackId);
}

export async function fetchAndDecodeTrack(trackId: string): Promise<GpsPoint[]> {
  const cached = trackPointsCache.get(trackId);
  if (cached) return cached;

  const inflight = inflightRequests.get(trackId);
  if (inflight) return inflight;

  const req = (async () => {
    const resp = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/gpz`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch track ${trackId}: HTTP ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    const points = decodeGpsPoints(buf);
    trackPointsCache.set(trackId, points);
    return points;
  })();

  inflightRequests.set(trackId, req);
  try {
    return await req;
  } finally {
    inflightRequests.delete(trackId);
  }
}

export async function fetchAndDecodeFog(): Promise<FogPackData> {
  const resp = await fetch("/api/fog");
  if (!resp.ok) {
    throw new Error(`Failed to fetch fog pack: HTTP ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  return decodeFogPack(buf);
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx]);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

export async function verifyPointSpatialMatches(
  queryLat: number,
  queryLon: number,
  radiusM: number,
  candidates: SpatialQueryMatch[]
): Promise<SpatialQueryMatch[]> {
  if (candidates.length === 0) return [];

  const verified = await runWithConcurrency(candidates, 6, async (cand) => {
    try {
      const pts = await fetchAndDecodeTrack(cand.trackId);
      let minDist = Number.POSITIVE_INFINITY;
      let closestTs = cand.firstTs;
      let hitCount = 0;
      let firstHitTs = Number.POSITIVE_INFINITY;
      let lastHitTs = 0;

      // Quick degree bounding reject (~1.5x radius)
      const degPadLat = (radiusM * 1.5) / 111000;
      const degPadLon =
        (radiusM * 1.5) / (111000 * Math.max(0.2, Math.cos((queryLat * Math.PI) / 180)));

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const lat = p.latitude_scaled_1e7 / 1e7;
        const lon = p.longitude_scaled_1e7 / 1e7;

        if (
          Math.abs(lat - queryLat) <= degPadLat * 4 &&
          Math.abs(lon - queryLon) <= degPadLon * 4
        ) {
          const dPt = haversineMeters(queryLat, queryLon, lat, lon);
          if (dPt < minDist) {
            minDist = dPt;
            closestTs = p.timestamp;
          }
          if (dPt <= radiusM) {
            hitCount++;
            if (p.timestamp < firstHitTs) firstHitTs = p.timestamp;
            if (p.timestamp > lastHitTs) lastHitTs = p.timestamp;
          }
        }

        if (i > 0) {
          const prev = pts[i - 1];
          const pLat = prev.latitude_scaled_1e7 / 1e7;
          const pLon = prev.longitude_scaled_1e7 / 1e7;
          // Check segment only if bounding box overlaps padded query and not a GPS teleport gap
          const segMinLat = Math.min(lat, pLat) - degPadLat;
          const segMaxLat = Math.max(lat, pLat) + degPadLat;
          const segMinLon = Math.min(lon, pLon) - degPadLon;
          const segMaxLon = Math.max(lon, pLon) + degPadLon;

          if (
            queryLat >= segMinLat &&
            queryLat <= segMaxLat &&
            queryLon >= segMinLon &&
            queryLon <= segMaxLon &&
            haversineMeters(pLat, pLon, lat, lon) <= 500
          ) {
            const dSeg = pointToSegmentDistanceMeters(
              queryLat,
              queryLon,
              pLat,
              pLon,
              lat,
              lon
            );
            if (dSeg < minDist) {
              minDist = dSeg;
              closestTs = Math.round((prev.timestamp + p.timestamp) / 2);
            }
          }
        }
      }

      if (minDist > radiusM) return null;
      return {
        trackId: cand.trackId,
        matchedPoints: Math.max(1, hitCount),
        firstTs: Number.isFinite(firstHitTs) ? firstHitTs : closestTs,
        lastTs: lastHitTs > 0 ? lastHitTs : closestTs,
        minDistanceM: Math.round(minDist * 10) / 10,
        closestTs
      } as SpatialQueryMatch;
    } catch {
      return cand;
    }
  });

  return verified
    .filter((v): v is SpatialQueryMatch => v !== null)
    .sort((a, b) => (b.closestTs ?? b.firstTs) - (a.closestTs ?? a.firstTs));
}

export async function verifyBboxSpatialMatches(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  candidates: SpatialQueryMatch[]
): Promise<SpatialQueryMatch[]> {
  if (candidates.length === 0) return [];

  const verified = await runWithConcurrency(candidates, 6, async (cand) => {
    try {
      const pts = await fetchAndDecodeTrack(cand.trackId);
      let hits = 0;
      let firstHitTs = Number.POSITIVE_INFINITY;
      let lastHitTs = 0;

      for (const p of pts) {
        const lat = p.latitude_scaled_1e7 / 1e7;
        const lon = p.longitude_scaled_1e7 / 1e7;
        if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
          hits++;
          if (p.timestamp < firstHitTs) firstHitTs = p.timestamp;
          if (p.timestamp > lastHitTs) lastHitTs = p.timestamp;
        }
      }

      if (hits === 0) return null;
      return {
        trackId: cand.trackId,
        matchedPoints: hits,
        firstTs: firstHitTs,
        lastTs: lastHitTs
      } as SpatialQueryMatch;
    } catch {
      return cand;
    }
  });

  return verified
    .filter((v): v is SpatialQueryMatch => v !== null)
    .sort((a, b) => b.firstTs - a.firstTs);
}
