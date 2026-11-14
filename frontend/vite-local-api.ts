import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

import type {
  BootstrapStats,
  CompactTrackTileTuple,
  SpatialQueryMatch,
  TrackMetadata,
  UploadTrackMetaPayload
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

      const urlPath = rawUrl.split("?")[0];

      try {
        if (urlPath === "/api/bootstrap" && req.method === "GET") {
          const idx = loadLocalIndex(dataDir);
          sendJson(res, 200, { stats: idx.stats, tracks: idx.tracks });
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

        const gpzMatch = urlPath.match(/^\/api\/tracks\/([^/]+)\/gpz$/);
        if (gpzMatch && req.method === "GET") {
          const safeId = decodeURIComponent(gpzMatch[1]).replace(
            /[^a-zA-Z0-9_.-]/g,
            ""
          );
          const gpzFile = path.join(
            dataDir,
            "r2",
            "tracks",
            `${safeId}.gpz`
          );
          if (!fs.existsSync(gpzFile)) {
            sendJson(res, 404, { error: "Track archive not found" });
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "private, max-age=86400");
          res.end(fs.readFileSync(gpzFile));
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
        // Accepts browser-computed `gpz` binary, `meta` JSON ({ track, tiles }),
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
          const gpzEntry = form.get("gpz");
          const metaEntry = form.get("meta");
          const fogEntry = form.get("fog");

          if (!gpzEntry || typeof gpzEntry === "string") {
            sendJson(res, 400, { error: "Missing pre-encoded 'gpz' binary field" });
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
            r2_key: `tracks/${trackId}.gpz`,
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

          const tracksDir = path.join(dataDir, "r2", "tracks");
          const fogDir = path.join(dataDir, "r2", "fog");
          fs.mkdirSync(tracksDir, { recursive: true });
          fs.mkdirSync(fogDir, { recursive: true });

          const gpzBuf = Buffer.from(await (gpzEntry as File).arrayBuffer());
          fs.writeFileSync(path.join(tracksDir, `${trackId}.gpz`), gpzBuf);

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
          const gpzPath = path.join(dataDir, "r2", "tracks", `${safeId}.gpz`);
          if (fs.existsSync(gpzPath)) fs.unlinkSync(gpzPath);

          idx.stats = recomputeLocalStats(
            idx.tracks,
            idx.stats.visitedTilesZ15,
            idx.stats.exploredCellsZ21,
            idx.stats.exploredAreaKm2
          );
          saveLocalIndex(dataDir, idx);
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
