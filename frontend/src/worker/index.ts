import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
  Fetcher,
  R2Bucket
} from "@cloudflare/workers-types";

import type {
  BootstrapResponse,
  CompactTrackTileTuple,
  LonLat,
  SpatialQueryMatch,
  TrackMetadata,
  UploadTrackMetaPayload
} from "../types/track.ts";

export interface Env {
  ASSETS: Fetcher;
  TRACKS_BUCKET: R2Bucket;
  TRACKS_DB: D1Database;
}

const FOG_KEY = "fog/global-fog.bin";
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

async function handleBootstrap(env: Env): Promise<Response> {
  const { results } = await env.TRACKS_DB.prepare(
    `SELECT id, date, title, source_file, point_count, distance_m, duration_s,
            elev_gain_m, min_ele, max_ele, start_time, end_time,
            min_lat, max_lat, min_lon, max_lon, r2_key, overview_coords, created_at
     FROM tracks
     ORDER BY date DESC, start_time DESC`
  ).all<DbTrackRow>();

  const tracks = (results ?? []).map(mapDbRowToTrack);

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
    tracks
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

async function handleGetTrackGpz(env: Env, id: string): Promise<Response> {
  const safeId = decodeURIComponent(id).replace(/[^a-zA-Z0-9_.-]/g, "");
  const obj = await env.TRACKS_BUCKET.get(`tracks/${safeId}.gpz`);
  if (!obj) {
    return jsonResponse({ error: "Track archive not found" }, 404);
  }

  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
      ...(obj.httpEtag ? { ETag: obj.httpEtag } : {})
    }
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
 * GPZ V2 encoding, and Z15/Z21 fog bitmap merging are pre-computed in the browser
 * so the Cloudflare Worker stays well under free-tier CPU limits.
 */
async function handleUploadTrack(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const gpzEntry = form.get("gpz");
  const metaEntry = form.get("meta");
  const fogEntry = form.get("fog");

  if (!gpzEntry || typeof gpzEntry === "string") {
    return jsonResponse({ error: "Missing pre-encoded 'gpz' binary field" }, 400);
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
  const r2Key = `tracks/${trackId}.gpz`;
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

  const gpzBuf = await (gpzEntry as File).arrayBuffer();
  const r2Writes: Promise<unknown>[] = [
    env.TRACKS_BUCKET.put(r2Key, gpzBuf, {
      httpMetadata: { contentType: "application/octet-stream" }
    })
  ];

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
    env.TRACKS_DB.prepare(`DELETE FROM track_tiles WHERE track_id = ?`).bind(
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

  await Promise.all([...r2Writes, env.TRACKS_DB.batch(stmts)]);
  return jsonResponse({ ok: true, track });
}

async function handleDeleteTrack(env: Env, id: string): Promise<Response> {
  const safeId = decodeURIComponent(id).replace(/[^a-zA-Z0-9_.-]/g, "");
  await Promise.all([
    env.TRACKS_DB.batch([
      env.TRACKS_DB.prepare(`DELETE FROM track_tiles WHERE track_id = ?`).bind(
        safeId
      ),
      env.TRACKS_DB.prepare(`DELETE FROM tracks WHERE id = ?`).bind(safeId)
    ]),
    env.TRACKS_BUCKET.delete(`tracks/${safeId}.gpz`)
  ]);
  return jsonResponse({ ok: true, deletedId: safeId });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/api/bootstrap" && request.method === "GET") {
      return handleBootstrap(env);
    }
    if (pathname === "/api/fog" && request.method === "GET") {
      return handleGetFog(request, env);
    }
    if (pathname === "/api/query-spatial" && request.method === "POST") {
      return handleSpatialQuery(request, env);
    }
    if (pathname === "/api/tracks/upload" && request.method === "POST") {
      return handleUploadTrack(request, env);
    }

    const gpzMatch = pathname.match(/^\/api\/tracks\/([^/]+)\/gpz$/);
    if (gpzMatch && request.method === "GET") {
      return handleGetTrackGpz(env, gpzMatch[1]);
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
