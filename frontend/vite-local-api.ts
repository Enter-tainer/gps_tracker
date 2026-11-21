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
