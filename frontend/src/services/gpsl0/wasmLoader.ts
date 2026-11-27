// Loader and memory-marshaling helpers for the Rust-compiled gpsl0_wasm.wasm.
// Works identically in browsers (async instantiateStreaming via Vite URL asset)
// and in Node.js (sync read via process.getBuiltinModule, no static node:* import
// so Vite browser builds stay clean).

export interface Gpsl0WasmExports {
  memory: WebAssembly.Memory;
  gpsl0_alloc(size: number): number;
  gpsl0_dealloc(ptr: number, size: number): void;
  gpsl0_free_result(ptr: number): void;
  gpsl0_encode(
    tPtr: number,
    latPtr: number,
    lonPtr: number,
    altPtr: number,
    nPoints: number,
    version: number,
    modelId: number,
    coordQuantum: number,
    altQuantum: number,
    blockPoints: number,
    syncBlocks: number,
    altMode: number,
    coordMode: number
  ): number;
  gpsl0_decode(bytesPtr: number, bytesLen: number): number;
  gpsl0_decode_window(
    bytesPtr: number,
    bytesLen: number,
    startPoint: number,
    len: number
  ): number;
  gpsl0_inspect_header(bytesPtr: number, bytesLen: number): number;
}

const WASM_URL = new URL("./gpsl0_wasm.wasm", import.meta.url);

let cachedExports: Gpsl0WasmExports | null = null;
let initPromise: Promise<Gpsl0WasmExports> | null = null;

function getNodeBuiltin(name: string): unknown {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (proc && typeof proc.getBuiltinModule === "function") {
    return proc.getBuiltinModule(name);
  }
  return undefined;
}

function validateExports(instance: WebAssembly.Instance): Gpsl0WasmExports {
  const ex = instance.exports as unknown as Gpsl0WasmExports;
  if (!ex || !(ex.memory instanceof WebAssembly.Memory) || typeof ex.gpsl0_encode !== "function") {
    throw new Error("GPSL0: invalid gpsl0_wasm exports");
  }
  cachedExports = ex;
  return ex;
}

/** Synchronously load and instantiate GPSL0 WASM (Node.js CLI/scripts, or after initGpsl0Wasm). */
export function getGpsl0WasmSync(): Gpsl0WasmExports {
  if (cachedExports) return cachedExports;

  const fs = getNodeBuiltin("node:fs") as { readFileSync(p: string | URL): Uint8Array } | undefined;
  const nodeUrl = getNodeBuiltin("node:url") as { fileURLToPath(u: URL): string } | undefined;
  if (fs && nodeUrl && WASM_URL.protocol === "file:") {
    const wasmBytes = fs.readFileSync(nodeUrl.fileURLToPath(WASM_URL));
    const mod = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
    const instance = new WebAssembly.Instance(mod);
    return validateExports(instance);
  }

  throw new Error(
    "GPSL0: WASM not initialized yet in browser; await initGpsl0Wasm() before calling sync codec API"
  );
}

/** Asynchronously initialize GPSL0 WASM (safe to call repeatedly; memoized). */
export async function initGpsl0Wasm(): Promise<Gpsl0WasmExports> {
  if (cachedExports) return cachedExports;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const fs = getNodeBuiltin("node:fs");
    if (fs && WASM_URL.protocol === "file:") {
      return getGpsl0WasmSync();
    }
    const resp = await fetch(WASM_URL);
    if (!resp.ok) {
      throw new Error(`GPSL0: failed to fetch WASM (${resp.status})`);
    }
    let instance: WebAssembly.Instance;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        const res = await WebAssembly.instantiateStreaming(resp.clone());
        instance = res.instance;
      } catch {
        const bytes = await resp.arrayBuffer();
        const res = await WebAssembly.instantiate(bytes);
        instance = res.instance;
      }
    } else {
      const bytes = await resp.arrayBuffer();
      const res = await WebAssembly.instantiate(bytes);
      instance = res.instance;
    }
    return validateExports(instance);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

// Eagerly warm up WASM in browser contexts while keeping module import side-effect free in Node.
if (typeof window !== "undefined") {
  void initGpsl0Wasm().catch(() => {});
}
