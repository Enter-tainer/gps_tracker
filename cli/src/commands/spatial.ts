import {
  computeExactProximity,
  decodeTrackPoints,
  locateAtTimestamp,
  normalizeCoordInput,
  type CoordSystem,
  type ExactProximityResult,
  type TimestampLocationResult
} from "../analyze.ts";
import type {
  AgentTrackItem,
  AgentTrackRegionRef,
  SpatialMatchItem,
  TraceveilClient
} from "../api.ts";
import { parseTimestampFlag, writeJson } from "../output.ts";

interface WhereApiResponse {
  at: number;
  at_iso: string | null;
  window_s: number;
  exact_tracks: Array<{
    track: AgentTrackItem;
    delta_s: number;
    regions: AgentTrackRegionRef[];
  }>;
  nearest_tracks: Array<{
    track: AgentTrackItem;
    delta_s: number;
    regions: AgentTrackRegionRef[];
  }>;
}

interface SpatialApiResponse {
  query: Record<string, unknown>;
  mode: "z15_tiles" | "bbox";
  tileCount: number;
  total: number;
  truncated: boolean;
  matches: SpatialMatchItem[];
}

export async function runWhereCommand(
  client: TraceveilClient,
  flags: {
    at: string;
    windowHours?: number;
    noCache?: boolean;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  const atTs = parseTimestampFlag(flags.at);
  const windowS = Math.max(
    60,
    Math.min(604800, Math.round((flags.windowHours ?? 24) * 3600))
  );

  const apiRes = await client.getJson<WhereApiResponse>(
    `/api/agent/where?at=${atTs}&window_s=${windowS}`
  );

  const candidates =
    apiRes.exact_tracks.length > 0
      ? apiRes.exact_tracks
      : apiRes.nearest_tracks.slice(0, 3);

  const resolvedLocations: Array<{
    track: AgentTrackItem;
    delta_s: number;
    regions: AgentTrackRegionRef[];
    location: TimestampLocationResult | null;
  }> = [];

  for (const item of candidates) {
    let location: TimestampLocationResult | null = null;
    try {
      const bytes = await client.getTrackGpsl0(item.track.id, {
        noCache: flags.noCache
      });
      const pts = decodeTrackPoints(bytes);
      location = locateAtTimestamp(pts, atTs);
    } catch {
      location = null;
    }
    resolvedLocations.push({
      track: item.track,
      delta_s: item.delta_s,
      regions: item.regions,
      location
    });
  }

  let bestLocation: {
    track_id: string;
    track_title: string;
    regions: AgentTrackRegionRef[];
    location: TimestampLocationResult;
  } | null = null;

  for (const r of resolvedLocations) {
    if (!r.location || r.location.lat === null || r.location.lon === null) continue;
    if (
      !bestLocation ||
      (r.location.delta_s ?? Number.POSITIVE_INFINITY) <
        (bestLocation.location.delta_s ?? Number.POSITIVE_INFINITY)
    ) {
      bestLocation = {
        track_id: r.track.id,
        track_title: r.track.title,
        regions: r.regions,
        location: r.location
      };
    }
  }

  const outObj = {
    at: apiRes.at,
    at_iso: apiRes.at_iso,
    window_s: apiRes.window_s,
    best_location: bestLocation,
    exact_tracks: apiRes.exact_tracks.map((e) => {
      const found = resolvedLocations.find((r) => r.track.id === e.track.id);
      return found ?? { ...e, location: null };
    }),
    nearest_tracks: apiRes.nearest_tracks.map((n) => {
      const found = resolvedLocations.find((r) => r.track.id === n.track.id);
      return found ?? { ...n, location: null };
    })
  };

  if (flags.jsonMode) {
    writeJson(outObj, Boolean(flags.pretty));
    return 0;
  }

  process.stdout.write(`Query time: ${outObj.at_iso} (unix=${outObj.at})\n`);
  if (!bestLocation) {
    process.stdout.write(
      `No track points found within +/-${Math.round(windowS / 3600)}h of target timestamp.\n`
    );
    return 0;
  }

  const loc = bestLocation.location;
  const regionLabel = bestLocation.regions
    .map((r) => r.nameZh || r.nameEn)
    .join(" / ");
  process.stdout.write(
    `Best match : (${loc.lat}, ${loc.lon}) alt=${loc.alt}m mode=${loc.mode}` +
      `${loc.speed_kmh !== null ? ` speed=${loc.speed_kmh} km/h` : ""}` +
      `${loc.delta_s ? ` (delta=${loc.delta_s}s)` : ""}\n` +
      `Track      : ${bestLocation.track_id} (${bestLocation.track_title})\n` +
      `${regionLabel ? `Regions    : ${regionLabel}\n` : ""}`
  );
  return 0;
}

export async function runNearbyCommand(
  client: TraceveilClient,
  flags: {
    lat: number;
    lon: number;
    radius?: number;
    coord?: CoordSystem;
    exact?: boolean;
    from?: string;
    to?: string;
    limit?: number;
    noCache?: boolean;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  const coord: CoordSystem = flags.coord ?? "wgs84";
  const [wgsLat, wgsLon] = normalizeCoordInput(flags.lat, flags.lon, coord);
  const radiusM = flags.radius ?? 500;
  const limit = flags.limit ?? 20;

  // When --exact is enabled, fetch slightly more coarse candidates before sorting by exact distance
  const apiLimit = flags.exact ? Math.min(100, Math.max(limit * 2, 30)) : limit;

  const apiRes = await client.postJson<SpatialApiResponse>(
    "/api/agent/spatial/nearby",
    {
      lat: wgsLat,
      lon: wgsLon,
      radius_m: radiusM,
      ...(flags.from ? { from: flags.from } : {}),
      ...(flags.to ? { to: flags.to } : {}),
      limit: apiLimit
    }
  );

  if (!flags.exact) {
    const outObj = {
      input: {
        lat: flags.lat,
        lon: flags.lon,
        coord,
        wgs84_lat: wgsLat,
        wgs84_lon: wgsLon,
        radius_m: radiusM
      },
      ...apiRes
    };
    if (flags.jsonMode) {
      writeJson(outObj, Boolean(flags.pretty));
      return 0;
    }
    process.stdout.write(
      `Coarse matches within ${radiusM}m of (${wgsLat.toFixed(6)}, ${wgsLon.toFixed(6)}) [${apiRes.mode}]: ${apiRes.total}\n`
    );
    for (const m of apiRes.matches) {
      process.stdout.write(
        `  ${m.track.date}  ${m.trackId}  pts=${m.matchedPoints}  ${m.first_iso ?? "-"}  ${m.track.title}\n`
      );
    }
    return 0;
  }

  const exactMatches: Array<
    SpatialMatchItem & { exact: ExactProximityResult }
  > = [];
  for (const m of apiRes.matches) {
    try {
      const bytes = await client.getTrackGpsl0(m.trackId, {
        noCache: flags.noCache
      });
      const pts = decodeTrackPoints(bytes);
      const prox = computeExactProximity(pts, wgsLat, wgsLon, radiusM);
      if (prox && prox.within_radius) {
        exactMatches.push({ ...m, exact: prox });
      }
    } catch {
      // Skip blobs that cannot be decoded
    }
  }

  exactMatches.sort((a, b) => b.firstTs - a.firstTs);
  const sliced = exactMatches.slice(0, limit);

  const outObj = {
    input: {
      lat: flags.lat,
      lon: flags.lon,
      coord,
      wgs84_lat: wgsLat,
      wgs84_lon: wgsLon,
      radius_m: radiusM
    },
    mode: "exact",
    coarse_candidates: apiRes.matches.length,
    total: exactMatches.length,
    truncated: exactMatches.length > sliced.length,
    matches: sliced
  };

  if (flags.jsonMode) {
    writeJson(outObj, Boolean(flags.pretty));
    return 0;
  }

  process.stdout.write(
    `Exact matches within ${radiusM}m of (${wgsLat.toFixed(6)}, ${wgsLon.toFixed(6)}): ${outObj.total} (from ${apiRes.matches.length} coarse candidates)\n`
  );
  for (const m of sliced) {
    process.stdout.write(
      `  ${m.track.date}  ${m.trackId}  minDist=${m.exact.min_distance_m}m at ${m.exact.closest_iso}  visits=${m.exact.visits.length}  ${m.track.title}\n`
    );
  }
  return 0;
}

export async function runBboxCommand(
  client: TraceveilClient,
  flags: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
    coord?: CoordSystem;
    from?: string;
    to?: string;
    limit?: number;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  const coord: CoordSystem = flags.coord ?? "wgs84";
  const [swLat, swLon] = normalizeCoordInput(flags.minLat, flags.minLon, coord);
  const [neLat, neLon] = normalizeCoordInput(flags.maxLat, flags.maxLon, coord);

  const apiRes = await client.postJson<SpatialApiResponse>(
    "/api/agent/spatial/nearby",
    {
      min_lat: Math.min(swLat, neLat),
      min_lon: Math.min(swLon, neLon),
      max_lat: Math.max(swLat, neLat),
      max_lon: Math.max(swLon, neLon),
      ...(flags.from ? { from: flags.from } : {}),
      ...(flags.to ? { to: flags.to } : {}),
      limit: flags.limit ?? 20
    }
  );

  const outObj = { coord, ...apiRes };
  if (flags.jsonMode) {
    writeJson(outObj, Boolean(flags.pretty));
    return 0;
  }

  process.stdout.write(
    `BBox matches [${apiRes.mode}]: ${apiRes.total} (showing ${apiRes.matches.length})\n`
  );
  for (const m of apiRes.matches) {
    process.stdout.write(
      `  ${m.track.date}  ${m.trackId}  pts=${m.matchedPoints}  ${m.track.title}\n`
    );
  }
  return 0;
}
