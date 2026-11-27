import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const MANIFEST = path.join(REPO_ROOT, "gpsl0", "Cargo.toml");
const BUILT_WASM = path.join(
  REPO_ROOT,
  "gpsl0",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "gpsl0_wasm.wasm"
);
const OUT_WASM = path.join(FRONTEND_ROOT, "src", "services", "gpsl0", "gpsl0_wasm.wasm");

const res = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    MANIFEST,
    "-p",
    "gpsl0-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { stdio: "inherit", cwd: REPO_ROOT }
);

if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

const raw = fs.readFileSync(BUILT_WASM);
fs.mkdirSync(path.dirname(OUT_WASM), { recursive: true });
fs.writeFileSync(OUT_WASM, raw);
const gz = zlib.gzipSync(raw, { level: 9 });
console.log(
  `[gpsl0:build-wasm] ${path.relative(REPO_ROOT, OUT_WASM)} | raw=${raw.length} B (${(raw.length / 1024).toFixed(1)} KiB) | gzip=${gz.length} B (${(gz.length / 1024).toFixed(1)} KiB)`
);
