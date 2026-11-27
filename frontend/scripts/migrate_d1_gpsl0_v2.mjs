#!/usr/bin/env node
// Safe in-place Cloudflare D1 / SQLite `track_blobs` migration to GPSL0 v3 (`version=2`, `model_id=22`).
//
// Usage:
//   node scripts/migrate_d1_gpsl0_v2.mjs [options]
//
// Options:
//   --local                         Target local Miniflare D1 (default)
//   --remote                        Target remote Cloudflare D1 (`gps_tracks`)
//   --dry-run                       Decode, re-encode, verify, and emit backup + chunked SQL without applying (default)
//   --apply                         Execute generated migration chunks and post-verify headers
//   --confirm-frontend-deployed     Required with `--remote --apply` to confirm v3 (`model_id=22`) WASM frontend is live first
//   --db=<name>                     D1 database name (default: process.env.CF_D1_DB || "gps_tracks")
//   --alt-quantum=<1|2|5|10>        Altitude quantization step in 0.1m units (default: 10 = 1m)
//   --force                         Re-encode blobs even if header already matches target version=2 & model_id=22
//   --limit=<N>                     Migrate at most N candidate tracks
//   --chunk-kb=<N>                  Max size per SQL batch file in KB (default: 400)
//   --backup-dir=<DIR>              Backup + SQL output directory
//   --sqlite=<PATH>                 Operate directly on a local SQLite file via node:sqlite (offline testing)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODEL_ID,
  decodeGpsl0,
  encodeGpsl0,
  inspectGpsl0Header,
} from "../src/services/gpsl0/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");

function printHelp() {
  console.log(`Usage: node scripts/migrate_d1_gpsl0_v2.mjs [options]

Options:
  --local                         Target local Miniflare D1 (default)
  --remote                        Target remote Cloudflare D1
  --dry-run                       Verify & generate backup/SQL without writing D1 (default)
  --apply                         Apply SQL chunks to D1 and verify post-migration headers
  --confirm-frontend-deployed     Required with --remote --apply (v3 m22 frontend MUST deploy first)
  --db=<name>                     D1 database name (default: process.env.CF_D1_DB || "gps_tracks")
  --alt-quantum=<1|2|5|10>        Altitude quantization in 0.1m units (default: 10)
  --force                         Re-encode blobs even if header already matches v3 (model_id=${DEFAULT_MODEL_ID})
  --limit=<N>                     Migrate at most N candidate tracks
  --chunk-kb=<N>                  Max SQL batch file size in KB (default: 400)
  --backup-dir=<DIR>              Backup directory (default: scripts/.cache/d1-v1-backup-<ts>)
  --sqlite=<PATH>                 Operate directly on a local SQLite DB via node:sqlite
  -h, --help                      Show this help`);
}

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const opts = {
    remote: false,
    apply: false,
    confirmFrontendDeployed: false,
    db: process.env.CF_D1_DB || "gps_tracks",
    modelId: DEFAULT_MODEL_ID,
    altQuantum: 10,
    force: false,
    limit: 0,
    chunkKb: 400,
    backupDir: path.join(FRONTEND_DIR, "scripts", ".cache", `d1-v1-backup-${stamp}`),
    sqlite: null,
    help: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--local") opts.remote = false;
    else if (arg === "--remote") opts.remote = true;
    else if (arg === "--dry-run") opts.apply = false;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--confirm-frontend-deployed") opts.confirmFrontendDeployed = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--db=")) opts.db = arg.slice(5);
    else if (arg.startsWith("--alt-quantum=")) opts.altQuantum = Number(arg.slice(14));
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice(8));
    else if (arg.startsWith("--chunk-kb=")) opts.chunkKb = Number(arg.slice(11));
    else if (arg.startsWith("--backup-dir=")) opts.backupDir = path.resolve(arg.slice(13));
    else if (arg.startsWith("--sqlite=")) opts.sqlite = path.resolve(arg.slice(9));
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(opts.altQuantum) || opts.altQuantum < 1 || 10 % opts.altQuantum !== 0) {
    throw new Error(`Invalid --alt-quantum=${opts.altQuantum} (allowed: 1, 2, 5, 10)`);
  }
  if (!Number.isInteger(opts.chunkKb) || opts.chunkKb < 16) {
    throw new Error(`Invalid --chunk-kb=${opts.chunkKb} (must be integer >= 16)`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 0) {
    throw new Error(`Invalid --limit=${opts.limit}`);
  }
  return opts;
}

function sqlEscape(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function safeFileStem(trackId) {
  return String(trackId).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseHeaderInfoFromHex(hdrHex) {
  if (typeof hdrHex !== "string" || hdrHex.length < 20) return null;
  const bytes = Buffer.from(hdrHex, "hex");
  if (bytes.length < 10) return null;
  const magic = bytes.subarray(0, 8).toString("latin1");
  if (magic !== "GPSL0\0\0\0") return null;
  const version = bytes.readUInt16LE(8);
  const modelId = version === 2 && bytes.length >= 28 ? bytes.readUInt8(27) : null;
  return { version, modelId };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes} B)`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB (${bytes} B)`;
  return `${bytes} B`;
}

async function openBackend(opts) {
  if (opts.sqlite) {
    const sqliteMod = await import("node:sqlite");
    const db = new sqliteMod.DatabaseSync(opts.sqlite);
    return {
      label: `sqlite:${opts.sqlite}`,
      query(sql) {
        return db.prepare(sql).all();
      },
      executeFile(filePath) {
        const sql = fs.readFileSync(filePath, "utf8");
        db.exec(sql);
      },
      close() {
        db.close();
      },
    };
  }

  const modeFlag = opts.remote ? "--remote" : "--local";
  let tmpSeq = 0;

  function runWranglerFile(filePath, jsonOutput) {
    const args = ["wrangler", "d1", "execute", opts.db, modeFlag, `--file=${filePath}`];
    if (jsonOutput) args.push("--json");
    const stdout = execFileSync(
      "npx",
      args,
      {
        cwd: FRONTEND_DIR,
        shell: process.platform === "win32",
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
    return stdout;
  }

  return {
    label: `d1:${opts.db} (${modeFlag})`,
    query(sql) {
      fs.mkdirSync(opts.backupDir, { recursive: true });
      const tmpSql = path.join(opts.backupDir, `.tmp-query-${++tmpSeq}.sql`);
      fs.writeFileSync(tmpSql, `${sql}\n`, "utf8");
      try {
        const raw = runWranglerFile(tmpSql, true);
        const startArr = raw.indexOf("[");
        const startObj = raw.indexOf("{");
        let start = -1;
        if (startArr !== -1 && startObj !== -1) start = Math.min(startArr, startObj);
        else start = Math.max(startArr, startObj);
        if (start === -1) {
          throw new Error(`Unexpected wrangler D1 JSON output: ${raw.slice(0, 300)}`);
        }
        const parsed = JSON.parse(raw.slice(start));
        if (Array.isArray(parsed)) {
          const rows = [];
          for (const stmtRes of parsed) {
            if (stmtRes?.success === false) {
              throw new Error(`D1 query failed: ${JSON.stringify(stmtRes)}`);
            }
            if (Array.isArray(stmtRes?.results)) rows.push(...stmtRes.results);
          }
          return rows;
        }
        if (parsed?.success === false) {
          throw new Error(`D1 query failed: ${JSON.stringify(parsed)}`);
        }
        if (Array.isArray(parsed?.results)) return parsed.results;
        if (Array.isArray(parsed?.result?.[0]?.results)) return parsed.result[0].results;
        return [];
      } finally {
        fs.rmSync(tmpSql, { force: true });
      }
    },
    executeFile(filePath) {
      runWranglerFile(filePath, false);
    },
    close() {},
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.remote && opts.apply && !opts.confirmFrontendDeployed) {
    console.error(
      `REFUSED: Converting remote D1 \`track_blobs\` to GPSL0 v2 (model_id=${opts.modelId}) requires the v3 WASM frontend/CLI\n` +
        "to be deployed FIRST (`npm run deploy:cf`), otherwise existing older browsers cannot decode migrated blobs.\n" +
        "Once `npm run deploy:cf` is live, re-run with `--remote --apply --confirm-frontend-deployed`."
    );
    return 2;
  }

  const backend = await openBackend(opts);
  try {
    console.log(
      `[migrate-d1] target=${backend.label} mode=${opts.apply ? "APPLY" : "DRY-RUN"} ` +
        `targetVersion=2 modelId=${opts.modelId} altQuantum=${opts.altQuantum} force=${opts.force}`
    );

    const summaryRows = backend.query(
      "SELECT track_id, length(data) AS byte_len, hex(substr(data, 1, 28)) AS hdr_hex " +
        "FROM track_blobs ORDER BY track_id ASC;"
    );

    let countV1 = 0;
    let countV3 = 0;
    let countOther = 0;
    let totalCurrentBytes = 0;
    const candidates = [];

    for (const row of summaryRows) {
      const byteLen = Number(row.byte_len || 0);
      totalCurrentBytes += byteLen;
      const hdr = parseHeaderInfoFromHex(row.hdr_hex);
      const ver = hdr?.version ?? null;
      const modelId = hdr?.modelId ?? null;
      if (ver === 1) countV1++;
      else if (ver === 2 && modelId === opts.modelId) countV3++;
      else countOther++;

      if (opts.force || ver !== 2 || modelId !== opts.modelId) {
        candidates.push({
          trackId: String(row.track_id),
          oldByteLen: byteLen,
          oldVersion: ver,
          oldModelId: modelId,
        });
      }
    }

    console.log(
      `[migrate-d1] inventory: total=${summaryRows.length} (v1=${countV1}, v3_m22=${countV3}, other=${countOther}), ` +
        `totalSize=${formatBytes(totalCurrentBytes)}`
    );

    const selected = opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;
    if (selected.length === 0) {
      console.log(`[migrate-d1] nothing to migrate (all blobs are already GPSL0 v2 model_id=${opts.modelId}).`);
      return 0;
    }

    console.log(`[migrate-d1] preparing ${selected.length} track(s) -> backup dir ${opts.backupDir}`);
    const blobsDir = path.join(opts.backupDir, "blobs");
    fs.mkdirSync(blobsDir, { recursive: true });

    const maxFetchBytes = 256 * 1024;
    const maxFetchRows = 25;
    const fetchGroups = [];
    let curGroup = [];
    let curEstBytes = 0;
    for (const item of selected) {
      if (
        curGroup.length > 0 &&
        (curGroup.length >= maxFetchRows || curEstBytes + item.oldByteLen > maxFetchBytes)
      ) {
        fetchGroups.push(curGroup);
        curGroup = [];
        curEstBytes = 0;
      }
      curGroup.push(item);
      curEstBytes += item.oldByteLen;
    }
    if (curGroup.length > 0) fetchGroups.push(curGroup);

    const rollbackLines = [];
    const chunkFiles = [];
    const maxChunkBytes = opts.chunkKb * 1024;
    let currentChunkLines = [];
    let currentChunkBytes = 0;

    const flushChunk = () => {
      if (currentChunkLines.length === 0) return;
      const chunkName = `migrate-chunk-${String(chunkFiles.length + 1).padStart(4, "0")}.sql`;
      const chunkPath = path.join(opts.backupDir, chunkName);
      fs.writeFileSync(chunkPath, `${currentChunkLines.join("\n")}\n`, "utf8");
      chunkFiles.push(chunkPath);
      currentChunkLines = [];
      currentChunkBytes = 0;
    };

    const migratedManifest = [];
    let oldCandidateBytes = 0;
    let newCandidateBytes = 0;
    let maxAltDevSeen = 0;

    for (const group of fetchGroups) {
      const idList = group.map((g) => sqlEscape(g.trackId)).join(", ");
      const rows = backend.query(
        `SELECT track_id, hex(data) AS data_hex FROM track_blobs WHERE track_id IN (${idList}) ORDER BY track_id ASC;`
      );
      if (rows.length !== group.length) {
        throw new Error(`Fetch mismatch: expected ${group.length} rows, got ${rows.length}`);
      }

      for (const row of rows) {
        const trackId = String(row.track_id);
        const oldHex = String(row.data_hex || "").trim();
        if (!/^[0-9a-fA-F]+$/.test(oldHex)) {
          throw new Error(`Invalid hex payload returned for ${trackId}`);
        }
        const oldBytes = Uint8Array.from(Buffer.from(oldHex, "hex"));
        const oldMeta = inspectGpsl0Header(oldBytes);
        const oldDec = decodeGpsl0(oldBytes);

        fs.writeFileSync(path.join(blobsDir, `${safeFileStem(trackId)}.gpsl0`), oldBytes);
        rollbackLines.push(
          `INSERT OR REPLACE INTO track_blobs (track_id, data) VALUES (${sqlEscape(trackId)}, X'${oldHex.toUpperCase()}');`
        );

        const newBytes = encodeGpsl0(
          { t: oldDec.t, lat: oldDec.lat, lon: oldDec.lon, alt: oldDec.alt },
          { version: 2, modelId: opts.modelId, quantum: "auto", altQuantum: opts.altQuantum }
        );
        const newDec = decodeGpsl0(newBytes);

        if (newDec.meta.version !== 2 || newDec.meta.modelId !== opts.modelId) {
          throw new Error(
            `${trackId}: unexpected v2 header version=${newDec.meta.version} modelId=${newDec.meta.modelId} (expected modelId=${opts.modelId})`
          );
        }
        if (newDec.t.length !== oldDec.t.length) {
          throw new Error(`${trackId}: point count changed (${oldDec.t.length} -> ${newDec.t.length})`);
        }
        const allowedAltDev =
          opts.altQuantum > oldMeta.altQuantum ? Math.floor(opts.altQuantum / 2) : 0;

        for (let i = 0; i < oldDec.t.length; i++) {
          if (newDec.t[i] !== oldDec.t[i]) {
            throw new Error(`${trackId}: t mismatch at #${i}`);
          }
          if (newDec.lat[i] !== oldDec.lat[i]) {
            throw new Error(`${trackId}: lat mismatch at #${i}`);
          }
          if (newDec.lon[i] !== oldDec.lon[i]) {
            throw new Error(`${trackId}: lon mismatch at #${i}`);
          }
          const altDev = Math.abs(newDec.alt[i] - oldDec.alt[i]);
          if (altDev > maxAltDevSeen) maxAltDevSeen = altDev;
          if (altDev > allowedAltDev) {
            throw new Error(
              `${trackId}: alt deviation ${altDev} > allowed ${allowedAltDev} at #${i}`
            );
          }
        }

        const newHex = Buffer.from(newBytes).toString("hex").toUpperCase();
        const stmt = `UPDATE track_blobs SET data = X'${newHex}' WHERE track_id = ${sqlEscape(trackId)};`;
        if (
          currentChunkLines.length > 0 &&
          currentChunkBytes + Buffer.byteLength(stmt, "utf8") + 1 > maxChunkBytes
        ) {
          flushChunk();
        }
        currentChunkLines.push(stmt);
        currentChunkBytes += Buffer.byteLength(stmt, "utf8") + 1;

        oldCandidateBytes += oldBytes.byteLength;
        newCandidateBytes += newBytes.byteLength;
        migratedManifest.push({
          trackId,
          points: oldDec.t.length,
          oldVersion: oldMeta.version,
          oldModelId: oldMeta.modelId,
          newModelId: newDec.meta.modelId,
          oldBytes: oldBytes.byteLength,
          newBytes: newBytes.byteLength,
          coordQuantum: newDec.meta.coordQuantum,
          altQuantum: newDec.meta.altQuantum,
        });
      }
    }
    flushChunk();

    const rollbackPath = path.join(opts.backupDir, "rollback.sql");
    fs.writeFileSync(rollbackPath, `${rollbackLines.join("\n")}\n`, "utf8");
    fs.writeFileSync(
      path.join(opts.backupDir, "manifest.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          target: backend.label,
          applied: opts.apply,
          modelId: opts.modelId,
          altQuantum: opts.altQuantum,
          candidates: migratedManifest.length,
          oldBytes: oldCandidateBytes,
          newBytes: newCandidateBytes,
          maxAltDev: maxAltDevSeen,
          chunks: chunkFiles.map((f) => path.basename(f)),
          tracks: migratedManifest,
        },
        null,
        2
      )
    );

    const savedBytes = oldCandidateBytes - newCandidateBytes;
    const savedPct = oldCandidateBytes > 0 ? (savedBytes / oldCandidateBytes) * 100 : 0;
    console.log(
      `[migrate-d1] verified ${migratedManifest.length} track(s): ` +
        `${formatBytes(oldCandidateBytes)} -> ${formatBytes(newCandidateBytes)} ` +
        `(saved ${savedBytes} B / ${savedPct.toFixed(2)}%, maxAltDev=${maxAltDevSeen})`
    );
    console.log(`[migrate-d1] SQL chunks=${chunkFiles.length}, rollback=${rollbackPath}`);

    if (!opts.apply) {
      console.log("[migrate-d1] DRY-RUN complete; database was NOT modified.");
      return 0;
    }

    for (let i = 0; i < chunkFiles.length; i++) {
      console.log(`[migrate-d1] executing chunk ${i + 1}/${chunkFiles.length}: ${path.basename(chunkFiles[i])}`);
      backend.executeFile(chunkFiles[i]);
    }

    const expectedLenById = new Map(migratedManifest.map((m) => [m.trackId, m.newBytes]));
    const afterRows = backend.query(
      "SELECT track_id, length(data) AS byte_len, hex(substr(data, 1, 28)) AS hdr_hex " +
        "FROM track_blobs ORDER BY track_id ASC;"
    );
    let postMigratedOk = 0;
    let postTotalBytes = 0;
    for (const row of afterRows) {
      const id = String(row.track_id);
      const len = Number(row.byte_len || 0);
      postTotalBytes += len;
      const hdr = parseHeaderInfoFromHex(row.hdr_hex);
      const ver = hdr?.version ?? null;
      const modelId = hdr?.modelId ?? null;
      const expected = expectedLenById.get(id);
      if (expected !== undefined) {
        if (ver !== 2 || modelId !== opts.modelId || len !== expected) {
          throw new Error(
            `Post-verify failed for ${id}: got version=${ver} modelId=${modelId} len=${len}, expected version=2 modelId=${opts.modelId} len=${expected}`
          );
        }
        postMigratedOk++;
      }
    }
    if (postMigratedOk !== migratedManifest.length) {
      throw new Error(
        `Post-verify count mismatch: verified ${postMigratedOk} of ${migratedManifest.length}`
      );
    }

    console.log(
      `[migrate-d1] APPLY & VERIFY COMPLETE: ${postMigratedOk}/${migratedManifest.length} track(s) now GPSL0 v2 (model_id=${opts.modelId}), ` +
        `DB track_blobs total=${formatBytes(postTotalBytes)}`
    );
    return 0;
  } finally {
    backend.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("[migrate-d1] FAILED:", err?.stack || err);
    process.exitCode = 1;
  });
