import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodeFogPack, FOG_CELL_ZOOM, FOG_TILE_ZOOM } from "../src/services/fogEngine.ts";
import {
  computeHierarchicalVisitedRegions,
  decodeCompactRegionsMeta
} from "../src/services/regionEngine.ts";
import {
  cellAreaKm2AtTileY,
  decodeTileKey,
  tileXYToLatLon
} from "../src/utils/coordTransform.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let dataDir = path.join(FRONTEND_DIR, "local-data");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--data" && argv[i + 1]) {
      dataDir = path.resolve(argv[++i]);
    }
  }
  return { dataDir };
}

function toDuckPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

function sqlEscape(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function main() {
  const { dataDir } = parseArgs(process.argv);
  const indexPath = path.join(dataDir, "index.json");
  const fogPath = path.join(dataDir, "r2", "fog", "global-fog.bin");
  const metaGzPath = path.join(dataDir, "r2", "regions", "regions-meta.json.gz");
  const parquetPath = path.join(dataDir, "regions-build", "overture_divisions.parquet");
  const ridLayersPath = path.join(dataDir, "regions-build", "rid_layers.json");

  for (const reqPath of [indexPath, fogPath, metaGzPath, parquetPath, ridLayersPath]) {
    if (!fs.existsSync(reqPath)) {
      console.error(`Missing required file: ${reqPath}`);
      process.exit(1);
    }
  }

  const indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const fogBuf = fs.readFileSync(fogPath);
  const fogPack = decodeFogPack(fogBuf);
  const metaJson = JSON.parse(zlib.gunzipSync(fs.readFileSync(metaGzPath)).toString("utf8"));
  const metaMap = decodeCompactRegionsMeta(metaJson);

  console.log(
    `Loaded ${fogPack.tiles.size} Z15 fog tiles, ${indexData.tracks.length} tracks, and ${metaMap.size} global regions.`
  );

  const buildDir = path.join(dataDir, "regions-build");
  const tilesJsonPath = path.join(buildDir, "_fog_tiles.json");
  const tileRidsPath = path.join(buildDir, "_fog_tile_rids.json");
  const sqlTempPath = path.join(buildDir, "_ingest_query.sql");

  const tileRows = [];
  for (const tile of fogPack.tiles.values()) {
    const [lat, lon] = tileXYToLatLon(tile.tx + 0.5, tile.ty + 0.5, FOG_TILE_ZOOM);
    tileRows.push(
      JSON.stringify({
        tile_key: tile.tileKey,
        lon: Math.round(lon * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6
      })
    );
  }
  fs.writeFileSync(tilesJsonPath, `${tileRows.join("\n")}\n`, "utf8");

  console.log("Running DuckDB spatial join against global leaf divisions...");
  fs.writeFileSync(
    sqlTempPath,
    `
LOAD spatial;

CREATE TEMP TABLE fog_tiles AS
  SELECT * FROM read_json_auto('${toDuckPath(tilesJsonPath)}');

CREATE TEMP TABLE leaf_polys AS
  SELECT m.rid, m.b[1] AS xmin, m.b[2] AS ymin, m.b[3] AS xmax, m.b[4] AS ymax, o.geometry
  FROM read_parquet('${toDuckPath(parquetPath)}') o
  JOIN read_json_auto('${toDuckPath(ridLayersPath)}') m
    ON o.division_id = m.division_id
  WHERE m.in_l3 = true;

CREATE TEMP TABLE exact_hits AS
  SELECT DISTINCT ON (t.tile_key)
    t.tile_key,
    l.rid
  FROM fog_tiles t
  JOIN leaf_polys l
    ON t.lon >= l.xmin AND t.lon <= l.xmax
   AND t.lat >= l.ymin AND t.lat <= l.ymax
   AND ST_Intersects(l.geometry, ST_Point(t.lon, t.lat))
  ORDER BY t.tile_key, l.rid;

CREATE TEMP TABLE unmatched AS
  SELECT t.tile_key, t.lon, t.lat
  FROM fog_tiles t
  LEFT JOIN exact_hits e ON t.tile_key = e.tile_key
  WHERE e.tile_key IS NULL;

-- Coastal fallback (~1.2 km buffer) for bridges / seawalls / shoreline GPS points
CREATE TEMP TABLE coastal_hits AS
  SELECT DISTINCT ON (u.tile_key)
    u.tile_key,
    l.rid
  FROM unmatched u
  JOIN leaf_polys l
    ON u.lon >= l.xmin - 0.015 AND u.lon <= l.xmax + 0.015
   AND u.lat >= l.ymin - 0.015 AND u.lat <= l.ymax + 0.015
   AND ST_DWithin(l.geometry, ST_Point(u.lon, u.lat), 0.012)
  ORDER BY u.tile_key, ST_Distance(l.geometry, ST_Point(u.lon, u.lat)) ASC;

COPY (
  SELECT tile_key, rid FROM exact_hits
  UNION ALL
  SELECT tile_key, rid FROM coastal_hits
) TO '${toDuckPath(tileRidsPath)}' (FORMAT JSON);
`,
    "utf8"
  );

  execFileSync("duckdb", ["-bail", "-c", `.read '${toDuckPath(sqlTempPath)}'`], {
    cwd: FRONTEND_DIR,
    stdio: "inherit"
  });

  const tileKeyToRid = new Map();
  const hitLines = fs
    .readFileSync(tileRidsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  for (const line of hitLines) {
    const { tile_key, rid } = JSON.parse(line);
    tileKeyToRid.set(Number(tile_key), Number(rid));
  }

  for (const tmp of [tilesJsonPath, tileRidsPath, sqlTempPath]) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  console.log(
    `Matched ${tileKeyToRid.size} / ${fogPack.tiles.size} Z15 tiles to global leaf regions.`
  );

  const trackDateById = new Map();
  for (const t of indexData.tracks) {
    trackDateById.set(t.id, t.date);
  }

  const leafHits = new Map();
  const trackRegionAgg = new Map(); // `${rid}:${trackId}` -> { rid, trackId, cellCount, firstTs, lastTs }

  for (const tile of fogPack.tiles.values()) {
    const rid = tileKeyToRid.get(tile.tileKey);
    if (!rid) continue;

    const [, ty] = decodeTileKey(tile.tileKey);
    const tileAreaKm2 =
      tile.cellCount * cellAreaKm2AtTileY(ty, FOG_CELL_ZOOM, FOG_TILE_ZOOM);

    let hit = leafHits.get(rid);
    if (!hit) {
      hit = {
        rid,
        exploredCells: 0,
        exploredAreaKm2: 0,
        dates: new Set(),
        trackIds: new Set(),
        firstTs: Number.POSITIVE_INFINITY,
        lastTs: 0
      };
      leafHits.set(rid, hit);
    }

    hit.exploredCells += tile.cellCount;
    hit.exploredAreaKm2 += tileAreaKm2;

    const tileTrackHits = indexData.tileIndex?.[String(tile.tileKey)] ?? [];
    for (const th of tileTrackHits) {
      hit.trackIds.add(th.trackId);
      const dateStr = trackDateById.get(th.trackId);
      if (dateStr) hit.dates.add(dateStr);
      if (th.firstTs > 0 && th.firstTs < hit.firstTs) hit.firstTs = th.firstTs;
      if (th.lastTs > hit.lastTs) hit.lastTs = th.lastTs;

      // Record track -> region mapping across leaf and all ancestors
      let currRid = rid;
      const seen = new Set();
      while (currRid !== null && !seen.has(currRid)) {
        seen.add(currRid);
        const key = `${currRid}:${th.trackId}`;
        let agg = trackRegionAgg.get(key);
        if (!agg) {
          agg = {
            rid: currRid,
            trackId: th.trackId,
            cellCount: 0,
            firstTs: Number.POSITIVE_INFINITY,
            lastTs: 0
          };
          trackRegionAgg.set(key, agg);
        }
        agg.cellCount += Math.max(1, Number(th.pointCount || 1));
        if (th.firstTs > 0 && th.firstTs < agg.firstTs) agg.firstTs = th.firstTs;
        if (th.lastTs > agg.lastTs) agg.lastTs = th.lastTs;
        currRid = metaMap.get(currRid)?.parentRid ?? null;
      }
    }
  }

  const visitedRegions = computeHierarchicalVisitedRegions(leafHits, metaMap);
  const trackRegions = Array.from(trackRegionAgg.values()).map((r) => [
    r.rid,
    r.trackId,
    r.cellCount,
    Number.isFinite(r.firstTs) ? r.firstTs : 0,
    r.lastTs
  ]);

  const outJsonPath = path.join(dataDir, "regions-visited.json");
  fs.writeFileSync(
    outJsonPath,
    JSON.stringify({ visitedRegions, trackRegions }),
    "utf8"
  );

  // Emit D1 seed_regions.sql
  const d1Dir = path.join(dataDir, "d1");
  fs.mkdirSync(d1Dir, { recursive: true });
  const seedSqlPath = path.join(d1Dir, "seed_regions.sql");
  const sqlLines = [
    "DELETE FROM track_regions;",
    "DELETE FROM visited_regions;"
  ];

  const REGION_BATCH = 25;
  for (let i = 0; i < visitedRegions.length; i += REGION_BATCH) {
    const chunk = visitedRegions.slice(i, i + REGION_BATCH);
    const values = chunk.map(
      (r) =>
        `(${r.rid}, ${r.level}, ${r.parentRid === null ? "NULL" : r.parentRid}, ${sqlEscape(
          r.country
        )}, ${sqlEscape(r.nameZh)}, ${sqlEscape(r.nameEn)}, ${r.directChildCount}, ${
          r.leafChildCount
        }, ${r.litDirectChildren}, ${r.litLeafChildren}, ${r.areaKm2}, ${
          r.exploredCells
        }, ${r.exploredAreaKm2}, ${r.visitDays}, ${r.trackCount}, ${r.heat}, ${
          r.firstTs
        }, ${r.lastTs}, ${sqlEscape(JSON.stringify(r.bbox))})`
    );
    sqlLines.push(
      `INSERT INTO visited_regions (region_id, level, parent_id, country, name_zh, name_en, direct_child_count, leaf_child_count, lit_direct_children, lit_leaf_children, area_km2, explored_cells, explored_area_km2, visit_days, track_count, heat, first_ts, last_ts, bbox_json) VALUES\n  ${values.join(
        ",\n  "
      )};`
    );
  }

  const TR_BATCH = 50;
  for (let i = 0; i < trackRegions.length; i += TR_BATCH) {
    const chunk = trackRegions.slice(i, i + TR_BATCH);
    const values = chunk.map(
      ([rid, trackId, cellCount, firstTs, lastTs]) =>
        `(${rid}, ${sqlEscape(trackId)}, ${cellCount}, ${firstTs}, ${lastTs})`
    );
    sqlLines.push(
      `INSERT INTO track_regions (region_id, track_id, cell_count, first_ts, last_ts) VALUES\n  ${values.join(
        ",\n  "
      )};`
    );
  }

  fs.writeFileSync(seedSqlPath, `${sqlLines.join("\n\n")}\n`, "utf8");

  const byLevel = [0, 0, 0, 0];
  for (const r of visitedRegions) byLevel[r.level]++;
  console.log(
    `Lit regions summary: L0(countries)=${byLevel[0]}, L1(provinces/states)=${byLevel[1]}, L2(cities/counties)=${byLevel[2]}, L3(districts)=${byLevel[3]}`
  );
  console.log("Top regions by heat:");
  for (const r of visitedRegions.slice(0, 15)) {
    console.log(
      `  [L${r.level}] ${r.nameZh || r.nameEn} (${r.country}): heat=${r.heat}, children=${r.litDirectChildren}/${r.directChildCount}, area=${r.exploredAreaKm2}km2, days=${r.visitDays}`
    );
  }
  console.log(`Wrote ${outJsonPath} and ${seedSqlPath}.`);
}

main();
