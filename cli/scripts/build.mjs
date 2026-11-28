import fs from "node:fs";
import path from "node:path";
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
const outFile = path.join(cliRoot, "dist", "cli.mjs");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const wasmSrc = path.resolve(
  cliRoot,
  "..",
  "frontend",
  "src",
  "services",
  "gpsl0",
  "gpsl0_wasm.wasm",
);
fs.copyFileSync(wasmSrc, path.join(path.dirname(outFile), "gpsl0_wasm.wasm"));

await esbuild.build({
  entryPoints: [path.join(cliRoot, "src", "cli.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node"
  },
  sourcemap: false,
  logLevel: "info"
});

if (process.platform !== "win32") {
  fs.chmodSync(outFile, 0o755);
}
