import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");

const OVERTURE_RELEASE = "2026-11-18.0";

function parseArgs(argv) {
  let outDir = path.join(FRONTEND_DIR, "local-data");
  let refresh = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (argv[i] === "--refresh") {
      refresh = true;
    }
  }
  return { outDir, refresh };
}

function toDuckPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

function toWslPath(winPath) {
  const resolved = path.resolve(winPath);
  const drive = resolved[0].toLowerCase();
  const rest = resolved.slice(2).replace(/\\/g, "/");
  return `/mnt/${drive}${rest}`;
}

function runDuckDbSql(sqlFilePath, sql) {
  fs.writeFileSync(sqlFilePath, sql, "utf8");
  execFileSync("duckdb", ["-bail", "-c", `.read '${toDuckPath(sqlFilePath)}'`], {
    cwd: FRONTEND_DIR,
    stdio: "inherit"
  });
}

function runWsl(cmd) {
  execFileSync("wsl", ["bash", "-lc", cmd], {
    cwd: FRONTEND_DIR,
    stdio: "inherit"
  });
}

function main() {
  const { outDir, refresh } = parseArgs(process.argv);
  const buildDir = path.join(outDir, "regions-build");
  const r2RegionsDir = path.join(outDir, "r2", "regions");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(r2RegionsDir, { recursive: true });

  const parquetPath = path.join(buildDir, "overture_divisions.parquet");
  const rawMetaPath = path.join(buildDir, "raw_meta.json");
  const ridLayersPath = path.join(buildDir, "rid_layers.json");
  const metaGzPath = path.join(r2RegionsDir, "regions-meta.json.gz");
  const finalPmtilesPath = path.join(r2RegionsDir, "global-regions.pmtiles");
  const sqlTempPath = path.join(buildDir, "_query.sql");

  if (refresh || !fs.existsSync(parquetPath)) {
    console.log(
      `Downloading & caching Overture ${OVERTURE_RELEASE} global land divisions to ${parquetPath}...`
    );
    const areaGlob = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;
    const divGlob = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=divisions/type=division/*.parquet`;
    runDuckDbSql(
      sqlTempPath,
      `
INSTALL spatial;
INSTALL httpfs;
LOAD spatial;
LOAD httpfs;
SET s3_region='us-west-2';

COPY (
  SELECT
    a.division_id,
    a.subtype,
    CASE
      WHEN a.subtype IN ('country', 'dependency') THEN 0
      WHEN a.subtype = 'region' THEN 1
      WHEN a.subtype = 'county' THEN 2
      ELSE 3
    END AS level,
    COALESCE(a.country, '') AS country,
    d.parent_division_id,
    COALESCE(list_transform(d.hierarchies[1], x -> x.division_id), CAST([] AS VARCHAR[])) AS hier_ids,
    COALESCE(NULLIF(d.names.common['zh'], ''), d.names.primary, '') AS name_zh,
    COALESCE(NULLIF(d.names.common['en'], ''), d.names.primary, '') AS name_en,
    ROUND(a.bbox.xmin, 5) AS xmin,
    ROUND(a.bbox.ymin, 5) AS ymin,
    ROUND(a.bbox.xmax, 5) AS xmax,
    ROUND(a.bbox.ymax, 5) AS ymax,
    ROUND(
      GREATEST(
        0.01,
        ST_Area(a.geometry) * COS(RADIANS(GREATEST(-85.0, LEAST(85.0, (a.bbox.ymin + a.bbox.ymax) / 2.0)))) * 12321.0
      ),
      2
    ) AS area_km2,
    a.geometry
  FROM read_parquet('${areaGlob}') a
  JOIN read_parquet('${divGlob}') d
    ON a.division_id = d.id
  WHERE a.is_land = true
    AND a.subtype IN ('country', 'dependency', 'region', 'county', 'localadmin')
    AND ST_GeometryType(a.geometry) IN ('POLYGON', 'MULTIPOLYGON')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY a.division_id ORDER BY ST_Area(a.geometry) DESC) = 1
) TO '${toDuckPath(parquetPath)}' (FORMAT PARQUET, COMPRESSION ZSTD);
`
    );
  } else {
    console.log(`Using cached Overture Parquet: ${parquetPath}`);
  }

  console.log("Exporting division metadata & resolving global hierarchy...");
  runDuckDbSql(
    sqlTempPath,
    `
COPY (
  SELECT
    division_id,
    subtype,
    level,
    country,
    parent_division_id,
    hier_ids,
    name_zh,
    name_en,
    xmin,
    ymin,
    xmax,
    ymax,
    area_km2
  FROM read_parquet('${toDuckPath(parquetPath)}')
  ORDER BY level ASC, country ASC, division_id ASC
) TO '${toDuckPath(rawMetaPath)}' (FORMAT JSON);
`
  );

  const rawLines = fs
    .readFileSync(rawMetaPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const rawRows = rawLines.map((line) => JSON.parse(line));
  console.log(`Loaded ${rawRows.length} deduplicated global land divisions.`);

  const divIdToRow = new Map();
  rawRows.forEach((row, index) => {
    row.rid = index + 1;
    divIdToRow.set(row.division_id, row);
  });

  // Resolve parentRid strictly to nearest extracted ancestor with lower level
  for (const row of rawRows) {
    let parentRid = null;
    if (Array.isArray(row.hier_ids)) {
      for (let i = row.hier_ids.length - 1; i >= 0; i--) {
        const ancId = row.hier_ids[i];
        if (!ancId || ancId === row.division_id) continue;
        const anc = divIdToRow.get(ancId);
        if (anc && anc.level < row.level) {
          parentRid = anc.rid;
          break;
        }
      }
    }
    if (parentRid === null && row.parent_division_id) {
      const p = divIdToRow.get(row.parent_division_id);
      if (p && p.level < row.level) {
        parentRid = p.rid;
      }
    }
    row.parentRid = parentRid;
    row.directChildCount = 0;
    row.leafChildCount = 0;
  }

  const ridToRow = new Map();
  for (const row of rawRows) {
    ridToRow.set(row.rid, row);
  }

  for (const row of rawRows) {
    if (row.parentRid !== null) {
      const parent = ridToRow.get(row.parentRid);
      if (parent) parent.directChildCount++;
    }
  }

  for (const row of rawRows) {
    row.isLeaf = row.directChildCount === 0;
  }

  // Propagate leafChildCount upward from leaves
  for (const row of rawRows) {
    if (!row.isLeaf) continue;
    let pRid = row.parentRid;
    const seen = new Set([row.rid]);
    while (pRid !== null && !seen.has(pRid)) {
      seen.add(pRid);
      const anc = ridToRow.get(pRid);
      if (!anc) break;
      anc.leafChildCount++;
      pRid = anc.parentRid;
    }
  }

  // Partition flags guaranteeing 100% global land coverage across all 4 LOD layers
  const layerLines = [];
  const compactMetaRows = [];
  const counts = { l0: 0, l1: 0, l2: 0, l3: 0 };

  for (const row of rawRows) {
    const parent = row.parentRid !== null ? ridToRow.get(row.parentRid) : null;
    const parentLevel = parent ? parent.level : -1;

    const inL0 = row.level === 0;
    const inL1 = row.level === 1 || (row.isLeaf && row.level < 1);
    const inL2 =
      row.level === 2 ||
      (row.level === 3 && parentLevel === 1) ||
      (row.isLeaf && row.level < 2);
    const inL3 = row.isLeaf;

    if (inL0) counts.l0++;
    if (inL1) counts.l1++;
    if (inL2) counts.l2++;
    if (inL3) counts.l3++;

    compactMetaRows.push([
      row.rid,
      row.level,
      row.parentRid,
      row.directChildCount,
      row.leafChildCount,
      row.area_km2,
      row.isLeaf ? 1 : 0,
      row.country,
      row.name_zh,
      row.name_en,
      row.xmin,
      row.ymin,
      row.xmax,
      row.ymax
    ]);

    layerLines.push(
      JSON.stringify({
        division_id: row.division_id,
        rid: row.rid,
        lv: row.level,
        p: row.parentRid,
        c: row.country,
        n: row.name_zh,
        ne: row.name_en,
        cc: row.directChildCount,
        lc: row.leafChildCount,
        a: row.area_km2,
        b: [row.xmin, row.ymin, row.xmax, row.ymax],
        in_l0: inL0,
        in_l1: inL1,
        in_l2: inL2,
        in_l3: inL3
      })
    );
  }

  console.log(
    `Layer counts: l0=${counts.l0}, l1=${counts.l1}, l2=${counts.l2}, l3=${counts.l3}`
  );

  const metaJson = JSON.stringify({
    version: 1,
    release: OVERTURE_RELEASE,
    rows: compactMetaRows
  });
  fs.writeFileSync(metaGzPath, zlib.gzipSync(Buffer.from(metaJson), { level: 9 }));
  console.log(
    `Wrote ${metaGzPath} (${(fs.statSync(metaGzPath).size / 1024 / 1024).toFixed(2)} MB gzipped)`
  );

  fs.writeFileSync(ridLayersPath, `${layerLines.join("\n")}\n`, "utf8");

  const layerConfigs = [
    { name: "l0", col: "in_l0", minZoom: 0, maxZoom: 4, simp: 6 },
    { name: "l1", col: "in_l1", minZoom: 2, maxZoom: 6, simp: 6 },
    { name: "l2", col: "in_l2", minZoom: 5, maxZoom: 8, simp: 6 },
    { name: "l3", col: "in_l3", minZoom: 7, maxZoom: 10, simp: 6 }
  ];

  console.log("Exporting 4 GeoJSONL partition layers from DuckDB...");
  const exportSql = [
    "LOAD spatial;",
    `CREATE TEMP TABLE layers AS SELECT * FROM read_json_auto('${toDuckPath(ridLayersPath)}');`,
    ...layerConfigs.map((cfg) => {
      const geojsonPath = path.join(buildDir, `${cfg.name}.geojsonl`);
      return `
COPY (
  SELECT
    'Feature' AS type,
    m.rid AS id,
    {
      'rid': m.rid,
      'lv': m.lv,
      'p': m.p,
      'c': m.c,
      'n': m.n,
      'ne': m.ne,
      'cc': m.cc,
      'lc': m.lc,
      'a': m.a,
      'b': m.b
    } AS properties,
    ST_AsGeoJSON(o.geometry)::JSON AS geometry
  FROM read_parquet('${toDuckPath(parquetPath)}') o
  JOIN layers m ON o.division_id = m.division_id
  WHERE m.${cfg.col} = true
) TO '${toDuckPath(geojsonPath)}' (FORMAT JSON);`;
    })
  ].join("\n");

  runDuckDbSql(sqlTempPath, exportSql);

  const layerPmtilesWsl = [];
  for (const cfg of layerConfigs) {
    const geojsonWin = path.join(buildDir, `${cfg.name}.geojsonl`);
    const pmtilesWin = path.join(buildDir, `${cfg.name}.pmtiles`);
    const geojsonWsl = toWslPath(geojsonWin);
    const pmtilesWsl = toWslPath(pmtilesWin);
    layerPmtilesWsl.push(pmtilesWsl);

    console.log(
      `Building ${cfg.name}.pmtiles (Z${cfg.minZoom}-Z${cfg.maxZoom}, simp=${cfg.simp}) via WSL tippecanoe...`
    );
    runWsl(
      `~/.local/bin/tippecanoe -Z${cfg.minZoom} -z${cfg.maxZoom} -l ${cfg.name} --use-attribute-for-id=rid --detect-shared-borders --simplification=${cfg.simp} --no-tile-size-limit --no-feature-limit --force -o '${pmtilesWsl}' '${geojsonWsl}'`
    );
  }

  console.log("Merging 4 layers into global-regions.pmtiles via tile-join...");
  const finalWsl = toWslPath(finalPmtilesPath);
  runWsl(
    `~/.local/bin/tile-join --no-tile-size-limit --force -o '${finalWsl}' ${layerPmtilesWsl
      .map((p) => `'${p}'`)
      .join(" ")}`
  );

  // Clean up huge intermediate GeoJSONL / per-layer PMTiles so local disk stays clean
  for (const cfg of layerConfigs) {
    for (const ext of [".geojsonl", ".pmtiles"]) {
      const f = path.join(buildDir, `${cfg.name}${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
  if (fs.existsSync(sqlTempPath)) fs.unlinkSync(sqlTempPath);
  if (fs.existsSync(rawMetaPath)) fs.unlinkSync(rawMetaPath);

  const finalMb = (fs.statSync(finalPmtilesPath).size / 1024 / 1024).toFixed(2);
  console.log(`Done! Generated ${finalPmtilesPath} (${finalMb} MB).`);
}

main();
