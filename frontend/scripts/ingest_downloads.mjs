import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  computeTrackStatsAndOverview,
  encodeGpsPointsV2,
  parseGpxXmlToPoints
} from "../src/services/gpsCodec.ts";
import {
  createEmptyFogPack,
  encodeFogPack,
  mergeTrackTilesIntoFogPack,
  rasterizeTrackToFogTiles
} from "../src/services/fogEngine.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");

const EXCLUDED_FILES = new Set([
  "Courgenay_Ballon-DAlsace.gpx",
  "VoieVerteHauteVosges.gpx",
  "fells_loop.gpx",
  "run.gpx",
  "20250508 (1).gpx",
  "20250503.gpx",
  "20250503-2.gpx",
  "20250628户外骑行.gpx"
]);

function parseArgs(argv) {
  let dir = path.join(os.homedir(), "Downloads");
  let outDir = path.join(FRONTEND_DIR, "local-data");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = path.resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    }
  }
  return { dir, outDir };
}

function sqlEscape(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function formatDateFromYmd(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function classifyTrackIdentity(fileName) {
  if (/^\d{8}\.gpx$/i.test(fileName)) {
    const ymd = fileName.slice(0, 8);
    const date = formatDateFromYmd(ymd);
    return { id: ymd, date, title: date, fallbackDate: date };
  }
  if (fileName === "20250503-2 (merged).gpx") {
    return {
      id: "20250503-merged",
      date: "2025-05-03",
      title: "2025-05-03 (Merged)",
      fallbackDate: "2025-05-03"
    };
  }
  if (fileName === "2025年5月3日_上午10_36_30.gpx") {
    return {
      id: "20250503-morning",
      date: "2025-05-03",
      title: "2025-05-03 Morning",
      fallbackDate: "2025-05-03"
    };
  }
  if (fileName === "20250628户外骑行_adjusted.gpx") {
    return {
      id: "20250628-cycling",
      date: "2025-06-28",
      title: "2025-06-28 户外骑行",
      fallbackDate: "2025-06-28"
    };
  }
  const gpsLoggerMatch = fileName.match(/^[0-9a-f]+_(\d{8})\.gpx$/i);
  if (gpsLoggerMatch) {
    const ymd = gpsLoggerMatch[1];
    const date = formatDateFromYmd(ymd);
    return {
      id: `${ymd}-android`,
      date,
      title: `${date} (GPSLogger)`,
      fallbackDate: date
    };
  }

  const base = fileName.replace(/\.gpx$/i, "");
  const safeId = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || `track-${Date.now()}`;
  const ymdMatch = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  const fallbackDate = ymdMatch
    ? `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`
    : undefined;
  return {
    id: safeId,
    date: fallbackDate ?? "1970-01-01",
    title: base,
    fallbackDate
  };
}

function main() {
  const { dir, outDir } = parseArgs(process.argv);
  if (!fs.existsSync(dir)) {
    console.error(`Source directory does not exist: ${dir}`);
    process.exit(1);
  }

  const r2TracksDir = path.join(outDir, "r2", "tracks");
  const r2FogDir = path.join(outDir, "r2", "fog");
  const d1Dir = path.join(outDir, "d1");
  fs.mkdirSync(r2TracksDir, { recursive: true });
  fs.mkdirSync(r2FogDir, { recursive: true });
  fs.mkdirSync(d1Dir, { recursive: true });

  const allFiles = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".gpx"))
    .sort();

  const tracks = [];
  const tileIndex = {};
  const d1TileRows = [];
  const fogPack = createEmptyFogPack();

  let skippedCount = 0;
  let totalRawBytes = 0;
  let totalGpzBytes = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const fileName of allFiles) {
    if (EXCLUDED_FILES.has(fileName)) {
      skippedCount++;
      continue;
    }

    const fullPath = path.join(dir, fileName);
    const stat = fs.statSync(fullPath);
    if (stat.size < 150) {
      skippedCount++;
      continue;
    }

    const identity = classifyTrackIdentity(fileName);
    const xml = fs.readFileSync(fullPath, "utf8");
    const points = parseGpxXmlToPoints(xml, identity.fallbackDate);
    if (points.length === 0) {
      skippedCount++;
      continue;
    }

    totalRawBytes += stat.size;

    const summary = computeTrackStatsAndOverview(points);
    let trackDate = identity.date;
    if (trackDate === "1970-01-01" && summary.startTime > 0) {
      trackDate = new Date((summary.startTime + 8 * 3600) * 1000)
        .toISOString()
        .slice(0, 10);
    }

    const gpzBytes = encodeGpsPointsV2(points);
    const r2Key = `tracks/${identity.id}.gpz`;
    fs.writeFileSync(path.join(r2TracksDir, `${identity.id}.gpz`), gpzBytes);
    totalGpzBytes += gpzBytes.byteLength;

    const trackTiles = rasterizeTrackToFogTiles(points);
    mergeTrackTilesIntoFogPack(fogPack, trackTiles, true);

    for (const [tileKey, t] of trackTiles.entries()) {
      const k = String(tileKey);
      if (!tileIndex[k]) tileIndex[k] = [];
      tileIndex[k].push({
        trackId: identity.id,
        pointCount: t.pointCount,
        firstTs: t.firstTs,
        lastTs: t.lastTs
      });
      d1TileRows.push([tileKey, identity.id, t.pointCount, t.firstTs, t.lastTs]);
    }

    tracks.push({
      id: identity.id,
      date: trackDate,
      title: identity.title,
      source_file: fileName,
      point_count: summary.pointCount,
      distance_m: summary.distanceM,
      duration_s: summary.durationS,
      elev_gain_m: summary.elevGainM,
      min_ele: summary.minEle,
      max_ele: summary.maxEle,
      start_time: summary.startTime,
      end_time: summary.endTime,
      min_lat: summary.minLat,
      max_lat: summary.maxLat,
      min_lon: summary.minLon,
      max_lon: summary.maxLon,
      r2_key: r2Key,
      overview_coords: summary.overviewCoords,
      created_at: nowSec
    });
  }

  tracks.sort((a, b) => b.date.localeCompare(a.date) || b.start_time - a.start_time);

  const fogBin = encodeFogPack(fogPack);
  const fogBinGz = zlib.gzipSync(fogBin, { level: 9 });
  fs.writeFileSync(path.join(r2FogDir, "global-fog.bin"), fogBin);
  fs.writeFileSync(path.join(r2FogDir, "global-fog.bin.gz"), fogBinGz);

  const dates = tracks.map((t) => t.date).sort();
  const stats = {
    trackCount: tracks.length,
    totalPoints: tracks.reduce((s, t) => s + t.point_count, 0),
    totalDistanceM: Math.round(tracks.reduce((s, t) => s + t.distance_m, 0)),
    totalDurationS: tracks.reduce((s, t) => s + t.duration_s, 0),
    totalElevGainM: Math.round(tracks.reduce((s, t) => s + t.elev_gain_m, 0)),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    visitedTilesZ15: fogPack.tileCount,
    exploredCellsZ21: fogPack.totalCells,
    exploredAreaKm2: fogPack.exploredAreaKm2
  };

  fs.writeFileSync(
    path.join(outDir, "index.json"),
    JSON.stringify({ stats, tracks, tileIndex })
  );

  // Build Cloudflare D1 seed SQL (no explicit BEGIN/COMMIT because D1 HTTP API forbids them)
  const sqlLines = [];
  for (const t of tracks) {
    sqlLines.push(
      `INSERT OR REPLACE INTO tracks (id, date, title, source_file, point_count, distance_m, duration_s, elev_gain_m, min_ele, max_ele, start_time, end_time, min_lat, max_lat, min_lon, max_lon, r2_key, overview_coords, created_at) VALUES (${[
        sqlEscape(t.id),
        sqlEscape(t.date),
        sqlEscape(t.title),
        sqlEscape(t.source_file),
        t.point_count,
        t.distance_m,
        t.duration_s,
        t.elev_gain_m,
        t.min_ele,
        t.max_ele,
        t.start_time,
        t.end_time,
        t.min_lat,
        t.max_lat,
        t.min_lon,
        t.max_lon,
        sqlEscape(t.r2_key),
        sqlEscape(JSON.stringify(t.overview_coords)),
        t.created_at
      ].join(", ")});`
    );
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < d1TileRows.length; i += BATCH_SIZE) {
    const chunk = d1TileRows.slice(i, i + BATCH_SIZE);
    const values = chunk
      .map(
        ([tileKey, trackId, pointCount, firstTs, lastTs]) =>
          `(${tileKey}, ${sqlEscape(trackId)}, ${pointCount}, ${firstTs}, ${lastTs})`
      )
      .join(", ");
    sqlLines.push(
      `INSERT OR REPLACE INTO track_tiles (tile_key, track_id, point_count, first_ts, last_ts) VALUES ${values};`
    );
  }

  fs.writeFileSync(path.join(d1Dir, "seed.sql"), sqlLines.join("\n"));

  const mb = (b) => `${(b / (1024 * 1024)).toFixed(2)} MB`;
  const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
  console.log("=== GPX Ingestion Complete ===");
  console.log(`Source Dir       : ${dir}`);
  console.log(`Output Dir       : ${outDir}`);
  console.log(`Tracks Imported  : ${tracks.length} (skipped ${skippedCount})`);
  console.log(`Total Points     : ${stats.totalPoints.toLocaleString()}`);
  console.log(`Total Distance   : ${(stats.totalDistanceM / 1000).toFixed(1)} km`);
  console.log(`Elevation Gain   : ${stats.totalElevGainM.toLocaleString()} m`);
  console.log(`Raw GPX Size     : ${mb(totalRawBytes)}`);
  console.log(`GPZ V2 Archive   : ${mb(totalGpzBytes)} (${((totalGpzBytes / Math.max(1, totalRawBytes)) * 100).toFixed(2)}% of raw XML)`);
  console.log(`Z15 Fog Tiles    : ${fogPack.tileCount.toLocaleString()}`);
  console.log(`Z21 Explored     : ${fogPack.totalCells.toLocaleString()} cells (${fogPack.exploredAreaKm2} km2)`);
  console.log(`global-fog.bin   : ${mb(fogBin.byteLength)} raw / ${kb(fogBinGz.byteLength)} gzip`);
  console.log(`D1 Index Rows    : ${d1TileRows.length.toLocaleString()} rows in d1/seed.sql`);
}

main();
