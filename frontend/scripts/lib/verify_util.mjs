// GPSL0 独立验证工具库（verifier 作用域）。
//
// 只读工具：窗口切片比较、1e7 单位 -> 米换算、量化期望、断言/检查表、
// 计时 percentile、确定性 RNG、子进程隔离执行（健壮性测试防挂死）。
//
// 注意：baseline-bench 正在写 `frontend/scripts/lib/metrics.mjs`（bitsPerPoint /
// formatBytes / percentile / markdownTable）。本文件先自带最小版，待 metrics.mjs
// 落地后主脚本可改为从 metrics.mjs import（TODO: merge，勿在 metrics.mjs 里改）。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 精度与单位
// ---------------------------------------------------------------------------

/** 输入/输出统一使用 1e7 单位（1e-7 deg）。 */
export const UNITS1E7 = 1e7;

/** 纬度 1 个 1e-7 单位对应的米数（WGS84 平均子午线：1 deg ≈ 111132 m）。 */
export const LAT_M_PER_UNIT = 111132.0 / UNITS1E7; // ≈ 0.0111132 m

/** 经度 1 个 1e-7 单位对应的米数（随纬度收缩）。 */
export function lonMetersPerUnit(latUnits) {
  return LAT_M_PER_UNIT * Math.cos((latUnits / UNITS1E7) * Math.PI / 180);
}

/** |差值（1e7 单位）| -> 米（纬度）。 */
export function latUnitsToMeters(units) {
  return Math.abs(units) * LAT_M_PER_UNIT;
}

/** |差值（1e7 单位）| -> 米（经度，按该点纬度）。 */
export function lonUnitsToMeters(units, latUnits) {
  return Math.abs(units) * lonMetersPerUnit(latUnits);
}

/** round(x / div) * div：1e7 数组按 Tier-1（div=10）量化后的期望值（仍是 1e7 单位）。 */
export function quantizeRound1e7(arr, div = 10) {
  const out = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    // 与实现契约一致的整数半入：round(x / div)
    // JS Math.round 对负数向 +∞ 取整，与 C/Rust 的「四舍五入远离 0」不同；
    // 这里用 roundDiv 语义统一（带符号 half-away-from-zero）。
    out[i] = roundDivInt(arr[i], div) * div;
  }
  return out;
}

/** round(x / div)（带符号 half-away-from-zero，整数除法）。 */
export function roundDivInt(x, div) {
  if (div <= 0) throw new Error(`roundDivInt: div must be > 0, got ${div}`);
  const d = div | 0;
  if (x >= 0) return Math.trunc((x + (d >> 1)) / d);
  return -Math.trunc((-x + (d >> 1)) / d);
}

/** 1e7 值是否落在合法经纬度范围内。 */
export function inLatRange(units) {
  return units >= -90 * UNITS1E7 && units <= 90 * UNITS1E7;
}
export function inLonRange(units) {
  return units >= -180 * UNITS1E7 && units <= 180 * UNITS1E7;
}

// ---------------------------------------------------------------------------
// 统计 / 格式化（metrics.mjs 最小版，待合并）
// ---------------------------------------------------------------------------

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const pos = (sortedAsc.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const w = pos - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

export function statsOf(nums) {
  if (nums.length === 0) return { n: 0, min: NaN, max: NaN, mean: NaN, p50: NaN, p95: NaN };
  const s = Float64Array.from(nums).sort();
  let sum = 0;
  for (const v of s) sum += v;
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function bitsPerPoint(bytes, nPoints) {
  return nPoints > 0 ? (bytes * 8) / nPoints : NaN;
}

export function pct(a, b) {
  return b > 0 ? (100 * a) / b : NaN;
}

export function num(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return Number(v).toFixed(digits);
}

// ---------------------------------------------------------------------------
// 逐列比较
// ---------------------------------------------------------------------------

/**
 * 逐元素比较两个整数序列（长度不同也报出来）。
 * @returns {{
 *   n:number, mismatches:number, lengthMismatch:boolean,
 *   maxAbs:number, meanAbs:number, sumAbs:number,
 *   firstMismatch:{index:number, actual:number, expected:number, delta:number}|null,
 *   maxIndex:number, maxDelta:number, maxActual:number, maxExpected:number
 * }}
 */
export function compareColumn(actual, expected) {
  const n = Math.min(actual.length, expected.length);
  let mismatches = 0;
  let sumAbs = 0;
  let maxAbs = -1;
  let maxIndex = -1;
  let maxDelta = 0;
  let maxActual = 0;
  let maxExpected = 0;
  let first = null;
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a !== e && first === null) {
      first = { index: i, actual: a, expected: e, delta: a - e };
      mismatches++;
    } else if (a !== e) {
      mismatches++;
    }
    const d = Math.abs(a - e);
    sumAbs += d;
    if (d > maxAbs) {
      maxAbs = d;
      maxIndex = i;
      maxDelta = a - e;
      maxActual = a;
      maxExpected = e;
    }
  }
  return {
    n,
    mismatches,
    lengthMismatch: actual.length !== expected.length,
    actualLength: actual.length,
    expectedLength: expected.length,
    maxAbs: n > 0 ? maxAbs : NaN,
    meanAbs: n > 0 ? sumAbs / n : NaN,
    sumAbs,
    firstMismatch: first,
    maxIndex,
    maxDelta,
    maxActual,
    maxExpected,
  };
}

/**
 * 比较解码输出（t/lat/lon/alt）与期望值；字段缺失直接抛错。
 * @param {{t:any,lat:any,lon:any,alt:any}} got
 * @param {{t:any,lat:any,lon:any,alt:any}} want
 */
export function compareTracks(got, want) {
  const fields = ["t", "lat", "lon", "alt"];
  const out = {};
  for (const f of fields) {
    if (got?.[f] == null || want?.[f] == null) {
      throw new Error(`compareTracks: missing field ${f}`);
    }
    out[f] = compareColumn(got[f], want[f]);
  }
  out.totalMismatches = fields.reduce((a, f) => a + out[f].mismatches, 0);
  return out;
}

/**
 * 期望解出的点数值。
 * - precision=1e7：lat/lon 不量化（Tier-0）；precision=1e6：lat/lon 先 round 到 1e6 再乘回 10。
 * - altScale：1=1m 步长（默认，即 0.1m 单位下步长 10）、2=0.5m、5=0.2m、10=0.1m（完全无损）。
 *   alt 输入是 0.1m 单位整数，因此步长 step = round(10 / altScale)（0.1m 单位）。
 * - t 永不量化。
 */
export function expectedForPrecision(track, precision, altScale = 1) {
  const div = precision === 1e7 ? 1 : 10;
  const altStep = Math.max(1, Math.round(10 / altScale));
  return {
    t: track.t,
    lat: div === 1 ? track.lat : quantizeRound1e7(track.lat, div),
    lon: div === 1 ? track.lon : quantizeRound1e7(track.lon, div),
    alt: altStep === 1 ? track.alt : quantizeRound1e7(track.alt, altStep),
  };
}

// ---------------------------------------------------------------------------
// 确定性 RNG / 随机窗口
// ---------------------------------------------------------------------------

/** mulberry32：确定性、跨平台一致的伪随机数。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, lo, hiInclusive) {
  return lo + Math.floor(rng() * (hiInclusive - lo + 1));
}

/**
 * 生成随机访问测试窗口（去重，覆盖边界情况）。
 * @param {number} n 总点数
 * @param {number} count 至少多少个窗口
 * @param {number} blockPoints 块粒度（跨块窗口用）
 * @param {()=>number} rng
 * @returns {{start:number,len:number,kind:string}[]}
 */
export function makeWindows(n, count, blockPoints = 4096, rng = mulberry32(12345)) {
  if (!(n > 0)) throw new Error(`makeWindows: n must be > 0, got ${n}`);
  const bp = Math.max(1, blockPoints | 0);
  const out = [];
  const seen = new Set();
  const push = (start, len, kind) => {
    start = Math.max(0, Math.min(n - 1, start | 0));
    len = Math.max(1, Math.min(n - start, len | 0));
    const key = `${start}:${len}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ start, len, kind });
    return true;
  };

  // ---- 边界用例 ----
  push(0, 1, "first-point");
  push(0, Math.min(n, bp), "first-block");
  push(n - 1, 1, "last-point");
  const lastBlockStart = Math.floor((n - 1) / bp) * bp;
  push(lastBlockStart, Math.min(n - lastBlockStart, bp), "last-block");
  if (n > bp) push(bp - 2, Math.min(10, n - (bp - 2)), "cross-block");
  if (n > 2) push(0, n, "full");
  if (n > 2) push(1, n - 2, "inner");

  // ---- 随机窗口 ----
  const maxLen = n;
  let guard = 0;
  while (out.length < count && guard++ < count * 20) {
    const r = rng();
    let len;
    if (r < 0.15) len = 1;
    else if (r < 0.45) len = randInt(rng, 2, Math.min(16, maxLen));
    else if (r < 0.75) len = randInt(rng, 17, Math.min(1024, maxLen));
    else if (r < 0.95) len = randInt(rng, 1025, Math.min(8192, maxLen));
    else len = randInt(rng, Math.max(1, maxLen - 256), maxLen);
    len = Math.max(1, Math.min(maxLen, len));
    const start = randInt(rng, 0, Math.max(0, n - len));
    // kind 标注：是否跨块
    const kind = Math.floor(start / bp) !== Math.floor((start + len - 1) / bp) ? "random-cross" : "random";
    push(start, len, kind);
  }
  return out;
}

/** 从轨迹取切片（视图，零拷贝；测试用期望值）。 */
export function sliceTrack(track, start, len) {
  const end = start + len;
  return {
    t: track.t.subarray(start, end),
    lat: track.lat.subarray(start, end),
    lon: track.lon.subarray(start, end),
    alt: track.alt.subarray(start, end),
  };
}

// ---------------------------------------------------------------------------
// 检查表（PASS/FAIL/SKIP 收集）
// ---------------------------------------------------------------------------

export class Checks {
  constructor() {
    this.items = [];
  }
  /** @param {"PASS"|"FAIL"|"SKIP"|"INFO"} status */
  add(id, title, status, detail = "", extra = {}) {
    this.items.push({ id, title, status, detail, ...extra });
    return status;
  }
  pass(id, title, detail = "") {
    return this.add(id, title, "PASS", detail);
  }
  fail(id, title, detail = "") {
    return this.add(id, title, "FAIL", detail);
  }
  skip(id, title, detail = "") {
    return this.add(id, title, "SKIP", detail);
  }
  info(id, title, detail = "") {
    return this.add(id, title, "INFO", detail);
  }
  /** 条件式检查：ok 为 true -> PASS，否则 FAIL。 */
  assert(id, title, ok, detail = "") {
    return ok ? this.pass(id, title, detail) : this.fail(id, title, detail);
  }
  get counts() {
    const c = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 };
    for (const it of this.items) c[it.status]++;
    return c;
  }
  get failed() {
    return this.counts.FAIL;
  }
  /** Markdown 行数组（不打印）。 */
  markdownRows() {
    return this.items.map(
      (it) => `| ${it.id} | ${it.title} | ${it.status} | ${String(it.detail).replace(/\|/g, "\\|")} |`
    );
  }
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

/** 计时一次同步调用（毫秒）。 */
export function timedSync(fn) {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

/**
 * 对同步函数做 warmup + iters 计时，返回样本毫秒数组。
 * @returns {{samples:number[], result:any, summary:ReturnType<typeof statsOf>}}
 */
export function benchSync(fn, { warmup = 1, iters = 5 } = {}) {
  let result;
  for (let i = 0; i < warmup; i++) result = fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    result = fn();
    samples.push(performance.now() - t0);
  }
  return { samples, result, summary: statsOf(samples) };
}

// ---------------------------------------------------------------------------
// 子进程隔离执行（健壮性：超时/崩溃/OOM 可观测，不让主进程挂死）
// ---------------------------------------------------------------------------

/**
 * 用独立 node 子进程执行一个探针脚本，带墙钟超时与堆上限。
 * 探针需把结果写入 outFile（JSON）；stdio 用 ignore 以规避 Windows 沙箱
 * 对命名管道（stdio: 'pipe'）的限制。
 *
 * @returns {{status:"ok"|"threw"|"hang"|"crash"|"oom"|"spawn-error",
 *            exitCode:number|null, signal:string|null, elapsedMs:number,
 *            stdout:string, stderr:string, result:any|null, error?:string}}
 */
export function runIsolatedNode(probePath, args = [], opts = {}) {
  const {
    timeoutMs = 15000,
    maxOldSpaceMb = 0,
    outFile = null,
    cwd = undefined,
  } = opts;
  const nodeArgs = [];
  if (maxOldSpaceMb > 0) nodeArgs.push(`--max-old-space-size=${maxOldSpaceMb}`);
  nodeArgs.push(probePath, ...args);
  const t0 = performance.now();
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd,
    timeout: timeoutMs,
    stdio: "ignore",
    windowsHide: true,
  });
  const elapsedMs = performance.now() - t0;

  let result = null;
  if (outFile) {
    try {
      result = JSON.parse(readFileSync(outFile, "utf8"));
    } catch {
      result = null;
    }
  }
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.status == null && r.signal != null);
  if (timedOut) {
    return { status: "hang", exitCode: r.status, signal: r.signal, elapsedMs, stdout: "", stderr: "", result, error: r.error?.message };
  }
  if (r.error) {
    return { status: "spawn-error", exitCode: r.status, signal: r.signal, elapsedMs, stdout: "", stderr: "", result, error: r.error.message };
  }
  if (result) {
    if (result.ok) return { status: "ok", exitCode: r.status, signal: r.signal, elapsedMs, stdout: "", stderr: "", result };
    if (result.threw) return { status: "threw", exitCode: r.status, signal: r.signal, elapsedMs, stdout: "", stderr: "", result };
    if (result.oom) return { status: "oom", exitCode: r.status, signal: r.signal, elapsedMs, stdout: "", stderr: "", result };
  }
  // 无结果文件：子进程被信号杀死（段错误/abort/硬 OOM）或直接退出
  return {
    status: "crash",
    exitCode: r.status,
    signal: r.signal,
    elapsedMs,
    stdout: "",
    stderr: "",
    result,
    error: `child exited without result (status=${r.status}, signal=${r.signal})`,
  };
}
