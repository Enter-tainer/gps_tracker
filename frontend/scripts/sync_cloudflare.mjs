import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");

const BUCKET_NAME = process.env.CF_R2_BUCKET || "gps-tracks";
const D1_NAME = process.env.CF_D1_DB || "gps_tracks";
const DATA_DIR = path.join(FRONTEND_DIR, "local-data");

function runWrangler(args) {
  console.log(`> npx wrangler ${args.join(" ")}`);
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", ...args],
    {
      cwd: FRONTEND_DIR,
      stdio: "inherit"
    }
  );
}

function main() {
  const isRemote = !process.argv.includes("--local");
  const modeFlag = isRemote ? "--remote" : "--local";

  const seedSql = path.join(DATA_DIR, "d1", "seed.sql");
  const fogFile = path.join(DATA_DIR, "r2", "fog", "global-fog.bin");

  if (!fs.existsSync(seedSql) || !fs.existsSync(fogFile)) {
    console.error("local-data not found. Run `npm run ingest` first.");
    process.exit(1);
  }

  console.log(`Syncing D1 migrations and seed data (including GPSL0 track_blobs) (${modeFlag})...`);
  runWrangler(["d1", "migrations", "apply", D1_NAME, modeFlag]);
  runWrangler(["d1", "execute", D1_NAME, modeFlag, `--file=${seedSql}`]);

  console.log(`Uploading global-fog.bin to R2 bucket ${BUCKET_NAME}...`);
  runWrangler([
    "r2",
    "object",
    "put",
    `${BUCKET_NAME}/fog/global-fog.bin`,
    `--file=${fogFile}`,
    "--content-type=application/octet-stream",
    modeFlag
  ]);

  console.log("Cloudflare D1 + R2 sync completed!");
}

main();
