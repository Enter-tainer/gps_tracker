import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, "..");

async function loadEsbuild() {
  const candidates = [
    path.join(cliRoot, "node_modules", "esbuild", "lib", "main.js"),
    path.resolve(cliRoot, "..", "frontend", "node_modules", "esbuild", "lib", "main.js")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.default ?? mod;
    }
  }
  const mod = await import("esbuild");
  return mod.default ?? mod;
}

const esbuild = await loadEsbuild();
const testDir = path.join(cliRoot, "test");
const outDir = path.join(cliRoot, ".test-dist");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const testFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testDir, f));

await esbuild.build({
  entryPoints: testFiles,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  logLevel: "silent"
});

const builtTests = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.join(outDir, f));

const res = spawnSync(process.execPath, ["--test", ...builtTests], {
  stdio: "inherit",
  cwd: cliRoot
});

process.exit(res.status ?? 1);
