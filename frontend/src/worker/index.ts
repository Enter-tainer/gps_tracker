import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
  Fetcher,
  R2Bucket
} from "@cloudflare/workers-types";

import type {
  BootstrapResponse,
  CompactTrackRegionTuple,
  CompactTrackTileTuple,
  LonLat,
  RegionLevel,
  SpatialQueryMatch,
  TrackMetadata,
  UploadTrackMetaPayload,
  VisitedRegion
} from "../types/track.ts";
import { handleAgentRequest } from "./agentApi.ts";
import type { OidcEnv } from "./oidcAuth.ts";
import { handleRegionTileRequest } from "./regionTiles.ts";

export interface Env extends OidcEnv {
  ASSETS: Fetcher;
  TRACKS_BUCKET: R2Bucket;
  TRACKS_DB: D1Database;
}

const FOG_KEY = "fog/global-fog.bin";
const REGIONS_META_KEY = "regions/regions-meta.json.gz";
const MAX_QUERY_TILES = 1600;
// Static 16-byte empty FGP1 header ("FGP1", version=1, tileCount=0, totalCells=0)
const EMPTY_FOG_HEADER = new Uint8Array([
  0x46, 0x47, 0x50, 0x31,
  1, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0
]);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function sanitizeTrackId(raw: string): string {
  const cleaned = raw
    .replace(/\.(gpx|gpz)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `track-${Date.now()}`;
}

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
  overview_coords: string;
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

function mapDbRowToTrack(row: DbTrackRow): TrackMetadata {
  let overview: LonLat[][] = [];
  try {
    const parsed = JSON.parse(row.overview_coords);
    if (Array.isArray(parsed)) {
      overview = parsed;
    }
  } catch {
    overview = [];
  }
  return {
    ...row,
    overview_coords: overview
  };
}

function mapDbRowToVisitedRegion(row: DbVisitedRegionRow): VisitedRegion {
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
    bbox
  };
}

function appendVisitedRegionUpserts(
  stmts: D1PreparedStatement[],
  db: D1Database,
  regions: VisitedRegion[],
  replaceAll: boolean
): void {
  if (replaceAll) {
    stmts.push(db.prepare(`DELETE FROM visited_regions`));
  }
  // 5 rows * 19 params = 95 < 100 D1 param limit
  const BATCH = 5;
  for (let i = 0; i < regions.length; i += BATCH) {
    const chunk = regions.slice(i, i + BATCH);
    const placeholders = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const params: Array<string | number | null> = [];
    for (const r of chunk) {
      params.push(
        r.rid,
        r.level,
        r.parentRid,
        r.country,
        r.nameZh,
        r.nameEn,
        r.directChildCount,
        r.leafChildCount,
        r.litDirectChildren,
        r.litLeafChildren,
        r.areaKm2,
        r.exploredCells,
        r.exploredAreaKm2,
        r.visitDays,
        r.trackCount,
        r.heat,
        r.firstTs,
        r.lastTs,
        JSON.stringify(r.bbox ?? [0, 0, 0, 0])
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO visited_regions (
            region_id, level, parent_id, country, name_zh, name_en,
            direct_child_count, leaf_child_count, lit_direct_children, lit_leaf_children,
            area_km2, explored_cells, explored_area_km2, visit_days, track_count,
            heat, first_ts, last_ts, bbox_json
          ) VALUES ${placeholders}`
        )
        .bind(...params)
    );
  }
}

async function handleBootstrap(env: Env): Promise<Response> {
  const { results } = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, overview_coords, created_at
     FROM tracks
     ORDER BY date DESC, start_time DESC`
  ).all<DbTrackRow>();

  const tracks = (results ?? []).map(mapDbRowToTrack);

  let regions: VisitedRegion[] = [];
  try {
    const regionQuery = await env.TRACKS_DB.prepare(
      `SELECT region_id, level, parent_id, country, name_zh, name_en,
              direct_child_count, leaf_child_count, lit_direct_children, lit_leaf_children,
              area_km2, explored_cells, explored_area_km2, visit_days, track_count,
              heat, first_ts, last_ts, bbox_json
       FROM visited_regions
       ORDER BY level ASC, heat DESC, explored_area_km2 DESC`
    ).all<DbVisitedRegionRow>();
    regions = (regionQuery.results ?? []).map(mapDbRowToVisitedRegion);
  } catch {
    regions = [];
  }

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

  const dates = tracks.map((t) => t.date).sort();
  const payload: BootstrapResponse = {
    stats: {
      trackCount: tracks.length,
      totalPoints: tracks.reduce((s, t) => s + t.point_count, 0),
      totalDistanceM: Math.round(tracks.reduce((s, t) => s + t.distance_m, 0)),
      totalDurationS: tracks.reduce((s, t) => s + t.duration_s, 0),
      totalElevGainM: Math.round(tracks.reduce((s, t) => s + t.elev_gain_m, 0)),
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      visitedTilesZ15,
      exploredCellsZ21,
      exploredAreaKm2: Math.round(exploredCellsZ21 * 0.00026 * 1000) / 1000
    },
    tracks,
    regions
  };

  return jsonResponse(payload);
}

async function handleGetFog(request: Request, env: Env): Promise<Response> {
  const obj = await env.TRACKS_BUCKET.get(FOG_KEY);
  if (!obj) {
    return new Response(EMPTY_FOG_HEADER, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store"
      }
    });
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && obj.httpEtag && ifNoneMatch === obj.httpEtag) {
    return new Response(null, { status: 304 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "private, max-age=300"
  };
  if (obj.httpEtag) {
    headers["ETag"] = obj.httpEtag;
  }

  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  if (acceptEncoding.includes("gzip") && typeof CompressionStream !== "undefined") {
    const compressed = obj.body.pipeThrough(
      new CompressionStream("gzip") as unknown as Parameters<
        typeof obj.body.pipeThrough
      >[0]
    );
    headers["Content-Encoding"] = "gzip";
    return new Response(compressed as unknown as BodyInit, {
      headers,
      encodeBody: "manual"
    } as ResponseInit);
  }

  return new Response(obj.body as unknown as BodyInit, { headers });
}

async function handleGetRegionsMeta(
  request: Request,
  env: Env
): Promise<Response> {
  const obj = await env.TRACKS_BUCKET.get(REGIONS_META_KEY);
  if (!obj) {
    return jsonResponse({ error: "regions-meta.json.gz not found" }, 404);
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && obj.httpEtag && ifNoneMatch === obj.httpEtag) {
    return new Response(null, { status: 304 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400"
  };
  if (obj.httpEtag) headers["ETag"] = obj.httpEtag;

  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  if (acceptEncoding.includes("gzip")) {
    headers["Content-Encoding"] = "gzip";
    return new Response(obj.body as unknown as BodyInit, {
      headers,
      encodeBody: "manual"
    } as ResponseInit);
  }

  if (typeof DecompressionStream !== "undefined") {
    const decompressed = obj.body.pipeThrough(
      new DecompressionStream("gzip") as unknown as Parameters<
        typeof obj.body.pipeThrough
      >[0]
    );
    return new Response(decompressed as unknown as BodyInit, { headers });
  }

  headers["Content-Encoding"] = "gzip";
  return new Response(obj.body as unknown as BodyInit, {
    headers,
    encodeBody: "manual"
  } as ResponseInit);
}

async function handlePutVisitedRegions(
  request: Request,
  env: Env
): Promise<Response> {
  let body: {
    visitedRegions?: VisitedRegion[];
    trackRegions?: Array<[number, string, number, number, number]>;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const visitedRegions = Array.isArray(body.visitedRegions)
    ? body.visitedRegions
    : [];
  const stmts: D1PreparedStatement[] = [];
  appendVisitedRegionUpserts(stmts, env.TRACKS_DB, visitedRegions, true);

  if (Array.isArray(body.trackRegions)) {
    stmts.push(env.TRACKS_DB.prepare(`DELETE FROM track_regions`));
    const TR_BATCH = 15; // 15 * 5 = 75 < 100 params
    for (let i = 0; i < body.trackRegions.length; i += TR_BATCH) {
      const chunk = body.trackRegions.slice(i, i + TR_BATCH);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const params: Array<string | number> = [];
      for (const [rid, trackId, cellCount, firstTs, lastTs] of chunk) {
        params.push(rid, trackId, cellCount, firstTs, lastTs);
      }
      stmts.push(
        env.TRACKS_DB.prepare(
          `INSERT OR REPLACE INTO track_regions (region_id, track_id, cell_count, first_ts, last_ts)
           VALUES ${placeholders}`
        ).bind(...params)
      );
    }
  }

  // Execute in D1 batch slices so large payloads never exceed D1 statement-per-batch caps
  const STMT_SLICE = 80;
  for (let i = 0; i < stmts.length; i += STMT_SLICE) {
    await env.TRACKS_DB.batch(stmts.slice(i, i + STMT_SLICE));
  }

  return jsonResponse({ ok: true, count: visitedRegions.length });
}

async function handleGetRegionTracks(env: Env, url: URL): Promise<Response> {
  const rawRids = url.searchParams.get("rids") || "";
  const rids = Array.from(
    new Set(
      rawRids
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ).slice(0, 80);

  if (rids.length === 0) {
    return jsonResponse({ trackIds: [] });
  }

  const placeholders = rids.map(() => "?").join(", ");
  const { results } = await env.TRACKS_DB.prepare(
    `SELECT DISTINCT track_id
     FROM track_regions
     WHERE region_id IN (${placeholders})
     ORDER BY last_ts DESC`
  )
    .bind(...rids)
    .all<{ track_id: string }>();

  return jsonResponse({
    trackIds: (results ?? []).map((r) => r.track_id)
  });
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

async function handleGetTrackGpsl0(env: Env, id: string): Promise<Response> {
  const safeId = decodeURIComponent(id).replace(/[^a-zA-Z0-9_.-]/g, "");
  const row = await env.TRACKS_DB.prepare(
    `SELECT data FROM track_blobs WHERE track_id = ?`
  )
    .bind(safeId)
    .first<{ data: unknown }>();

  const bytes = toBlobBytes(row?.data);
  if (!bytes) {
    return jsonResponse({ error: "Track archive not found" }, 404);
  }

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=86400"
    }
  });
}

async function handleGetAllTracksGpsl0(env: Env): Promise<Response> {
  const { results } = await env.TRACKS_DB.prepare(
    `SELECT track_id, data FROM track_blobs ORDER BY track_id ASC`
  ).all<{ track_id: string; data: unknown }>();

  const encoder = new TextEncoder();
  const entries: Array<{ idBytes: Uint8Array; dataBytes: Uint8Array }> = [];
  let totalBytes = 4;

  for (const row of results ?? []) {
    const dataBytes = toBlobBytes(row.data);
    if (!dataBytes) continue;
    const idBytes = encoder.encode(row.track_id);
    entries.push({ idBytes, dataBytes });
    totalBytes += 2 + idBytes.byteLength + 4 + dataBytes.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, entries.length, true);
  let offset = 4;
  for (const { idBytes, dataBytes } of entries) {
    view.setUint16(offset, idBytes.byteLength, true);
    offset += 2;
    out.set(idBytes, offset);
    offset += idBytes.byteLength;
    view.setUint32(offset, dataBytes.byteLength, true);
    offset += 4;
    out.set(dataBytes, offset);
    offset += dataBytes.byteLength;
  }

  return new Response(out as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store"
    }
  });
}

async function handlePutFog(request: Request, env: Env): Promise<Response> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 16) {
    return jsonResponse({ error: "Invalid fog binary payload" }, 400);
  }
  const view = new DataView(buf);
  if (
    view.getUint8(0) !== 0x46 ||
    view.getUint8(1) !== 0x47 ||
    view.getUint8(2) !== 0x50 ||
    view.getUint8(3) !== 0x31
  ) {
    return jsonResponse({ error: "Invalid FGP1 magic header" }, 400);
  }

  await env.TRACKS_BUCKET.put(FOG_KEY, buf, {
    httpMetadata: { contentType: "application/octet-stream" }
  });

  return jsonResponse({
    ok: true,
    visitedTilesZ15: view.getUint32(8, true),
    exploredCellsZ21: view.getUint32(12, true)
  });
}

async function handleSpatialQuery(request: Request, env: Env): Promise<Response> {
  let body: { tileKeys?: unknown };
  try {
    body = (await request.json()) as { tileKeys?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawKeys = Array.isArray(body.tileKeys) ? body.tileKeys : [];
  const uniqueKeys = Array.from(
    new Set(
      rawKeys
        .map((k) => Number(k))
        .filter((k) => Number.isInteger(k) && k >= 0)
    )
  ).slice(0, MAX_QUERY_TILES);

  if (uniqueKeys.length === 0) {
    return jsonResponse({ matches: [] });
  }

  const agg = new Map<string, SpatialQueryMatch>();
  // D1 caps bound SQL parameters around 100 per statement
  const CHUNK_SIZE = 80;

  for (let i = 0; i < uniqueKeys.length; i += CHUNK_SIZE) {
    const chunk = uniqueKeys.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const stmt = env.TRACKS_DB.prepare(
      `SELECT track_id, SUM(point_count) AS matched_points,
              MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
       FROM track_tiles
       WHERE tile_key IN (${placeholders})
       GROUP BY track_id`
    ).bind(...chunk);

    const { results } = await stmt.all<{
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

  const matches = Array.from(agg.values()).sort(
    (a, b) => b.firstTs - a.firstTs
  );
  return jsonResponse({ matches });
}

/**
 * Pure I/O ingest endpoint: all GPX/GPZ decoding, RDP simplification,
 * GPSL0 encoding, and Z15/Z21 fog bitmap merging are pre-computed in the browser
 * so the Cloudflare Worker stays well under free-tier CPU limits.
 * Track binaries (GPSL0) are stored atomically in D1 `track_blobs`.
 */
async function handleUploadTrack(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const gpsl0Entry = form.get("gpsl0");
  const metaEntry = form.get("meta");
  const fogEntry = form.get("fog");

  if (!gpsl0Entry || typeof gpsl0Entry === "string") {
    return jsonResponse({ error: "Missing pre-encoded 'gpsl0' binary field" }, 400);
  }
  if (typeof metaEntry !== "string") {
    return jsonResponse({ error: "Missing 'meta' JSON payload field" }, 400);
  }

  let parsedMeta: UploadTrackMetaPayload;
  try {
    parsedMeta = JSON.parse(metaEntry) as UploadTrackMetaPayload;
  } catch {
    return jsonResponse({ error: "Invalid 'meta' JSON payload" }, 400);
  }

  const rawTrack = parsedMeta?.track;
  if (!rawTrack || typeof rawTrack.id !== "string") {
    return jsonResponse({ error: "Invalid track metadata in 'meta'" }, 400);
  }

  const trackId = sanitizeTrackId(rawTrack.id);
  const r2Key = `d1://track_blobs/${trackId}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const track: TrackMetadata = {
    ...rawTrack,
    id: trackId,
    r2_key: r2Key,
    created_at: rawTrack.created_at || nowSec
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

  const gpsl0Buf = new Uint8Array(await (gpsl0Entry as File).arrayBuffer());
  const r2Writes: Promise<unknown>[] = [];

  if (fogEntry && typeof fogEntry !== "string") {
    const fogBuf = await (fogEntry as File).arrayBuffer();
    if (fogBuf.byteLength >= 16) {
      r2Writes.push(
        env.TRACKS_BUCKET.put(FOG_KEY, fogBuf, {
          httpMetadata: { contentType: "application/octet-stream" }
        })
      );
    }
  }

  const stmts: D1PreparedStatement[] = [
    env.TRACKS_DB.prepare(
      `INSERT OR REPLACE INTO tracks (
        id, date, title, source_file, point_count, distance_m, duration_s,
        elev_gain_m, min_ele, max_ele, start_time, end_time,
        min_lat, max_lat, min_lon, max_lon, r2_key, overview_coords, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      track.id,
      track.date,
      track.title,
      track.source_file,
      track.point_count,
      track.distance_m,
      track.duration_s,
      track.elev_gain_m,
      track.min_ele,
      track.max_ele,
      track.start_time,
      track.end_time,
      track.min_lat,
      track.max_lat,
      track.min_lon,
      track.max_lon,
      track.r2_key,
      JSON.stringify(track.overview_coords ?? []),
      track.created_at
    ),
    env.TRACKS_DB.prepare(
      `INSERT OR REPLACE INTO track_blobs (track_id, data) VALUES (?, ?)`
    ).bind(track.id, gpsl0Buf),
    env.TRACKS_DB.prepare(`DELETE FROM track_tiles WHERE track_id = ?`).bind(
      track.id
    ),
    env.TRACKS_DB.prepare(`DELETE FROM track_regions WHERE track_id = ?`).bind(
      track.id
    )
  ];

  const TILE_BATCH = 15; // 15 rows * 5 bindings = 75 < 100 D1 param limit
  for (let i = 0; i < validTiles.length; i += TILE_BATCH) {
    const chunk = validTiles.slice(i, i + TILE_BATCH);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params: Array<string | number> = [];
    for (const [tileKey, pointCount, firstTs, lastTs] of chunk) {
      params.push(tileKey, track.id, pointCount, firstTs, lastTs);
    }
    stmts.push(
      env.TRACKS_DB.prepare(
        `INSERT OR REPLACE INTO track_tiles (tile_key, track_id, point_count, first_ts, last_ts)
         VALUES ${placeholders}`
      ).bind(...params)
    );
  }

  for (let i = 0; i < validTrackRegions.length; i += TILE_BATCH) {
    const chunk = validTrackRegions.slice(i, i + TILE_BATCH);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params: Array<string | number> = [];
    for (const [rid, cellCount, firstTs, lastTs] of chunk) {
      params.push(rid, track.id, cellCount, firstTs, lastTs);
    }
    stmts.push(
      env.TRACKS_DB.prepare(
        `INSERT OR REPLACE INTO track_regions (region_id, track_id, cell_count, first_ts, last_ts)
         VALUES ${placeholders}`
      ).bind(...params)
    );
  }

  if (Array.isArray(parsedMeta.visitedRegions)) {
    appendVisitedRegionUpserts(
      stmts,
      env.TRACKS_DB,
      parsedMeta.visitedRegions,
      true
    );
  }

  const STMT_SLICE = 80;
  await Promise.all([
    ...r2Writes,
    (async () => {
      for (let i = 0; i < stmts.length; i += STMT_SLICE) {
        await env.TRACKS_DB.batch(stmts.slice(i, i + STMT_SLICE));
      }
    })()
  ]);

  return jsonResponse({ ok: true, track });
}

async function handleDeleteTrack(env: Env, id: string): Promise<Response> {
  const safeId = decodeURIComponent(id).replace(/[^a-zA-Z0-9_.-]/g, "");
  await env.TRACKS_DB.batch([
    env.TRACKS_DB.prepare(`DELETE FROM track_tiles WHERE track_id = ?`).bind(
      safeId
    ),
    env.TRACKS_DB.prepare(`DELETE FROM track_regions WHERE track_id = ?`).bind(
      safeId
    ),
    env.TRACKS_DB.prepare(`DELETE FROM track_blobs WHERE track_id = ?`).bind(
      safeId
    ),
    env.TRACKS_DB.prepare(`DELETE FROM tracks WHERE id = ?`).bind(safeId)
  ]);
  return jsonResponse({ ok: true, deletedId: safeId });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/agent")) {
      const agentResp = await handleAgentRequest(request, env, url);
      if (agentResp) return agentResp;
    }

    if (pathname === "/api/bootstrap" && request.method === "GET") {
      return handleBootstrap(env);
    }
    if (pathname === "/api/fog" && request.method === "GET") {
      return handleGetFog(request, env);
    }
    if (pathname === "/api/fog" && request.method === "PUT") {
      return handlePutFog(request, env);
    }
    if (pathname.startsWith("/api/regions/tiles")) {
      const tileResp = await handleRegionTileRequest(
        request,
        env.TRACKS_BUCKET,
        ctx
      );
      if (tileResp) return tileResp;
    }
    if (pathname === "/api/regions/meta" && request.method === "GET") {
      return handleGetRegionsMeta(request, env);
    }
    if (pathname === "/api/regions/visited" && request.method === "PUT") {
      return handlePutVisitedRegions(request, env);
    }
    if (pathname === "/api/regions/tracks" && request.method === "GET") {
      return handleGetRegionTracks(env, url);
    }
    if (pathname === "/api/query-spatial" && request.method === "POST") {
      return handleSpatialQuery(request, env);
    }
    if (pathname === "/api/tracks/all-gpsl0" && request.method === "GET") {
      return handleGetAllTracksGpsl0(env);
    }
    if (pathname === "/api/tracks/upload" && request.method === "POST") {
      return handleUploadTrack(request, env);
    }

    const gpsl0Match = pathname.match(/^\/api\/tracks\/([^/]+)\/gpsl0$/);
    if (gpsl0Match && request.method === "GET") {
      return handleGetTrackGpsl0(env, gpsl0Match[1]);
    }

    const deleteMatch = pathname.match(/^\/api\/tracks\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
      return handleDeleteTrack(env, deleteMatch[1]);
    }

    if (pathname.startsWith("/api/")) {
      return jsonResponse({ error: "API route not found" }, 404);
    }

    return env.ASSETS.fetch(
      request as unknown as Parameters<Fetcher["fetch"]>[0]
    ) as unknown as Promise<Response>;
  }
};
