import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  TileType,
  type RangeResponse,
  type Source
} from "pmtiles";

import {
  archiveVersion,
  parseRegionTilePath,
  tileCacheControl
} from "./src/worker/regionTiles.ts";
import { getZ15TilesForBbox } from "./src/utils/coordTransform.ts";
import type {
  BootstrapStats,
  CompactTrackRegionTuple,
  CompactTrackTileTuple,
  SpatialQueryMatch,
  TrackMetadata,
  UploadTrackMetaPayload,
  VisitedRegion
} from "./src/types/track.ts";

type LocalTileHit = {
  trackId: string;
  pointCount: number;
  firstTs: number;
  lastTs: number;
};

type LocalIndex = {
  stats: BootstrapStats;
  tracks: TrackMetadata[];
  tileIndex: Record<string, LocalTileHit[]>;
};

type LocalRegionsData = {
  visitedRegions: VisitedRegion[];
  trackRegions: Array<[number, string, number, number, number]>;
};

const EMPTY_FOG_HEADER = Buffer.from([
  0x46, 0x47, 0x50, 0x31,
  1, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0
]);

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

function sanitizeTrackId(raw: string): string {
  const cleaned = raw
    .replace(/\.(gpx|gpz)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `track-${Date.now()}`;
}

function loadLocalIndex(dataDir: string): LocalIndex {
  const indexPath = path.join(dataDir, "index.json");
  if (!fs.existsSync(indexPath)) {
    return {
      stats: {
        trackCount: 0,
        totalPoints: 0,
        totalDistanceM: 0,
        totalDurationS: 0,
        totalElevGainM: 0,
        firstDate: null,
        lastDate: null,
        visitedTilesZ15: 0,
        exploredCellsZ21: 0,
        exploredAreaKm2: 0
      },
      tracks: [],
      tileIndex: {}
    };
  }
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as LocalIndex;
}

function saveLocalIndex(dataDir: string, idx: LocalIndex): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "index.json"), JSON.stringify(idx));
}

function loadLocalRegions(dataDir: string): LocalRegionsData {
  const regionsPath = path.join(dataDir, "regions-visited.json");
  if (!fs.existsSync(regionsPath)) {
    return { visitedRegions: [], trackRegions: [] };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(regionsPath, "utf8")
    ) as Partial<LocalRegionsData>;
    return {
      visitedRegions: Array.isArray(parsed.visitedRegions)
        ? parsed.visitedRegions
        : [],
      trackRegions: Array.isArray(parsed.trackRegions) ? parsed.trackRegions : []
    };
  } catch {
    return { visitedRegions: [], trackRegions: [] };
  }
}

function saveLocalRegions(dataDir: string, data: LocalRegionsData): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "regions-visited.json"), JSON.stringify(data));
}

function recomputeLocalStats(
  tracks: TrackMetadata[],
  tileCount: number,
  totalCells: number,
  exploredAreaKm2: number
): BootstrapStats {
  const dates = tracks.map((t) => t.date).sort();
  return {
    trackCount: tracks.length,
    totalPoints: tracks.reduce((s, t) => s + t.point_count, 0),
    totalDistanceM: Math.round(tracks.reduce((s, t) => s + t.distance_m, 0)),
    totalDurationS: tracks.reduce((s, t) => s + t.duration_s, 0),
    totalElevGainM: Math.round(tracks.reduce((s, t) => s + t.elev_gain_m, 0)),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    visitedTilesZ15: tileCount,
    exploredCellsZ21: totalCells,
    exploredAreaKm2
  };
}

async function nodeDecompress(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  if (
    compression === Compression.None ||
    compression === Compression.Unknown
  ) {
    return buf;
  }
  if (compression === Compression.Gzip) {
    const out = zlib.gunzipSync(Buffer.from(buf));
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }
  throw new Error(`Unsupported compression: ${compression}`);
}

async function keepNodeGzipTiles(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  return compression === Compression.Gzip
    ? buf
    : nodeDecompress(buf, compression);
}

class LocalPmtilesSource implements Source {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  getKey(): string {
    return this.filePath;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Archive not found: ${this.filePath}`);
    }
    const stat = fs.statSync(this.filePath);
    const currentEtag = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    if (etag && etag !== currentEtag) {
      throw new EtagMismatch(`Archive changed: ${this.filePath}`);
    }
    const clampedLen = Math.max(0, Math.min(length, stat.size - offset));
    const buf = Buffer.allocUnsafe(clampedLen);
    if (clampedLen > 0) {
      const fd = fs.openSync(this.filePath, "r");
      try {
        fs.readSync(fd, buf, 0, clampedLen, offset);
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      etag: currentEtag
    };
  }
}

const LOCAL_REGION_DIR_CACHE = new ResolvedValueCache(
  25,
  undefined,
  nodeDecompress
);

function toIsoOrNullLocal(ts: number): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

function roundLocal(val: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(val * f) / f;
}

function serializeLocalAgentTrack(
  t: TrackMetadata,
  includeOverview: boolean
): Omit<TrackMetadata, "overview_coords"> & {
  overview_coords?: TrackMetadata["overview_coords"];
  distance_km: number;
  start_iso: string | null;
  end_iso: string | null;
} {
  const { overview_coords, ...rest } = t;
  return {
    ...rest,
    distance_km: roundLocal(t.distance_m / 1000, 3),
    start_iso: toIsoOrNullLocal(t.start_time),
    end_iso: toIsoOrNullLocal(t.end_time),
    ...(includeOverview ? { overview_coords } : {})
  };
}

function serializeLocalRegion(r: VisitedRegion) {
  return {
    ...r,
    coverage_ratio:
      r.areaKm2 > 0 ? Math.min(1, roundLocal(r.exploredAreaKm2 / r.areaKm2, 6)) : 0,
    first_iso: toIsoOrNullLocal(r.firstTs),
    last_iso: toIsoOrNullLocal(r.lastTs)
  };
}

function parseTimestampLocal(raw: string | null): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function getRegionsForTrackLocal(reg: LocalRegionsData, trackId: string) {
  const regionMap = new Map(reg.visitedRegions.map((r) => [r.rid, r]));
  const items: Array<{
    rid: number;
    level: number;
    parentRid: number | null;
    country: string;
    nameZh: string;
    nameEn: string;
    cellCount: number;
    firstTs: number;
    lastTs: number;
    first_iso: string | null;
    last_iso: string | null;
  }> = [];

  for (const [rid, tid, cellCount, firstTs, lastTs] of reg.trackRegions) {
    if (tid !== trackId) continue;
    const vr = regionMap.get(rid);
    if (!vr) continue;
    items.push({
      rid: vr.rid,
      level: vr.level,
      parentRid: vr.parentRid,
      country: vr.country,
      nameZh: vr.nameZh,
      nameEn: vr.nameEn,
      cellCount,
      firstTs,
      lastTs,
      first_iso: toIsoOrNullLocal(firstTs),
      last_iso: toIsoOrNullLocal(lastTs)
    });
  }

  return items.sort((a, b) => a.level - b.level || b.cellCount - a.cellCount);
}

async function handleLocalAgentApi(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  dataDir: string
): Promise<boolean> {
  const urlPath = parsedUrl.pathname;
  if (!urlPath.startsWith("/api/agent")) return false;

  if (urlPath === "/api/agent/auth/config" && req.method === "GET") {
    sendJson(res, 200, {
      configured: false,
      local_dev: true,
      message: "Local Vite API mode does not require OIDC authentication"
    });
    return true;
  }

  if (urlPath === "/api/agent/me" && req.method === "GET") {
    sendJson(res, 200, {
      sub: "local-dev",
      email: "local@dev",
      name: "Local Dev",
      exp: Math.floor(Date.now() / 1000) + 86400,
      exp_iso: toIsoOrNullLocal(Math.floor(Date.now() / 1000) + 86400),
      iat: Math.floor(Date.now() / 1000),
      iss: "http://localhost",
      aud: "local-dev",
      scopes: ["tracks:read"],
      local_dev: true
    });
    return true;
  }

  const idx = loadLocalIndex(dataDir);
  const reg = loadLocalRegions(dataDir);

  if (urlPath === "/api/agent/stats" && req.method === "GET") {
    const year = parsedUrl.searchParams.get("year")?.trim() ?? "";
    const month = parsedUrl.searchParams.get("month")?.trim() ?? "";
    const from = parsedUrl.searchParams.get("from")?.trim() ?? "";
    const to = parsedUrl.searchParams.get("to")?.trim() ?? "";

    let tracks = idx.tracks;
    if (month) {
      tracks = tracks.filter((t) => t.date >= `${month}-01` && t.date <= `${month}-31`);
    } else if (year) {
      tracks = tracks.filter((t) => t.date >= `${year}-01-01` && t.date <= `${year}-12-31`);
    }
    if (from) tracks = tracks.filter((t) => t.date >= from);
    if (to) tracks = tracks.filter((t) => t.date <= to);

    const unfiltered = !year && !month && !from && !to;
    const dates = tracks.map((t) => t.date).sort();
    const totalDistanceM = Math.round(tracks.reduce((s, t) => s + t.distance_m, 0));
    const totalElevGainM = Math.round(tracks.reduce((s, t) => s + t.elev_gain_m, 0));

    const byYearMap = new Map<
      string,
      { year: string; trackCount: number; distanceM: number; durationS: number; elevGainM: number; pointCount: number }
    >();
    for (const t of tracks) {
      const y = t.date.slice(0, 4);
      const cur = byYearMap.get(y) ?? {
        year: y,
        trackCount: 0,
        distanceM: 0,
        durationS: 0,
        elevGainM: 0,
        pointCount: 0
      };
      cur.trackCount += 1;
      cur.distanceM += t.distance_m;
      cur.durationS += t.duration_s;
      cur.elevGainM += t.elev_gain_m;
      cur.pointCount += t.point_count;
      byYearMap.set(y, cur);
    }

    const counts = { l0: 0, l1: 0, l2: 0, l3: 0, total: 0 };
    for (const vr of reg.visitedRegions) {
      if (vr.level === 0) counts.l0++;
      else if (vr.level === 1) counts.l1++;
      else if (vr.level === 2) counts.l2++;
      else if (vr.level === 3) counts.l3++;
      counts.total++;
    }

    sendJson(res, 200, {
      filter: { year: year || null, month: month || null, from: from || null, to: to || null },
      stats: {
        trackCount: tracks.length,
        totalPoints: tracks.reduce((s, t) => s + t.point_count, 0),
        totalDistanceM,
        totalDistanceKm: roundLocal(totalDistanceM / 1000, 3),
        totalDurationS: tracks.reduce((s, t) => s + t.duration_s, 0),
        totalElevGainM,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
        ...(unfiltered
          ? {
              visitedTilesZ15: idx.stats.visitedTilesZ15,
              exploredCellsZ21: idx.stats.exploredCellsZ21,
              exploredAreaKm2: idx.stats.exploredAreaKm2
            }
          : {})
      },
      ...(unfiltered ? { visitedRegionCounts: counts } : {}),
      byYear: Array.from(byYearMap.values())
        .sort((a, b) => b.year.localeCompare(a.year))
        .map((y) => ({
          ...y,
          distanceM: Math.round(y.distanceM),
          distanceKm: roundLocal(y.distanceM / 1000, 3),
          elevGainM: Math.round(y.elevGainM)
        }))
    });
    return true;
  }

  if (urlPath === "/api/agent/tracks" && req.method === "GET") {
    const from = parsedUrl.searchParams.get("from")?.trim() ?? "";
    const to = parsedUrl.searchParams.get("to")?.trim() ?? "";
    const regionIdRaw = parsedUrl.searchParams.get("region_id")?.trim() ?? "";
    const regionName = parsedUrl.searchParams.get("region")?.trim().toLowerCase() ?? "";
    const country = parsedUrl.searchParams.get("country")?.trim().toUpperCase() ?? "";
    const q = parsedUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const minDist = Number(parsedUrl.searchParams.get("min_distance_m") ?? "");
    const maxDist = Number(parsedUrl.searchParams.get("max_distance_m") ?? "");
    const sort = parsedUrl.searchParams.get("sort")?.trim() || "date_desc";
    const limit = Math.max(1, Math.min(100, Number.parseInt(parsedUrl.searchParams.get("limit") || "20", 10) || 20));
    const offset = Math.max(0, Number.parseInt(parsedUrl.searchParams.get("offset") || "0", 10) || 0);
    const includeOverview = parsedUrl.searchParams.get("include_overview") === "1";

    const regionMap = new Map(reg.visitedRegions.map((r) => [r.rid, r]));
    const trackToRids = new Map<string, number[]>();
    for (const [rid, tid] of reg.trackRegions) {
      const arr = trackToRids.get(tid) ?? [];
      arr.push(rid);
      trackToRids.set(tid, arr);
    }

    let list = idx.tracks.slice();
    if (from) list = list.filter((t) => t.date >= from);
    if (to) list = list.filter((t) => t.date <= to);
    if (Number.isFinite(minDist)) list = list.filter((t) => t.distance_m >= minDist);
    if (Number.isFinite(maxDist)) list = list.filter((t) => t.distance_m <= maxDist);
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          t.source_file.toLowerCase().includes(q)
      );
    }
    if (regionIdRaw) {
      const rid = Number.parseInt(regionIdRaw, 10);
      list = list.filter((t) => (trackToRids.get(t.id) ?? []).includes(rid));
    }
    if (regionName) {
      list = list.filter((t) =>
        (trackToRids.get(t.id) ?? []).some((rid) => {
          const vr = regionMap.get(rid);
          return (
            vr &&
            (vr.nameZh.toLowerCase().includes(regionName) ||
              vr.nameEn.toLowerCase().includes(regionName))
          );
        })
      );
    }
    if (country) {
      list = list.filter((t) =>
        (trackToRids.get(t.id) ?? []).some((rid) => {
          const vr = regionMap.get(rid);
          return vr && vr.country.toUpperCase() === country;
        })
      );
    }

    list.sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return a.date.localeCompare(b.date) || a.start_time - b.start_time;
        case "distance_desc":
          return b.distance_m - a.distance_m || b.date.localeCompare(a.date);
        case "distance_asc":
          return a.distance_m - b.distance_m || b.date.localeCompare(a.date);
        case "duration_desc":
          return b.duration_s - a.duration_s || b.date.localeCompare(a.date);
        case "duration_asc":
          return a.duration_s - b.duration_s || b.date.localeCompare(a.date);
        case "elev_desc":
          return b.elev_gain_m - a.elev_gain_m || b.date.localeCompare(a.date);
        case "elev_asc":
          return a.elev_gain_m - b.elev_gain_m || b.date.localeCompare(a.date);
        case "date_desc":
        default:
          return b.date.localeCompare(a.date) || b.start_time - a.start_time;
      }
    });

    const page = list
      .slice(offset, offset + limit)
      .map((t) => serializeLocalAgentTrack(t, includeOverview));

    sendJson(res, 200, {
      total: list.length,
      limit,
      offset,
      truncated: offset + page.length < list.length,
      tracks: page
    });
    return true;
  }

  if (urlPath === "/api/agent/regions" && req.method === "GET") {
    const levelRaw = parsedUrl.searchParams.get("level")?.trim() ?? "";
    const country = parsedUrl.searchParams.get("country")?.trim().toUpperCase() ?? "";
    const parentRaw = parsedUrl.searchParams.get("parent_id")?.trim() ?? "";
    const q = parsedUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const sort = parsedUrl.searchParams.get("sort")?.trim() || "heat";
    const limit = Math.max(1, Math.min(200, Number.parseInt(parsedUrl.searchParams.get("limit") || "50", 10) || 50));
    const offset = Math.max(0, Number.parseInt(parsedUrl.searchParams.get("offset") || "0", 10) || 0);

    let list = reg.visitedRegions.slice();
    if (levelRaw !== "") {
      const level = Number.parseInt(levelRaw, 10);
      list = list.filter((r) => r.level === level);
    }
    if (country) {
      list = list.filter((r) => r.country.toUpperCase() === country);
    }
    if (parentRaw !== "") {
      const pid = Number.parseInt(parentRaw, 10);
      list = list.filter((r) => r.parentRid === pid);
    }
    if (q) {
      list = list.filter(
        (r) =>
          r.nameZh.toLowerCase().includes(q) ||
          r.nameEn.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      switch (sort) {
        case "visit_days":
          return b.visitDays - a.visitDays || b.heat - a.heat;
        case "explored_area":
          return b.exploredAreaKm2 - a.exploredAreaKm2 || b.heat - a.heat;
        case "last_ts":
          return b.lastTs - a.lastTs || b.heat - a.heat;
        case "track_count":
          return b.trackCount - a.trackCount || b.heat - a.heat;
        case "heat":
        default:
          return b.heat - a.heat || b.exploredAreaKm2 - a.exploredAreaKm2;
      }
    });

    const page = list.slice(offset, offset + limit).map(serializeLocalRegion);
    sendJson(res, 200, {
      total: list.length,
      limit,
      offset,
      truncated: offset + page.length < list.length,
      regions: page
    });
    return true;
  }

  const regionMatch = urlPath.match(/^\/api\/agent\/regions\/(\d+)$/);
  if (regionMatch && req.method === "GET") {
    const rid = Number.parseInt(regionMatch[1], 10);
    const limit = Math.max(1, Math.min(100, Number.parseInt(parsedUrl.searchParams.get("limit") || "20", 10) || 20));
    const offset = Math.max(0, Number.parseInt(parsedUrl.searchParams.get("offset") || "0", 10) || 0);
    const regionMap = new Map(reg.visitedRegions.map((r) => [r.rid, r]));
    const target = regionMap.get(rid);
    if (!target) {
      sendJson(res, 404, { error: "Visited region not found", rid });
      return true;
    }

    const ancestors: Array<ReturnType<typeof serializeLocalRegion>> = [];
    let curParent = target.parentRid;
    let guard = 0;
    while (curParent !== null && guard < 4) {
      guard++;
      const p = regionMap.get(curParent);
      if (!p) break;
      ancestors.unshift(serializeLocalRegion(p));
      curParent = p.parentRid;
    }

    const children = reg.visitedRegions
      .filter((r) => r.parentRid === rid)
      .sort((a, b) => b.heat - a.heat || b.exploredAreaKm2 - a.exploredAreaKm2)
      .map(serializeLocalRegion);

    const trackMap = new Map(idx.tracks.map((t) => [t.id, t]));
    const linked = reg.trackRegions
      .filter((tr) => tr[0] === rid && trackMap.has(tr[1]))
      .map((tr) => {
        const t = trackMap.get(tr[1])!;
        return {
          ...serializeLocalAgentTrack(t, false),
          regionCellCount: tr[2],
          regionFirstTs: tr[3],
          regionLastTs: tr[4],
          regionFirstIso: toIsoOrNullLocal(tr[3]),
          regionLastIso: toIsoOrNullLocal(tr[4])
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.start_time - a.start_time);

    const page = linked.slice(offset, offset + limit);
    sendJson(res, 200, {
      region: serializeLocalRegion(target),
      ancestors,
      children,
      tracksTotal: linked.length,
      tracksTruncated: offset + page.length < linked.length,
      tracks: page
    });
    return true;
  }

  if (urlPath === "/api/agent/spatial/nearby" && req.method === "POST") {
    const bodyBuf = await readRequestBody(req);
    const body = JSON.parse(bodyBuf.toString("utf8") || "{}") as {
      lat?: number;
      lon?: number;
      radius_m?: number;
      min_lat?: number;
      min_lon?: number;
      max_lat?: number;
      max_lon?: number;
      from?: string;
      to?: string;
      limit?: number;
    };

    const limit = Math.max(1, Math.min(100, Number(body.limit) || 20));
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";

    let minLat: number;
    let minLon: number;
    let maxLat: number;
    let maxLon: number;
    let querySpec: Record<string, unknown>;

    if (typeof body.lat === "number" && typeof body.lon === "number") {
      const radiusM = Math.max(10, Math.min(50_000, body.radius_m ?? 500));
      const dLat = radiusM / 111_320;
      const cosLat = Math.max(0.05, Math.cos((body.lat * Math.PI) / 180));
      const dLon = radiusM / (111_320 * cosLat);
      minLat = Math.max(-85.0511, body.lat - dLat);
      maxLat = Math.min(85.0511, body.lat + dLat);
      minLon = Math.max(-180, body.lon - dLon);
      maxLon = Math.min(180, body.lon + dLon);
      querySpec = { type: "radius", lat: body.lat, lon: body.lon, radius_m: radiusM, bbox: [minLon, minLat, maxLon, maxLat] };
    } else if (
      typeof body.min_lat === "number" &&
      typeof body.min_lon === "number" &&
      typeof body.max_lat === "number" &&
      typeof body.max_lon === "number"
    ) {
      minLat = Math.min(body.min_lat, body.max_lat);
      maxLat = Math.max(body.min_lat, body.max_lat);
      minLon = Math.min(body.min_lon, body.max_lon);
      maxLon = Math.max(body.min_lon, body.max_lon);
      querySpec = { type: "bbox", bbox: [minLon, minLat, maxLon, maxLat] };
    } else {
      sendJson(res, 400, { error: "Provide lat/lon or bbox" });
      return true;
    }

    const tileKeys = getZ15TilesForBbox(minLat, minLon, maxLat, maxLon, 15);
    const trackMap = new Map(idx.tracks.map((t) => [t.id, t]));

    if (tileKeys.length > 0 && tileKeys.length <= 1600) {
      const agg = new Map<string, SpatialQueryMatch>();
      for (const k of tileKeys) {
        const hits = idx.tileIndex[String(k)] || [];
        for (const h of hits) {
          const prev = agg.get(h.trackId);
          if (!prev) {
            agg.set(h.trackId, { ...h });
          } else {
            prev.matchedPoints += h.pointCount;
            prev.firstTs = Math.min(prev.firstTs, h.firstTs);
            prev.lastTs = Math.max(prev.lastTs, h.lastTs);
          }
        }
      }
      const matches = Array.from(agg.values())
        .filter((m) => {
          const t = trackMap.get(m.trackId);
          if (!t) return false;
          if (from && t.date < from) return false;
          if (to && t.date > to) return false;
          return true;
        })
        .sort((a, b) => b.firstTs - a.firstTs)
        .map((m) => ({
          trackId: m.trackId,
          matchedPoints: m.matchedPoints,
          firstTs: m.firstTs,
          lastTs: m.lastTs,
          first_iso: toIsoOrNullLocal(m.firstTs),
          last_iso: toIsoOrNullLocal(m.lastTs),
          track: serializeLocalAgentTrack(trackMap.get(m.trackId)!, false)
        }));

      sendJson(res, 200, {
        query: querySpec,
        mode: "z15_tiles",
        tileCount: tileKeys.length,
        total: matches.length,
        truncated: matches.length > limit,
        matches: matches.slice(0, limit)
      });
      return true;
    }

    const bboxMatches = idx.tracks
      .filter((t) => {
        if (t.max_lat < minLat || t.min_lat > maxLat) return false;
        if (t.max_lon < minLon || t.min_lon > maxLon) return false;
        if (from && t.date < from) return false;
        if (to && t.date > to) return false;
        return true;
      })
      .map((t) => ({
        trackId: t.id,
        matchedPoints: t.point_count,
        firstTs: t.start_time,
        lastTs: t.end_time,
        first_iso: toIsoOrNullLocal(t.start_time),
        last_iso: toIsoOrNullLocal(t.end_time),
        track: serializeLocalAgentTrack(t, false)
      }));

    sendJson(res, 200, {
      query: querySpec,
      mode: "bbox",
      tileCount: tileKeys.length,
      total: bboxMatches.length,
      truncated: bboxMatches.length > limit,
      matches: bboxMatches.slice(0, limit)
    });
    return true;
  }

  if (urlPath === "/api/agent/where" && req.method === "GET") {
    const atTs = parseTimestampLocal(parsedUrl.searchParams.get("at"));
    if (atTs === null) {
      sendJson(res, 400, { error: "Query param 'at' is required" });
      return true;
    }
    const windowS = Math.max(
      60,
      Math.min(604800, Number.parseInt(parsedUrl.searchParams.get("window_s") || "86400", 10) || 86400)
    );

    const exact = idx.tracks
      .filter((t) => t.start_time <= atTs && t.end_time >= atTs)
      .slice(0, 10)
      .map((t) => ({
        track: serializeLocalAgentTrack(t, false),
        delta_s: 0,
        regions: getRegionsForTrackLocal(reg, t.id)
      }));

    const nearest = idx.tracks
      .filter((t) => !(t.start_time <= atTs && t.end_time >= atTs))
      .map((t) => {
        const delta =
          atTs < t.start_time
            ? t.start_time - atTs
            : atTs > t.end_time
              ? atTs - t.end_time
              : 0;
        return { t, delta };
      })
      .filter((x) => x.delta <= windowS)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 5)
      .map(({ t, delta }) => ({
        track: serializeLocalAgentTrack(t, false),
        delta_s: delta,
        regions: getRegionsForTrackLocal(reg, t.id)
      }));

    sendJson(res, 200, {
      at: atTs,
      at_iso: toIsoOrNullLocal(atTs),
      window_s: windowS,
      exact_tracks: exact,
      nearest_tracks: nearest
    });
    return true;
  }

  const trackGpsl0Match = urlPath.match(/^\/api\/agent\/tracks\/([^/]+)\/gpsl0$/);
  if (trackGpsl0Match && req.method === "GET") {
    const safeId = decodeURIComponent(trackGpsl0Match[1]).replace(/[^a-zA-Z0-9_.-]/g, "");
    const gpsl0Path = path.join(dataDir, "r2", "tracks-gpsl0", `${safeId}.gpsl0`);
    if (!fs.existsSync(gpsl0Path)) {
      sendJson(res, 404, { error: "Track archive not found", id: safeId });
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(fs.readFileSync(gpsl0Path));
    return true;
  }

  const trackDetailMatch = urlPath.match(/^\/api\/agent\/tracks\/([^/]+)$/);
  if (trackDetailMatch && req.method === "GET") {
    const safeId = decodeURIComponent(trackDetailMatch[1]).replace(/[^a-zA-Z0-9_.-]/g, "");
    const includeOverview = parsedUrl.searchParams.get("include_overview") === "1";
    const found = idx.tracks.find((t) => t.id === safeId);
    if (!found) {
      sendJson(res, 404, { error: "Track not found", id: safeId });
      return true;
    }
    sendJson(res, 200, {
      track: serializeLocalAgentTrack(found, includeOverview),
      regions: getRegionsForTrackLocal(reg, safeId)
    });
    return true;
  }

  sendJson(res, 404, { error: "Agent API route not found" });
  return true;
}

export function localTrackApiPlugin(frontendRoot: string): Plugin {
  const dataDir = path.join(frontendRoot, "local-data");

  const attachMiddleware = (
    middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }
  ) => {
    middlewares.use(async (req, res, next) => {
      const rawUrl = req.url || "/";
      if (!rawUrl.startsWith("/api/")) {
        next();
        return;
      }

      const parsedUrl = new URL(rawUrl, "http://localhost");
      const urlPath = parsedUrl.pathname;

      try {
        if (await handleLocalAgentApi(req, res, parsedUrl, dataDir)) {
          return;
        }

        if (urlPath === "/api/bootstrap" && req.method === "GET") {
          const idx = loadLocalIndex(dataDir);
          const reg = loadLocalRegions(dataDir);
          sendJson(res, 200, {
            stats: idx.stats,
            tracks: idx.tracks,
            regions: reg.visitedRegions
          });
          return;
        }

        if (
          urlPath.startsWith("/api/regions/tiles") &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          const parsedTileReq = parseRegionTilePath(urlPath);
          if (!parsedTileReq.ok) {
            sendJson(res, 404, { error: "Invalid region tile route" });
            return;
          }

          const pmtilesPath = path.join(
            dataDir,
            "r2",
            "regions",
            "global-regions.pmtiles"
          );
          if (!fs.existsSync(pmtilesPath)) {
            sendJson(res, 404, { error: "global-regions.pmtiles not built yet" });
            return;
          }

          if (parsedTileReq.kind === "version") {
            const stat = fs.statSync(pmtilesPath);
            const rawEtag = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=60");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end(
              JSON.stringify({
                version: archiveVersion(rawEtag),
                uploaded: stat.mtime.toISOString()
              })
            );
            return;
          }

          const source = new LocalPmtilesSource(pmtilesPath);
          const isTile = parsedTileReq.kind === "tile";
          const pm = new PMTiles(
            source,
            LOCAL_REGION_DIR_CACHE,
            isTile ? keepNodeGzipTiles : nodeDecompress
          );
          const header = await pm.getHeader();

          if (!isTile) {
            const origin = `http://${req.headers.host || "localhost:3000"}`;
            const tilejson = await pm.getTileJson(
              `${origin}/api/regions/tiles`
            );
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end(JSON.stringify(tilejson));
            return;
          }

          const [z, x, y] = parsedTileReq.tile;
          const fullUrl = new URL(
            rawUrl,
            `http://${req.headers.host || "localhost:3000"}`
          );
          const sendNoTile = async (status: number) => {
            const latest = await pm.getHeader();
            const cc = tileCacheControl(
              fullUrl,
              latest.etag ? archiveVersion(latest.etag) : undefined
            );
            res.statusCode = status;
            res.setHeader("Cache-Control", cc);
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end();
          };

          if (z < header.minZoom || z > header.maxZoom) {
            await sendNoTile(404);
            return;
          }

          const tiledata = await pm.getZxy(z, x, y);
          if (!tiledata) {
            await sendNoTile(204);
            return;
          }

          const latest = await pm.getHeader();
          const cc = tileCacheControl(
            fullUrl,
            latest.etag ? archiveVersion(latest.etag) : undefined
          );
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            latest.tileType === TileType.Mvt
              ? "application/x-protobuf"
              : "application/octet-stream"
          );
          res.setHeader("Cache-Control", cc);
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (latest.tileCompression === Compression.Gzip) {
            res.setHeader("Content-Encoding", "gzip");
          }
          if (req.method === "HEAD") {
            res.end();
          } else {
            res.end(Buffer.from(tiledata.data));
          }
          return;
        }

        if (urlPath === "/api/regions/meta" && req.method === "GET") {
          const metaGzPath = path.join(
            dataDir,
            "r2",
            "regions",
            "regions-meta.json.gz"
          );
          if (!fs.existsSync(metaGzPath)) {
            sendJson(res, 404, { error: "regions-meta.json.gz not found" });
            return;
          }
          const acceptEncoding = String(req.headers["accept-encoding"] || "");
          const gzBuf = fs.readFileSync(metaGzPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=86400");
          if (acceptEncoding.includes("gzip")) {
            res.setHeader("Content-Encoding", "gzip");
            res.end(gzBuf);
          } else {
            res.end(zlib.gunzipSync(gzBuf));
          }
          return;
        }

        if (urlPath === "/api/regions/visited" && req.method === "PUT") {
          const bodyBuf = await readRequestBody(req);
          const parsed = JSON.parse(
            bodyBuf.toString("utf8")
          ) as Partial<LocalRegionsData>;
          const prev = loadLocalRegions(dataDir);
          const next: LocalRegionsData = {
            visitedRegions: Array.isArray(parsed.visitedRegions)
              ? parsed.visitedRegions
              : prev.visitedRegions,
            trackRegions: Array.isArray(parsed.trackRegions)
              ? parsed.trackRegions
              : prev.trackRegions
          };
          saveLocalRegions(dataDir, next);
          sendJson(res, 200, { ok: true, count: next.visitedRegions.length });
          return;
        }

        if (urlPath === "/api/regions/tracks" && req.method === "GET") {
          const rawRids = parsedUrl.searchParams.get("rids") || "";
          const ridSet = new Set(
            rawRids
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n) && n > 0)
          );
          const reg = loadLocalRegions(dataDir);
          const hits = new Map<string, number>();
          for (const [rid, trackId, , , lastTs] of reg.trackRegions) {
            if (ridSet.has(rid)) {
              const prevTs = hits.get(trackId) ?? 0;
              if (lastTs >= prevTs) hits.set(trackId, lastTs);
            }
          }
          const trackIds = Array.from(hits.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id);
          sendJson(res, 200, { trackIds });
          return;
        }

        if (urlPath === "/api/fog" && req.method === "GET") {
          const fogPath = path.join(dataDir, "r2", "fog", "global-fog.bin");
          const fogGzPath = path.join(dataDir, "r2", "fog", "global-fog.bin.gz");
          const acceptEncoding = String(req.headers["accept-encoding"] || "");

          if (!fs.existsSync(fogPath)) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(EMPTY_FOG_HEADER);
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          if (acceptEncoding.includes("gzip") && fs.existsSync(fogGzPath)) {
            res.setHeader("Content-Encoding", "gzip");
            res.end(fs.readFileSync(fogGzPath));
          } else {
            res.end(fs.readFileSync(fogPath));
          }
          return;
        }

        if (urlPath === "/api/fog" && req.method === "PUT") {
          const fogBuf = await readRequestBody(req);
          if (
            fogBuf.byteLength < 16 ||
            fogBuf[0] !== 0x46 ||
            fogBuf[1] !== 0x47 ||
            fogBuf[2] !== 0x50 ||
            fogBuf[3] !== 0x31
          ) {
            sendJson(res, 400, { error: "Invalid FGP1 fog payload" });
            return;
          }
          const fogDir = path.join(dataDir, "r2", "fog");
          fs.mkdirSync(fogDir, { recursive: true });
          fs.writeFileSync(path.join(fogDir, "global-fog.bin"), fogBuf);
          fs.writeFileSync(
            path.join(fogDir, "global-fog.bin.gz"),
            zlib.gzipSync(fogBuf, { level: 9 })
          );
          const tileCount = fogBuf.readUInt32LE(8);
          const totalCells = fogBuf.readUInt32LE(12);
          const exploredAreaKm2 = Math.round(totalCells * 0.00026 * 1000) / 1000;
          const idx = loadLocalIndex(dataDir);
          idx.stats = recomputeLocalStats(
            idx.tracks,
            tileCount,
            totalCells,
            exploredAreaKm2
          );
          saveLocalIndex(dataDir, idx);
          sendJson(res, 200, {
            ok: true,
            visitedTilesZ15: tileCount,
            exploredCellsZ21: totalCells
          });
          return;
        }

        if (urlPath === "/api/tracks/all-gpsl0" && req.method === "GET") {
          const tracksDir = path.join(dataDir, "r2", "tracks-gpsl0");
          const files = fs.existsSync(tracksDir)
            ? fs.readdirSync(tracksDir).filter((f) => f.endsWith(".gpsl0")).sort()
            : [];
          const chunks: Buffer[] = [];
          const countBuf = Buffer.allocUnsafe(4);
          countBuf.writeUInt32LE(files.length, 0);
          chunks.push(countBuf);
          for (const file of files) {
            const idBuf = Buffer.from(file.replace(/\.gpsl0$/i, ""), "utf8");
            const dataBuf = fs.readFileSync(path.join(tracksDir, file));
            const hdr = Buffer.allocUnsafe(2);
            hdr.writeUInt16LE(idBuf.byteLength, 0);
            const lenBuf = Buffer.allocUnsafe(4);
            lenBuf.writeUInt32LE(dataBuf.byteLength, 0);
            chunks.push(hdr, idBuf, lenBuf, dataBuf);
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          res.end(Buffer.concat(chunks));
          return;
        }

        const gpsl0Match = urlPath.match(/^\/api\/tracks\/([^/]+)\/gpsl0$/);
        if (gpsl0Match && req.method === "GET") {
          const safeId = decodeURIComponent(gpsl0Match[1]).replace(
            /[^a-zA-Z0-9_.-]/g,
            ""
          );
          const gpsl0File = path.join(
            dataDir,
            "r2",
            "tracks-gpsl0",
            `${safeId}.gpsl0`
          );
          if (!fs.existsSync(gpsl0File)) {
            sendJson(res, 404, { error: "Track archive not found" });
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "private, max-age=86400");
          res.end(fs.readFileSync(gpsl0File));
          return;
        }

        if (urlPath === "/api/query-spatial" && req.method === "POST") {
          const bodyBuf = await readRequestBody(req);
          const parsed = JSON.parse(bodyBuf.toString("utf8")) as {
            tileKeys?: unknown[];
          };
          const keys = Array.isArray(parsed.tileKeys) ? parsed.tileKeys : [];
          const idx = loadLocalIndex(dataDir);
          const agg = new Map<string, SpatialQueryMatch>();

          for (const rawKey of keys) {
            const hits = idx.tileIndex[String(rawKey)];
            if (!hits) continue;
            for (const h of hits) {
              const prev = agg.get(h.trackId);
              if (!prev) {
                agg.set(h.trackId, {
                  trackId: h.trackId,
                  matchedPoints: h.pointCount,
                  firstTs: h.firstTs,
                  lastTs: h.lastTs
                });
              } else {
                prev.matchedPoints += h.pointCount;
                prev.firstTs = Math.min(prev.firstTs, h.firstTs);
                prev.lastTs = Math.max(prev.lastTs, h.lastTs);
              }
            }
          }

          const matches = Array.from(agg.values()).sort(
            (a, b) => b.firstTs - a.firstTs
          );
          sendJson(res, 200, { matches });
          return;
        }

        // Pure I/O ingest matching production Cloudflare Worker:
        // Accepts browser-computed `gpsl0` binary, `meta` JSON ({ track, tiles, trackRegions?, visitedRegions? }),
        // and optional updated `fog` binary.
        if (urlPath === "/api/tracks/upload" && req.method === "POST") {
          const bodyBuf = await readRequestBody(req);
          const contentType = String(req.headers["content-type"] || "");
          const webReq = new Request("http://localhost/api/tracks/upload", {
            method: "POST",
            headers: { "content-type": contentType },
            body: new Uint8Array(bodyBuf)
          });
          const form = await webReq.formData();
          const gpsl0Entry = form.get("gpsl0");
          const metaEntry = form.get("meta");
          const fogEntry = form.get("fog");

          if (!gpsl0Entry || typeof gpsl0Entry === "string") {
            sendJson(res, 400, { error: "Missing pre-encoded 'gpsl0' binary field" });
            return;
          }
          if (typeof metaEntry !== "string") {
            sendJson(res, 400, { error: "Missing 'meta' JSON payload field" });
            return;
          }

          const parsedMeta = JSON.parse(metaEntry) as UploadTrackMetaPayload;
          const rawTrack = parsedMeta?.track;
          if (!rawTrack || typeof rawTrack.id !== "string") {
            sendJson(res, 400, { error: "Invalid track metadata in 'meta'" });
            return;
          }

          const trackId = sanitizeTrackId(rawTrack.id);
          const track: TrackMetadata = {
            ...rawTrack,
            id: trackId,
            r2_key: `d1://track_blobs/${trackId}`,
            created_at: rawTrack.created_at || Math.floor(Date.now() / 1000)
          };

          const validTiles: CompactTrackTileTuple[] = Array.isArray(parsedMeta.tiles)
            ? parsedMeta.tiles.filter(
                (t): t is CompactTrackTileTuple =>
                  Array.isArray(t) &&
                  t.length === 4 &&
                  Number.isInteger(t[0]) &&
                  Number.isInteger(t[1]) &&
                  Number.isInteger(t[2]) &&
                  Number.isInteger(t[3])
              )
            : [];

          const validTrackRegions: CompactTrackRegionTuple[] = Array.isArray(
            parsedMeta.trackRegions
          )
            ? parsedMeta.trackRegions.filter(
                (t): t is CompactTrackRegionTuple =>
                  Array.isArray(t) &&
                  t.length === 4 &&
                  Number.isInteger(t[0]) &&
                  Number.isInteger(t[1]) &&
                  Number.isInteger(t[2]) &&
                  Number.isInteger(t[3])
              )
            : [];

          const tracksDir = path.join(dataDir, "r2", "tracks-gpsl0");
          const fogDir = path.join(dataDir, "r2", "fog");
          fs.mkdirSync(tracksDir, { recursive: true });
          fs.mkdirSync(fogDir, { recursive: true });

          const gpsl0Buf = Buffer.from(await (gpsl0Entry as File).arrayBuffer());
          fs.writeFileSync(path.join(tracksDir, `${trackId}.gpsl0`), gpsl0Buf);

          const idx = loadLocalIndex(dataDir);
          let tileCount = idx.stats.visitedTilesZ15;
          let totalCells = idx.stats.exploredCellsZ21;
          let exploredAreaKm2 = idx.stats.exploredAreaKm2;

          if (fogEntry && typeof fogEntry !== "string") {
            const fogBuf = Buffer.from(await (fogEntry as File).arrayBuffer());
            if (fogBuf.byteLength >= 16) {
              fs.writeFileSync(path.join(fogDir, "global-fog.bin"), fogBuf);
              fs.writeFileSync(
                path.join(fogDir, "global-fog.bin.gz"),
                zlib.gzipSync(fogBuf, { level: 9 })
              );
              tileCount = fogBuf.readUInt32LE(8);
              totalCells = fogBuf.readUInt32LE(12);
              exploredAreaKm2 = Math.round(totalCells * 0.00026 * 1000) / 1000;
            }
          }

          for (const key of Object.keys(idx.tileIndex)) {
            idx.tileIndex[key] = idx.tileIndex[key].filter(
              (h) => h.trackId !== trackId
            );
            if (idx.tileIndex[key].length === 0) {
              delete idx.tileIndex[key];
            }
          }
          for (const [tileKey, pointCount, firstTs, lastTs] of validTiles) {
            const k = String(tileKey);
            if (!idx.tileIndex[k]) idx.tileIndex[k] = [];
            idx.tileIndex[k].push({
              trackId,
              pointCount,
              firstTs,
              lastTs
            });
          }

          idx.tracks = [
            track,
            ...idx.tracks.filter((t) => t.id !== trackId)
          ].sort(
            (a, b) => b.date.localeCompare(a.date) || b.start_time - a.start_time
          );
          idx.stats = recomputeLocalStats(
            idx.tracks,
            tileCount,
            totalCells,
            exploredAreaKm2
          );
          saveLocalIndex(dataDir, idx);

          if (Array.isArray(parsedMeta.visitedRegions) || validTrackRegions.length > 0) {
            const reg = loadLocalRegions(dataDir);
            const filteredTR = reg.trackRegions.filter((r) => r[1] !== trackId);
            for (const [rid, cellCount, firstTs, lastTs] of validTrackRegions) {
              filteredTR.push([rid, trackId, cellCount, firstTs, lastTs]);
            }
            saveLocalRegions(dataDir, {
              visitedRegions: Array.isArray(parsedMeta.visitedRegions)
                ? parsedMeta.visitedRegions
                : reg.visitedRegions,
              trackRegions: filteredTR
            });
          }

          sendJson(res, 200, { ok: true, track });
          return;
        }

        const deleteMatch = urlPath.match(/^\/api\/tracks\/([^/]+)$/);
        if (deleteMatch && req.method === "DELETE") {
          const safeId = decodeURIComponent(deleteMatch[1]).replace(
            /[^a-zA-Z0-9_.-]/g,
            ""
          );
          const idx = loadLocalIndex(dataDir);
          idx.tracks = idx.tracks.filter((t) => t.id !== safeId);
          for (const key of Object.keys(idx.tileIndex)) {
            idx.tileIndex[key] = idx.tileIndex[key].filter(
              (h) => h.trackId !== safeId
            );
            if (idx.tileIndex[key].length === 0) {
              delete idx.tileIndex[key];
            }
          }
          const gpsl0Path = path.join(
            dataDir,
            "r2",
            "tracks-gpsl0",
            `${safeId}.gpsl0`
          );
          if (fs.existsSync(gpsl0Path)) fs.unlinkSync(gpsl0Path);

          idx.stats = recomputeLocalStats(
            idx.tracks,
            idx.stats.visitedTilesZ15,
            idx.stats.exploredCellsZ21,
            idx.stats.exploredAreaKm2
          );
          saveLocalIndex(dataDir, idx);

          const reg = loadLocalRegions(dataDir);
          if (reg.trackRegions.length > 0) {
            saveLocalRegions(dataDir, {
              visitedRegions: reg.visitedRegions,
              trackRegions: reg.trackRegions.filter((r) => r[1] !== safeId)
            });
          }

          sendJson(res, 200, { ok: true, deletedId: safeId });
          return;
        }

        sendJson(res, 404, { error: "API route not found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: message });
      }
    });
  };

  return {
    name: "local-track-api",
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    }
  };
}
