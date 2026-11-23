import type {
  D1Database,
  R2Bucket
} from "@cloudflare/workers-types";

import type {
  LonLat,
  RegionLevel,
  TrackMetadata,
  VisitedRegion
} from "../types/track.ts";
import { getZ15TilesForBbox } from "../utils/coordTransform.ts";
import {
  handleAgentAuthRequest,
  jsonResponse,
  OidcAuthError,
  verifyOidcBearer,
  type OidcEnv,
  type OidcPrincipal
} from "./oidcAuth.ts";

export interface AgentApiEnv extends OidcEnv {
  TRACKS_BUCKET: R2Bucket;
  TRACKS_DB: D1Database;
}

const FOG_KEY = "fog/global-fog.bin";
const MAX_QUERY_TILES = 1600;
const MAX_RADIUS_M = 50_000;

type DbTrackRow = {
  id: string;
  date: string;
  title: string;
  source_file: string;
  point_count: number;
  distance_m: number;
  duration_s: number;
  elev_gain_m: number;
  min_ele: number;
  max_ele: number;
  start_time: number;
  end_time: number;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  r2_key: string;
  overview_coords?: string;
  created_at: number;
};

type DbVisitedRegionRow = {
  region_id: number;
  level: number;
  parent_id: number | null;
  country: string;
  name_zh: string;
  name_en: string;
  direct_child_count: number;
  leaf_child_count: number;
  lit_direct_children: number;
  lit_leaf_children: number;
  area_km2: number;
  explored_cells: number;
  explored_area_km2: number;
  visit_days: number;
  track_count: number;
  heat: number;
  first_ts: number;
  last_ts: number;
  bbox_json: string;
};

function toIsoOrNull(ts: number): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

function roundNum(val: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function parseIntParam(
  raw: string | null,
  defaultVal: number,
  minVal: number,
  maxVal: number
): number {
  if (raw === null || raw.trim() === "") return defaultVal;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultVal;
  return Math.max(minVal, Math.min(maxVal, parsed));
}

function parseFloatParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampInput(raw: string | null): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return null;
    // Handle millisecond timestamps gracefully
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function isValidDateStr(raw: string | null): raw is string {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
}

function serializeAgentTrack(
  row: DbTrackRow,
  includeOverview: boolean
): Omit<TrackMetadata, "overview_coords"> & {
  overview_coords?: LonLat[][];
  distance_km: number;
  start_iso: string | null;
  end_iso: string | null;
} {
  let overview: LonLat[][] | undefined;
  if (includeOverview && typeof row.overview_coords === "string") {
    try {
      const parsed = JSON.parse(row.overview_coords);
      overview = Array.isArray(parsed) ? parsed : [];
    } catch {
      overview = [];
    }
  }

  return {
    id: row.id,
    date: row.date,
    title: row.title,
    source_file: row.source_file,
    point_count: row.point_count,
    distance_m: row.distance_m,
    distance_km: roundNum(row.distance_m / 1000, 3),
    duration_s: row.duration_s,
    elev_gain_m: row.elev_gain_m,
    min_ele: row.min_ele,
    max_ele: row.max_ele,
    start_time: row.start_time,
    end_time: row.end_time,
    start_iso: toIsoOrNull(row.start_time),
    end_iso: toIsoOrNull(row.end_time),
    min_lat: row.min_lat,
    max_lat: row.max_lat,
    min_lon: row.min_lon,
    max_lon: row.max_lon,
    r2_key: row.r2_key,
    created_at: row.created_at,
    ...(includeOverview ? { overview_coords: overview ?? [] } : {})
  };
}

function serializeVisitedRegion(
  row: DbVisitedRegionRow
): VisitedRegion & {
  coverage_ratio: number;
  first_iso: string | null;
  last_iso: string | null;
} {
  let bbox: [number, number, number, number] = [0, 0, 0, 0];
  try {
    const parsed = JSON.parse(row.bbox_json);
    if (Array.isArray(parsed) && parsed.length === 4) {
      bbox = [
        Number(parsed[0]) || 0,
        Number(parsed[1]) || 0,
        Number(parsed[2]) || 0,
        Number(parsed[3]) || 0
      ];
    }
  } catch {
    bbox = [0, 0, 0, 0];
  }

  const coverageRatio =
    row.area_km2 > 0
      ? Math.min(1, roundNum(row.explored_area_km2 / row.area_km2, 6))
      : 0;

  return {
    rid: row.region_id,
    level: Math.max(0, Math.min(3, row.level)) as RegionLevel,
    parentRid: row.parent_id ?? null,
    country: row.country,
    nameZh: row.name_zh,
    nameEn: row.name_en,
    directChildCount: row.direct_child_count,
    leafChildCount: row.leaf_child_count,
    litDirectChildren: row.lit_direct_children,
    litLeafChildren: row.lit_leaf_children,
    areaKm2: row.area_km2,
    exploredCells: row.explored_cells,
    exploredAreaKm2: row.explored_area_km2,
    visitDays: row.visit_days,
    trackCount: row.track_count,
    heat: row.heat,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    bbox,
    coverage_ratio: coverageRatio,
    first_iso: toIsoOrNull(row.first_ts),
    last_iso: toIsoOrNull(row.last_ts)
  };
}

function toBlobBytes(raw: unknown): Uint8Array | null {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) return new Uint8Array(raw);
  return null;
}

function handleAgentMe(principal: OidcPrincipal): Response {
  return jsonResponse({
    sub: principal.sub,
    email: principal.email,
    name: principal.name,
    exp: principal.exp,
    exp_iso: toIsoOrNull(principal.exp),
    iat: principal.iat,
    iss: principal.iss,
    aud: principal.aud,
    scopes: ["tracks:read"]
  });
}

async function handleAgentStats(env: AgentApiEnv, url: URL): Promise<Response> {
  const year = url.searchParams.get("year")?.trim() ?? "";
  const month = url.searchParams.get("month")?.trim() ?? "";
  let from = url.searchParams.get("from")?.trim() ?? "";
  let to = url.searchParams.get("to")?.trim() ?? "";

  if (year && !/^\d{4}$/.test(year)) {
    return jsonResponse({ error: "year must be YYYY" }, 400);
  }
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return jsonResponse({ error: "month must be YYYY-MM" }, 400);
  }
  if (from && !isValidDateStr(from)) {
    return jsonResponse({ error: "from must be YYYY-MM-DD" }, 400);
  }
  if (to && !isValidDateStr(to)) {
    return jsonResponse({ error: "to must be YYYY-MM-DD" }, 400);
  }

  const whereParts: string[] = [];
  const params: Array<string | number> = [];

  if (month) {
    whereParts.push("date >= ? AND date <= ?");
    params.push(`${month}-01`, `${month}-31`);
  } else if (year) {
    whereParts.push("date >= ? AND date <= ?");
    params.push(`${year}-01-01`, `${year}-12-31`);
  }
  if (from) {
    whereParts.push("date >= ?");
    params.push(from);
  }
  if (to) {
    whereParts.push("date <= ?");
    params.push(to);
  }

  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const isUnfiltered = whereParts.length === 0;

  const aggRow = await env.TRACKS_DB.prepare(
    `SELECT
       COUNT(*) AS track_count,
       COALESCE(SUM(point_count), 0) AS total_points,
       COALESCE(SUM(distance_m), 0) AS total_distance_m,
       COALESCE(SUM(duration_s), 0) AS total_duration_s,
       COALESCE(SUM(elev_gain_m), 0) AS total_elev_gain_m,
       MIN(date) AS first_date,
       MAX(date) AS last_date
     FROM tracks
     ${whereSql}`
  )
    .bind(...params)
    .first<{
      track_count: number;
      total_points: number;
      total_distance_m: number;
      total_duration_s: number;
      total_elev_gain_m: number;
      first_date: string | null;
      last_date: string | null;
    }>();

  const { results: yearRows } = await env.TRACKS_DB.prepare(
    `SELECT
       substr(date, 1, 4) AS year,
       COUNT(*) AS track_count,
       COALESCE(SUM(distance_m), 0) AS distance_m,
       COALESCE(SUM(duration_s), 0) AS duration_s,
       COALESCE(SUM(elev_gain_m), 0) AS elev_gain_m,
       COALESCE(SUM(point_count), 0) AS point_count
     FROM tracks
     ${whereSql}
     GROUP BY substr(date, 1, 4)
     ORDER BY year DESC`
  )
    .bind(...params)
    .all<{
      year: string;
      track_count: number;
      distance_m: number;
      duration_s: number;
      elev_gain_m: number;
      point_count: number;
    }>();

  let fogStats: {
    visitedTilesZ15: number;
    exploredCellsZ21: number;
    exploredAreaKm2: number;
  } | null = null;

  let regionCounts: {
    l0: number;
    l1: number;
    l2: number;
    l3: number;
    total: number;
  } | null = null;

  if (isUnfiltered) {
    let visitedTilesZ15 = 0;
    let exploredCellsZ21 = 0;
    const fogHeaderObj = await env.TRACKS_BUCKET.get(FOG_KEY, {
      range: { offset: 0, length: 16 }
    });
    if (fogHeaderObj && "arrayBuffer" in fogHeaderObj) {
      const buf = await fogHeaderObj.arrayBuffer();
      if (buf.byteLength >= 16) {
        const view = new DataView(buf);
        visitedTilesZ15 = view.getUint32(8, true);
        exploredCellsZ21 = view.getUint32(12, true);
      }
    }
    fogStats = {
      visitedTilesZ15,
      exploredCellsZ21,
      exploredAreaKm2: roundNum(exploredCellsZ21 * 0.00026, 3)
    };

    try {
      const { results: regRows } = await env.TRACKS_DB.prepare(
        `SELECT level, COUNT(*) AS cnt FROM visited_regions GROUP BY level`
      ).all<{ level: number; cnt: number }>();
      const counts = { l0: 0, l1: 0, l2: 0, l3: 0, total: 0 };
      for (const r of regRows ?? []) {
        if (r.level === 0) counts.l0 = r.cnt;
        else if (r.level === 1) counts.l1 = r.cnt;
        else if (r.level === 2) counts.l2 = r.cnt;
        else if (r.level === 3) counts.l3 = r.cnt;
        counts.total += r.cnt;
      }
      regionCounts = counts;
    } catch {
      regionCounts = null;
    }
  }

  const totalDistanceM = Math.round(aggRow?.total_distance_m ?? 0);
  const totalElevGainM = Math.round(aggRow?.total_elev_gain_m ?? 0);

  return jsonResponse({
    filter: {
      year: year || null,
      month: month || null,
      from: from || null,
      to: to || null
    },
    stats: {
      trackCount: aggRow?.track_count ?? 0,
      totalPoints: aggRow?.total_points ?? 0,
      totalDistanceM,
      totalDistanceKm: roundNum(totalDistanceM / 1000, 3),
      totalDurationS: aggRow?.total_duration_s ?? 0,
      totalElevGainM,
      firstDate: aggRow?.first_date ?? null,
      lastDate: aggRow?.last_date ?? null,
      ...(fogStats ?? {})
    },
    ...(regionCounts ? { visitedRegionCounts: regionCounts } : {}),
    byYear: (yearRows ?? []).map((r) => ({
      year: r.year,
      trackCount: r.track_count,
      distanceM: Math.round(r.distance_m),
      distanceKm: roundNum(r.distance_m / 1000, 3),
      durationS: r.duration_s,
      elevGainM: Math.round(r.elev_gain_m),
      pointCount: r.point_count
    }))
  });
}

async function handleAgentTracksList(
  env: AgentApiEnv,
  url: URL
): Promise<Response> {
  const from = url.searchParams.get("from")?.trim() ?? "";
  const to = url.searchParams.get("to")?.trim() ?? "";
  const regionIdRaw = url.searchParams.get("region_id")?.trim() ?? "";
  const regionName = url.searchParams.get("region")?.trim() ?? "";
  const country = url.searchParams.get("country")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const minDistanceM = parseFloatParam(url.searchParams.get("min_distance_m"));
  const maxDistanceM = parseFloatParam(url.searchParams.get("max_distance_m"));
  const sort = url.searchParams.get("sort")?.trim() || "date_desc";
  const limit = parseIntParam(url.searchParams.get("limit"), 20, 1, 100);
  const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, 100_000);
  const includeOverview = url.searchParams.get("include_overview") === "1";

  if (from && !isValidDateStr(from)) {
    return jsonResponse({ error: "from must be YYYY-MM-DD" }, 400);
  }
  if (to && !isValidDateStr(to)) {
    return jsonResponse({ error: "to must be YYYY-MM-DD" }, 400);
  }

  const whereParts: string[] = [];
  const params: Array<string | number> = [];

  if (from) {
    whereParts.push("t.date >= ?");
    params.push(from);
  }
  if (to) {
    whereParts.push("t.date <= ?");
    params.push(to);
  }
  if (minDistanceM !== null) {
    whereParts.push("t.distance_m >= ?");
    params.push(minDistanceM);
  }
  if (maxDistanceM !== null) {
    whereParts.push("t.distance_m <= ?");
    params.push(maxDistanceM);
  }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    whereParts.push(
      "(LOWER(t.title) LIKE ? OR LOWER(t.id) LIKE ? OR LOWER(t.source_file) LIKE ?)"
    );
    params.push(like, like, like);
  }
  if (regionIdRaw) {
    const rid = Number.parseInt(regionIdRaw, 10);
    if (!Number.isInteger(rid) || rid <= 0) {
      return jsonResponse({ error: "region_id must be a positive integer" }, 400);
    }
    whereParts.push(
      "EXISTS (SELECT 1 FROM track_regions tr WHERE tr.track_id = t.id AND tr.region_id = ?)"
    );
    params.push(rid);
  }
  if (regionName) {
    const like = `%${regionName.toLowerCase()}%`;
    whereParts.push(
      `EXISTS (
         SELECT 1
         FROM track_regions tr
         JOIN visited_regions vr ON vr.region_id = tr.region_id
         WHERE tr.track_id = t.id
           AND (LOWER(vr.name_zh) LIKE ? OR LOWER(vr.name_en) LIKE ?)
       )`
    );
    params.push(like, like);
  }
  if (country) {
    whereParts.push(
      `EXISTS (
         SELECT 1
         FROM track_regions tr
         JOIN visited_regions vr ON vr.region_id = tr.region_id
         WHERE tr.track_id = t.id
           AND UPPER(vr.country) = UPPER(?)
       )`
    );
    params.push(country);
  }

  let orderBySql = "t.date DESC, t.start_time DESC";
  switch (sort) {
    case "date_asc":
      orderBySql = "t.date ASC, t.start_time ASC";
      break;
    case "distance_desc":
      orderBySql = "t.distance_m DESC, t.date DESC";
      break;
    case "distance_asc":
      orderBySql = "t.distance_m ASC, t.date DESC";
      break;
    case "duration_desc":
      orderBySql = "t.duration_s DESC, t.date DESC";
      break;
    case "duration_asc":
      orderBySql = "t.duration_s ASC, t.date DESC";
      break;
    case "elev_desc":
      orderBySql = "t.elev_gain_m DESC, t.date DESC";
      break;
    case "elev_asc":
      orderBySql = "t.elev_gain_m ASC, t.date DESC";
      break;
    case "date_desc":
    default:
      orderBySql = "t.date DESC, t.start_time DESC";
      break;
  }

  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const countRow = await env.TRACKS_DB.prepare(
    `SELECT COUNT(*) AS cnt FROM tracks t ${whereSql}`
  )
    .bind(...params)
    .first<{ cnt: number }>();

  const overviewCol = includeOverview ? ", t.overview_coords" : "";
  const { results } = await env.TRACKS_DB.prepare(
    `SELECT t.id, t.date, t.title, t.source_file, t.point_count, t.distance_m,
            t.duration_s, t.elev_gain_m, t.min_ele, t.max_ele, t.start_time,
            t.end_time, t.min_lat, t.max_lat, t.min_lon, t.max_lon,
            t.r2_key, t.created_at${overviewCol}
     FROM tracks t
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<DbTrackRow>();

  const total = countRow?.cnt ?? 0;
  const tracks = (results ?? []).map((row) =>
    serializeAgentTrack(row, includeOverview)
  );

  return jsonResponse({
    total,
    limit,
    offset,
    truncated: offset + tracks.length < total,
    tracks
  });
}

async function fetchTrackRegionsForTrack(
  db: D1Database,
  trackId: string
): Promise<
  Array<{
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
  }>
> {
  try {
    const { results } = await db
      .prepare(
        `SELECT vr.region_id, vr.level, vr.parent_id, vr.country, vr.name_zh,
                vr.name_en, tr.cell_count, tr.first_ts, tr.last_ts
         FROM track_regions tr
         JOIN visited_regions vr ON vr.region_id = tr.region_id
         WHERE tr.track_id = ?
         ORDER BY vr.level ASC, tr.cell_count DESC`
      )
      .bind(trackId)
      .all<{
        region_id: number;
        level: number;
        parent_id: number | null;
        country: string;
        name_zh: string;
        name_en: string;
        cell_count: number;
        first_ts: number;
        last_ts: number;
      }>();

    return (results ?? []).map((r) => ({
      rid: r.region_id,
      level: r.level,
      parentRid: r.parent_id ?? null,
      country: r.country,
      nameZh: r.name_zh,
      nameEn: r.name_en,
      cellCount: r.cell_count,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      first_iso: toIsoOrNull(r.first_ts),
      last_iso: toIsoOrNull(r.last_ts)
    }));
  } catch {
    return [];
  }
}

async function handleAgentTrackDetail(
  env: AgentApiEnv,
  rawId: string,
  url: URL
): Promise<Response> {
  const safeId = decodeURIComponent(rawId).replace(/[^a-zA-Z0-9_.-]/g, "");
  const includeOverview = url.searchParams.get("include_overview") === "1";
  const overviewCol = includeOverview ? ", overview_coords" : "";

  const row = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, created_at${overviewCol}
     FROM tracks
     WHERE id = ?`
  )
    .bind(safeId)
    .first<DbTrackRow>();

  if (!row) {
    return jsonResponse({ error: "Track not found", id: safeId }, 404);
  }

  const regions = await fetchTrackRegionsForTrack(env.TRACKS_DB, safeId);
  return jsonResponse({
    track: serializeAgentTrack(row, includeOverview),
    regions
  });
}

async function handleAgentTrackGpsl0(
  env: AgentApiEnv,
  rawId: string
): Promise<Response> {
  const safeId = decodeURIComponent(rawId).replace(/[^a-zA-Z0-9_.-]/g, "");
  const row = await env.TRACKS_DB.prepare(
    `SELECT data FROM track_blobs WHERE track_id = ?`
  )
    .bind(safeId)
    .first<{ data: unknown }>();

  const bytes = toBlobBytes(row?.data);
  if (!bytes) {
    return jsonResponse({ error: "Track archive not found", id: safeId }, 404);
  }

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=86400"
    }
  });
}

async function handleAgentRegionsList(
  env: AgentApiEnv,
  url: URL
): Promise<Response> {
  const levelRaw = url.searchParams.get("level")?.trim() ?? "";
  const country = url.searchParams.get("country")?.trim() ?? "";
  const parentIdRaw = url.searchParams.get("parent_id")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const sort = url.searchParams.get("sort")?.trim() || "heat";
  const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200);
  const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, 100_000);

  const whereParts: string[] = [];
  const params: Array<string | number> = [];

  if (levelRaw !== "") {
    const level = Number.parseInt(levelRaw, 10);
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      return jsonResponse({ error: "level must be 0, 1, 2, or 3" }, 400);
    }
    whereParts.push("level = ?");
    params.push(level);
  }
  if (country) {
    whereParts.push("UPPER(country) = UPPER(?)");
    params.push(country);
  }
  if (parentIdRaw !== "") {
    const pid = Number.parseInt(parentIdRaw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return jsonResponse({ error: "parent_id must be a positive integer" }, 400);
    }
    whereParts.push("parent_id = ?");
    params.push(pid);
  }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    whereParts.push("(LOWER(name_zh) LIKE ? OR LOWER(name_en) LIKE ?)");
    params.push(like, like);
  }

  let orderBySql = "heat DESC, explored_area_km2 DESC";
  switch (sort) {
    case "visit_days":
      orderBySql = "visit_days DESC, heat DESC";
      break;
    case "explored_area":
      orderBySql = "explored_area_km2 DESC, heat DESC";
      break;
    case "last_ts":
      orderBySql = "last_ts DESC, heat DESC";
      break;
    case "track_count":
      orderBySql = "track_count DESC, heat DESC";
      break;
    case "heat":
    default:
      orderBySql = "heat DESC, explored_area_km2 DESC";
      break;
  }

  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const countRow = await env.TRACKS_DB.prepare(
    `SELECT COUNT(*) AS cnt FROM visited_regions ${whereSql}`
  )
    .bind(...params)
    .first<{ cnt: number }>();

  const { results } = await env.TRACKS_DB.prepare(
    `SELECT region_id, level, parent_id, country, name_zh, name_en,
            direct_child_count, leaf_child_count, lit_direct_children,
            lit_leaf_children, area_km2, explored_cells, explored_area_km2,
            visit_days, track_count, heat, first_ts, last_ts, bbox_json
     FROM visited_regions
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<DbVisitedRegionRow>();

  const total = countRow?.cnt ?? 0;
  const regions = (results ?? []).map(serializeVisitedRegion);

  return jsonResponse({
    total,
    limit,
    offset,
    truncated: offset + regions.length < total,
    regions
  });
}

async function handleAgentRegionDetail(
  env: AgentApiEnv,
  rawRid: string,
  url: URL
): Promise<Response> {
  const rid = Number.parseInt(rawRid, 10);
  if (!Number.isInteger(rid) || rid <= 0) {
    return jsonResponse({ error: "Invalid region id" }, 400);
  }

  const limit = parseIntParam(url.searchParams.get("limit"), 20, 1, 100);
  const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, 100_000);

  const row = await env.TRACKS_DB.prepare(
    `SELECT region_id, level, parent_id, country, name_zh, name_en,
            direct_child_count, leaf_child_count, lit_direct_children,
            lit_leaf_children, area_km2, explored_cells, explored_area_km2,
            visit_days, track_count, heat, first_ts, last_ts, bbox_json
     FROM visited_regions
     WHERE region_id = ?`
  )
    .bind(rid)
    .first<DbVisitedRegionRow>();

  if (!row) {
    return jsonResponse({ error: "Visited region not found", rid }, 404);
  }

  const region = serializeVisitedRegion(row);

  // Walk up parent chain (at most 4 levels: L3 -> L2 -> L1 -> L0)
  const ancestors: Array<ReturnType<typeof serializeVisitedRegion>> = [];
  let curParent = region.parentRid;
  let guard = 0;
  while (curParent !== null && guard < 4) {
    guard++;
    const pRow = await env.TRACKS_DB.prepare(
      `SELECT region_id, level, parent_id, country, name_zh, name_en,
              direct_child_count, leaf_child_count, lit_direct_children,
              lit_leaf_children, area_km2, explored_cells, explored_area_km2,
              visit_days, track_count, heat, first_ts, last_ts, bbox_json
       FROM visited_regions
       WHERE region_id = ?`
    )
      .bind(curParent)
      .first<DbVisitedRegionRow>();
    if (!pRow) break;
    const mapped = serializeVisitedRegion(pRow);
    ancestors.unshift(mapped);
    curParent = mapped.parentRid;
  }

  const { results: childRows } = await env.TRACKS_DB.prepare(
    `SELECT region_id, level, parent_id, country, name_zh, name_en,
            direct_child_count, leaf_child_count, lit_direct_children,
            lit_leaf_children, area_km2, explored_cells, explored_area_km2,
            visit_days, track_count, heat, first_ts, last_ts, bbox_json
     FROM visited_regions
     WHERE parent_id = ?
     ORDER BY heat DESC, explored_area_km2 DESC`
  )
    .bind(rid)
    .all<DbVisitedRegionRow>();

  const countRow = await env.TRACKS_DB.prepare(
    `SELECT COUNT(*) AS cnt FROM track_regions WHERE region_id = ?`
  )
    .bind(rid)
    .first<{ cnt: number }>();

  const { results: trackRows } = await env.TRACKS_DB.prepare(
    `SELECT t.id, t.date, t.title, t.source_file, t.point_count, t.distance_m,
            t.duration_s, t.elev_gain_m, t.min_ele, t.max_ele, t.start_time,
            t.end_time, t.min_lat, t.max_lat, t.min_lon, t.max_lon,
            t.r2_key, t.created_at, tr.cell_count AS region_cell_count,
            tr.first_ts AS region_first_ts, tr.last_ts AS region_last_ts
     FROM track_regions tr
     JOIN tracks t ON t.id = tr.track_id
     WHERE tr.region_id = ?
     ORDER BY t.date DESC, t.start_time DESC
     LIMIT ? OFFSET ?`
  )
    .bind(rid, limit, offset)
    .all<
      DbTrackRow & {
        region_cell_count: number;
        region_first_ts: number;
        region_last_ts: number;
      }
    >();

  const totalTracks = countRow?.cnt ?? 0;
  const tracks = (trackRows ?? []).map((trRow) => ({
    ...serializeAgentTrack(trRow, false),
    regionCellCount: trRow.region_cell_count,
    regionFirstTs: trRow.region_first_ts,
    regionLastTs: trRow.region_last_ts,
    regionFirstIso: toIsoOrNull(trRow.region_first_ts),
    regionLastIso: toIsoOrNull(trRow.region_last_ts)
  }));

  return jsonResponse({
    region,
    ancestors,
    children: (childRows ?? []).map(serializeVisitedRegion),
    tracksTotal: totalTracks,
    tracksTruncated: offset + tracks.length < totalTracks,
    tracks
  });
}

async function fetchTrackMapByIds(
  db: D1Database,
  ids: string[],
  from?: string,
  to?: string
): Promise<Map<string, ReturnType<typeof serializeAgentTrack>>> {
  const map = new Map<string, ReturnType<typeof serializeAgentTrack>>();
  if (ids.length === 0) return map;

  const CHUNK = 80;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const whereParts = [`id IN (${placeholders})`];
    const params: Array<string | number> = [...chunk];

    if (from) {
      whereParts.push("date >= ?");
      params.push(from);
    }
    if (to) {
      whereParts.push("date <= ?");
      params.push(to);
    }

    const { results } = await db
      .prepare(
        `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
                elev_gain_m, min_ele, max_ele, start_time, end_time,
                min_lat, max_lat, min_lon, max_lon, r2_key, created_at
         FROM tracks
         WHERE ${whereParts.join(" AND ")}`
      )
      .bind(...params)
      .all<DbTrackRow>();

    for (const row of results ?? []) {
      map.set(row.id, serializeAgentTrack(row, false));
    }
  }
  return map;
}

async function handleAgentSpatialNearby(
  request: Request,
  env: AgentApiEnv
): Promise<Response> {
  let body: {
    lat?: unknown;
    lon?: unknown;
    radius_m?: unknown;
    min_lat?: unknown;
    min_lon?: unknown;
    max_lat?: unknown;
    max_lon?: unknown;
    from?: unknown;
    to?: unknown;
    limit?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (from && !isValidDateStr(from)) {
    return jsonResponse({ error: "from must be YYYY-MM-DD" }, 400);
  }
  if (to && !isValidDateStr(to)) {
    return jsonResponse({ error: "to must be YYYY-MM-DD" }, 400);
  }

  const limitRaw = Number(body.limit);
  const limit = Number.isInteger(limitRaw)
    ? Math.max(1, Math.min(100, limitRaw))
    : 20;

  let minLat: number;
  let minLon: number;
  let maxLat: number;
  let maxLon: number;
  let querySpec: Record<string, unknown>;

  if (
    typeof body.lat === "number" &&
    Number.isFinite(body.lat) &&
    typeof body.lon === "number" &&
    Number.isFinite(body.lon)
  ) {
    const lat = body.lat;
    const lon = body.lon;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return jsonResponse({ error: "lat/lon out of range" }, 400);
    }
    const rawRadius =
      typeof body.radius_m === "number" && Number.isFinite(body.radius_m)
        ? body.radius_m
        : 500;
    const radiusM = Math.max(10, Math.min(MAX_RADIUS_M, rawRadius));
    const dLat = radiusM / 111_320;
    const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    const dLon = radiusM / (111_320 * cosLat);
    minLat = Math.max(-85.0511, lat - dLat);
    maxLat = Math.min(85.0511, lat + dLat);
    minLon = Math.max(-180, lon - dLon);
    maxLon = Math.min(180, lon + dLon);
    querySpec = { type: "radius", lat, lon, radius_m: radiusM, bbox: [minLon, minLat, maxLon, maxLat] };
  } else if (
    typeof body.min_lat === "number" &&
    typeof body.min_lon === "number" &&
    typeof body.max_lat === "number" &&
    typeof body.max_lon === "number" &&
    Number.isFinite(body.min_lat) &&
    Number.isFinite(body.min_lon) &&
    Number.isFinite(body.max_lat) &&
    Number.isFinite(body.max_lon)
  ) {
    minLat = Math.min(body.min_lat, body.max_lat);
    maxLat = Math.max(body.min_lat, body.max_lat);
    minLon = Math.min(body.min_lon, body.max_lon);
    maxLon = Math.max(body.min_lon, body.max_lon);
    querySpec = { type: "bbox", bbox: [minLon, minLat, maxLon, maxLat] };
  } else {
    return jsonResponse(
      { error: "Provide { lat, lon, radius_m? } or { min_lat, min_lon, max_lat, max_lon }" },
      400
    );
  }

  const tileKeys = getZ15TilesForBbox(minLat, minLon, maxLat, maxLon, 15);
  if (tileKeys.length > 0 && tileKeys.length <= MAX_QUERY_TILES) {
    const agg = new Map<
      string,
      { trackId: string; matchedPoints: number; firstTs: number; lastTs: number }
    >();
    const CHUNK = 80;
    for (let i = 0; i < tileKeys.length; i += CHUNK) {
      const chunk = tileKeys.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const { results } = await env.TRACKS_DB.prepare(
        `SELECT track_id, SUM(point_count) AS matched_points,
                MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
         FROM track_tiles
         WHERE tile_key IN (${placeholders})
         GROUP BY track_id`
      )
        .bind(...chunk)
        .all<{
          track_id: string;
          matched_points: number;
          first_ts: number;
          last_ts: number;
        }>();

      for (const row of results ?? []) {
        const prev = agg.get(row.track_id);
        if (!prev) {
          agg.set(row.track_id, {
            trackId: row.track_id,
            matchedPoints: row.matched_points,
            firstTs: row.first_ts,
            lastTs: row.last_ts
          });
        } else {
          prev.matchedPoints += row.matched_points;
          prev.firstTs = Math.min(prev.firstTs, row.first_ts);
          prev.lastTs = Math.max(prev.lastTs, row.last_ts);
        }
      }
    }

    const sortedAgg = Array.from(agg.values()).sort(
      (a, b) => b.firstTs - a.firstTs
    );
    const trackMap = await fetchTrackMapByIds(
      env.TRACKS_DB,
      sortedAgg.map((m) => m.trackId),
      from || undefined,
      to || undefined
    );

    const filtered = sortedAgg
      .filter((m) => trackMap.has(m.trackId))
      .map((m) => ({
        trackId: m.trackId,
        matchedPoints: m.matchedPoints,
        firstTs: m.firstTs,
        lastTs: m.lastTs,
        first_iso: toIsoOrNull(m.firstTs),
        last_iso: toIsoOrNull(m.lastTs),
        track: trackMap.get(m.trackId)!
      }));

    return jsonResponse({
      query: querySpec,
      mode: "z15_tiles",
      tileCount: tileKeys.length,
      total: filtered.length,
      truncated: filtered.length > limit,
      matches: filtered.slice(0, limit)
    });
  }

  // Fallback for large bboxes (>1600 Z15 tiles): bounding box intersection on tracks
  const whereParts = [
    "max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?"
  ];
  const params: Array<string | number> = [minLat, maxLat, minLon, maxLon];
  if (from) {
    whereParts.push("date >= ?");
    params.push(from);
  }
  if (to) {
    whereParts.push("date <= ?");
    params.push(to);
  }

  const countRow = await env.TRACKS_DB.prepare(
    `SELECT COUNT(*) AS cnt FROM tracks WHERE ${whereParts.join(" AND ")}`
  )
    .bind(...params)
    .first<{ cnt: number }>();

  const { results } = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, created_at
     FROM tracks
     WHERE ${whereParts.join(" AND ")}
     ORDER BY date DESC, start_time DESC
     LIMIT ?`
  )
    .bind(...params, limit)
    .all<DbTrackRow>();

  const total = countRow?.cnt ?? 0;
  const matches = (results ?? []).map((row) => ({
    trackId: row.id,
    matchedPoints: row.point_count,
    firstTs: row.start_time,
    lastTs: row.end_time,
    first_iso: toIsoOrNull(row.start_time),
    last_iso: toIsoOrNull(row.end_time),
    track: serializeAgentTrack(row, false)
  }));

  return jsonResponse({
    query: querySpec,
    mode: "bbox",
    tileCount: tileKeys.length,
    total,
    truncated: matches.length < total,
    matches
  });
}

async function handleAgentWhere(env: AgentApiEnv, url: URL): Promise<Response> {
  const atRaw = url.searchParams.get("at");
  const atTs = parseTimestampInput(atRaw);
  if (atTs === null) {
    return jsonResponse(
      { error: "Query param 'at' is required (Unix seconds or ISO-8601 timestamp)" },
      400
    );
  }
  const windowS = parseIntParam(url.searchParams.get("window_s"), 86400, 60, 604800);

  const { results: exactRows } = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, created_at
     FROM tracks
     WHERE start_time <= ? AND end_time >= ?
     ORDER BY start_time DESC
     LIMIT 10`
  )
    .bind(atTs, atTs)
    .all<DbTrackRow>();

  const exactTracks = await Promise.all(
    (exactRows ?? []).map(async (row) => ({
      track: serializeAgentTrack(row, false),
      delta_s: 0,
      regions: await fetchTrackRegionsForTrack(env.TRACKS_DB, row.id)
    }))
  );

  const minWindow = atTs - windowS;
  const maxWindow = atTs + windowS;
  const { results: nearbyRows } = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, created_at,
            CASE
              WHEN ? < start_time THEN start_time - ?
              WHEN ? > end_time THEN ? - end_time
              ELSE 0
            END AS delta_s
     FROM tracks
     WHERE end_time >= ? AND start_time <= ?
       AND NOT (start_time <= ? AND end_time >= ?)
     ORDER BY delta_s ASC
     LIMIT 5`
  )
    .bind(atTs, atTs, atTs, atTs, minWindow, maxWindow, atTs, atTs)
    .all<DbTrackRow & { delta_s: number }>();

  const nearestTracks = await Promise.all(
    (nearbyRows ?? []).map(async (row) => ({
      track: serializeAgentTrack(row, false),
      delta_s: row.delta_s,
      regions: await fetchTrackRegionsForTrack(env.TRACKS_DB, row.id)
    }))
  );

  return jsonResponse({
    at: atTs,
    at_iso: toIsoOrNull(atTs),
    window_s: windowS,
    exact_tracks: exactTracks,
    nearest_tracks: nearestTracks
  });
}

export async function handleAgentRequest(
  request: Request,
  env: AgentApiEnv,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/agent")) {
    return null;
  }

  // Public OIDC metadata and Device Flow endpoints (auth happens inside OIDC)
  if (url.pathname.startsWith("/api/agent/auth/")) {
    const authResp = await handleAgentAuthRequest(request, env, url);
    if (authResp) return authResp;
    return jsonResponse({ error: "Agent auth route not found" }, 404);
  }

  let principal: OidcPrincipal;
  try {
    principal = await verifyOidcBearer(request, env);
  } catch (err) {
    if (err instanceof OidcAuthError) {
      const headers: Record<string, string> = {};
      if (err.status === 401) {
        headers["WWW-Authenticate"] = `Bearer error="${err.code}"`;
      }
      return jsonResponse(
        { error: err.code, message: err.message },
        err.status,
        headers
      );
    }
    return jsonResponse({ error: "unauthorized", message: "Authentication failed" }, 401);
  }

  const pathname = url.pathname;

  if (pathname === "/api/agent/me" && request.method === "GET") {
    return handleAgentMe(principal);
  }
  if (pathname === "/api/agent/stats" && request.method === "GET") {
    return handleAgentStats(env, url);
  }
  if (pathname === "/api/agent/tracks" && request.method === "GET") {
    return handleAgentTracksList(env, url);
  }
  if (pathname === "/api/agent/regions" && request.method === "GET") {
    return handleAgentRegionsList(env, url);
  }
  if (pathname === "/api/agent/spatial/nearby" && request.method === "POST") {
    return handleAgentSpatialNearby(request, env);
  }
  if (pathname === "/api/agent/where" && request.method === "GET") {
    return handleAgentWhere(env, url);
  }

  const regionMatch = pathname.match(/^\/api\/agent\/regions\/(\d+)$/);
  if (regionMatch && request.method === "GET") {
    return handleAgentRegionDetail(env, regionMatch[1], url);
  }

  const trackGpsl0Match = pathname.match(/^\/api\/agent\/tracks\/([^/]+)\/gpsl0$/);
  if (trackGpsl0Match && request.method === "GET") {
    return handleAgentTrackGpsl0(env, trackGpsl0Match[1]);
  }

  const trackDetailMatch = pathname.match(/^\/api\/agent\/tracks\/([^/]+)$/);
  if (trackDetailMatch && request.method === "GET") {
    return handleAgentTrackDetail(env, trackDetailMatch[1], url);
  }

  return jsonResponse({ error: "Agent API route not found" }, 404);
}
