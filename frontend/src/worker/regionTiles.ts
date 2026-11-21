import type { ExecutionContext, R2Bucket } from "@cloudflare/workers-types";
import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  TileType,
  type RangeResponse,
  type Source
} from "pmtiles";

const REGIONS_PMTILES_KEY = "regions/global-regions.pmtiles";

const TILE_RE = /^\/api\/regions\/tiles\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.mvt$/;
const TILEJSON_RE = /^\/api\/regions\/tiles\.json$/;
const VERSION_RE = /^\/api\/regions\/tiles\/version$/;

type ParsedRegionTilePath =
  | { ok: true; kind: "tile"; tile: [number, number, number] }
  | { ok: true; kind: "tilejson" }
  | { ok: true; kind: "version" }
  | { ok: false };

export function parseRegionTilePath(pathname: string): ParsedRegionTilePath {
  const tileMatch = pathname.match(TILE_RE);
  if (tileMatch?.groups) {
    return {
      ok: true,
      kind: "tile",
      tile: [+tileMatch.groups.z, +tileMatch.groups.x, +tileMatch.groups.y]
    };
  }
  if (VERSION_RE.test(pathname)) {
    return { ok: true, kind: "version" };
  }
  if (TILEJSON_RE.test(pathname)) {
    return { ok: true, kind: "tilejson" };
  }
  return { ok: false };
}

export function archiveVersion(etag: string): string {
  return etag.replace(/[^0-9a-zA-Z]/g, "").slice(0, 12);
}

// Versioned URLs (?v=<archiveVersion>) match an exact archive upload and are cached
// as immutable for 1 year; mismatched or unversioned URLs stay short-lived.
export function tileCacheControl(url: URL, current?: string): string {
  const asked = url.searchParams.get("v");
  if (asked === null) return "public, max-age=86400";
  if (current !== undefined && asked !== current) return "public, max-age=300";
  return "public, max-age=31536000, immutable";
}

export async function nativeDecompress(
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
    const stream = new Response(buf).body;
    if (!stream) throw new Error("Unable to read gzip stream");
    const result = stream.pipeThrough(
      new DecompressionStream("gzip") as unknown as Parameters<
        typeof stream.pipeThrough
      >[0]
    );
    return new Response(result).arrayBuffer();
  }
  throw new Error(`Compression method not supported: ${compression}`);
}

async function keepGzipTiles(
  buf: ArrayBuffer,
  compression: Compression
): Promise<ArrayBuffer> {
  return compression === Compression.Gzip
    ? buf
    : nativeDecompress(buf, compression);
}

class R2RegionSource implements Source {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  getKey(): string {
    return REGIONS_PMTILES_KEY;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    const resp = await this.bucket.get(REGIONS_PMTILES_KEY, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined
    });
    if (!resp) {
      throw new Error(`Archive not found: ${REGIONS_PMTILES_KEY}`);
    }
    if (!("body" in resp) || !resp.body || !("arrayBuffer" in resp)) {
      throw new EtagMismatch(`Archive changed: ${REGIONS_PMTILES_KEY}`);
    }
    const data = await resp.arrayBuffer();
    return {
      data,
      etag: resp.etag,
      cacheControl: resp.httpMetadata?.cacheControl,
      expires: resp.httpMetadata?.cacheExpiry?.toISOString()
    };
  }
}

const REGION_DIRECTORY_CACHE = new ResolvedValueCache(
  25,
  undefined,
  nativeDecompress
);

const CONTENT_TYPES: Partial<Record<TileType, string>> = {
  [TileType.Mvt]: "application/x-protobuf",
  [TileType.Png]: "image/png",
  [TileType.Jpeg]: "image/jpeg",
  [TileType.Webp]: "image/webp"
};

function gzipTileResponse(
  body: BodyInit | null,
  init: { status?: number; headers: HeadersInit }
): Response {
  return new Response(body, {
    ...init,
    encodeBody: "manual"
  } as ResponseInit);
}

function passThroughEncoded(cached: Response): Response {
  if (!cached.headers.has("Content-Encoding")) return cached;
  return gzipTileResponse(cached.body, {
    status: cached.status,
    headers: cached.headers
  });
}

async function handleVersion(bucket: R2Bucket): Promise<Response> {
  const object = await bucket.head(REGIONS_PMTILES_KEY);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  };
  if (!object) {
    return new Response(
      JSON.stringify({ error: "global-regions.pmtiles not found" }),
      { status: 404, headers }
    );
  }
  return new Response(
    JSON.stringify({
      version: archiveVersion(object.etag),
      uploaded: object.uploaded.toISOString()
    }),
    {
      headers: {
        ...headers,
        "Cache-Control": "public, max-age=60"
      }
    }
  );
}

export async function handleRegionTileRequest(
  request: Request,
  bucket: R2Bucket,
  ctx: ExecutionContext
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const parsed = parseRegionTilePath(url.pathname);
  if (!parsed.ok) return null;

  if (parsed.kind === "version") {
    return handleVersion(bucket);
  }

  const edgeCache = (caches as unknown as { default?: Cache }).default;
  if (edgeCache && request.method === "GET") {
    const cached = await edgeCache.match(request.url);
    if (cached) return passThroughEncoded(cached);
  }

  const source = new R2RegionSource(bucket);
  const isTile = parsed.kind === "tile";
  const pmtiles = new PMTiles(
    source,
    REGION_DIRECTORY_CACHE,
    isTile ? keepGzipTiles : nativeDecompress
  );

  let header;
  try {
    header = await pmtiles.getHeader();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("Archive not found") ? 404 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  if (!isTile) {
    const tilejson = await pmtiles.getTileJson(
      `${url.origin}/api/regions/tiles`
    );
    const resp = new Response(JSON.stringify(tilejson), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      }
    });
    if (edgeCache && request.method === "GET") {
      ctx.waitUntil(edgeCache.put(request.url, resp.clone()));
    }
    return resp;
  }

  const [z, x, y] = parsed.tile;
  const resolveCaching = async () => {
    const latest = await pmtiles.getHeader();
    const cacheControl = tileCacheControl(
      url,
      latest.etag ? archiveVersion(latest.etag) : undefined
    );
    const keep =
      cacheControl.includes("immutable") || !url.searchParams.has("v");
    return { latest, cacheControl, keep };
  };

  const noTile = async (status: number) =>
    new Response(null, {
      status,
      headers: {
        "Cache-Control": (await resolveCaching()).cacheControl,
        "Access-Control-Allow-Origin": "*"
      }
    });

  if (z < header.minZoom || z > header.maxZoom) {
    return noTile(404);
  }

  const tiledata = await pmtiles.getZxy(z, x, y);
  if (!tiledata) {
    return noTile(204);
  }

  const { latest, cacheControl, keep } = await resolveCaching();
  const contentType =
    CONTENT_TYPES[latest.tileType] || "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Access-Control-Allow-Origin": "*"
  };
  if (latest.tileCompression === Compression.Gzip) {
    headers["Content-Encoding"] = "gzip";
  }

  const bodyBytes = request.method === "HEAD" ? null : tiledata.data;
  if (edgeCache && keep && request.method === "GET") {
    ctx.waitUntil(
      edgeCache.put(request.url, gzipTileResponse(tiledata.data, { headers }))
    );
  }
  return gzipTileResponse(bodyBytes, { headers });
}
