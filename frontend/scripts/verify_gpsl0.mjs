#!/usr/bin/env node
// GPSL0 独立验证主脚本（verifier 作用域；不修改 codec 源码）。
//
// 用法：
//   node frontend/scripts/verify_gpsl0.mjs --all
//   node frontend/scripts/verify_gpsl0.mjs --tier0 --tier1 --windows --robustness --refdec
//   node frontend/scripts/verify_gpsl0.mjs --track=20250503-morning --tier1
//
// 常用开关：
//   --all                 跑全部套件（tier0 + tier1 + volume + windows + robustness + refdec）
//   --tier0               全量 123 条 Tier-0（1e7 完全无损）roundtrip
//   --tier1               全量 123 条 Tier-1（默认档 1e6 准无损）误差界 + 体积
//   --volume              仅体积对比（隐含 tier1 编码）
//   --windows[=N]         随机访问（默认 N=30 窗口/轨迹）
//   --window-tracks=N     参与随机访问的大轨迹条数（默认 3）
//   --robustness          坏文件健壮性（子进程隔离 + 超时 + 512MB 堆上限）
//   --refdec              跨实现：独立解码器 vs codec 解码结果 bit-exact
//   --track=id1,id2       只跑指定 track（逗号分隔，可重复）
//   --limit=N             只跑前 N 条 track
//   --seed=N              RNG 种子（默认 12345，保证可复现）
//   --codec=<path>        显式指定 codec 入口模块（相对 repo root）
//   --json=<path>         结果 JSON 输出路径（默认 frontend/scripts/.cache/verify.json）
//   --quiet               少打印
//   --help
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 环境/依赖问题（找不到 codec 等）。
//
// 依赖：`frontend/scripts/lib/dataset.mjs`（loadDataset / loadGpzSizes /
// totalPoints）、`frontend/scripts/lib/verify_util.mjs`。所有写入仅落在
// frontend/scripts/.cache/ 与本脚本；codec 只 import、只读。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadDataset,
  loadGpzSizes,
  totalPoints,
  FRONTEND_ROOT,
  REPO_ROOT,
} from "./lib/dataset.mjs";
import * as U from "./lib/verify_util.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(SCRIPT_DIR, ".cache");
const ROBUST_DIR = path.join(CACHE_DIR, "robustness");
const DEFAULT_JSON = path.join(CACHE_DIR, "verify.json");

// 设计文档 §1 的目标区间（字节；1 MB = 1e6 B）
const DESIGN_TARGET_BYTES = {
  tier0: [3.2e6, 4.0e6],
  tier1: [1.8e6, 2.4e6],
};
// 硬门槛：Tier-1 单轴逐点偏差（1e7 单位）上限。5 单位 ≈ 5.6cm（纬度）。
const TIER1_MAX_DEV_UNITS = 5;
const DEFAULT_BLOCK_POINTS = 4096;

// codec 入口候选（按优先级；以 docs/gpsl0_format.md 的最终约定为准）
const CODEC_CANDIDATES = [
  "frontend/src/services/gpsl0/index.ts",
  "frontend/src/services/gpsl0/index.mjs",
  "frontend/src/services/gpsl0/gpsl0.ts",
  "frontend/src/services/gpsl0/codec.ts",
  "frontend/src/services/gpsl0/gpsl0Codec.ts",
  "frontend/src/services/gpsl0/decode.ts",
];
const REFDEC_PATH = path.join(SCRIPT_DIR, "verify_gpsl0_refdec.mjs");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    suites: new Set(),
    tracks: [],
    limit: 0,
    windows: 30,
    windowTracks: 3,
    seed: 12345,
    json: DEFAULT_JSON,
    codec: "",
    quiet: false,
    help: false,
  };
  for (const raw of argv) {
    const arg = raw.trim();
    if (!arg) continue;
    const [flag, ...rest] = arg.split("=");
    const val = rest.join("=");
    switch (flag) {
      case "--all":
        for (const s of ["default", "tier0", "tier1", "volume", "windows", "variants", "robustness", "refdec"]) a.suites.add(s);
        break;
      case "--default":
      case "--tier0":
      case "--tier1":
      case "--variants":
      case "--volume":
      case "--robustness":
      case "--refdec":
        a.suites.add(flag === "--default" ? "default" : flag.slice(2));
        break;
      case "--windows":
        a.suites.add("windows");
        if (val) a.windows = Math.max(1, parseInt(val, 10) || a.windows);
        break;
      case "--window-tracks":
        a.windowTracks = Math.max(1, parseInt(val, 10) || a.windowTracks);
        break;
      case "--track":
        a.tracks.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--limit":
        a.limit = Math.max(0, parseInt(val, 10) || 0);
        break;
      case "--seed":
        a.seed = (parseInt(val, 10) || 12345) >>> 0;
        break;
      case "--codec":
        a.codec = val;
        break;
      case "--json":
        a.json = path.resolve(REPO_ROOT, val);
        break;
      case "--quiet":
        a.quiet = true;
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      default:
        console.warn(`[warn] 未知参数: ${arg}`);
    }
  }
  // 默认（不带套件开关）：核心 tier 校验
  if (a.suites.size === 0 && !a.help) {
    a.suites.add("default");
    a.suites.add("tier1");
    a.suites.add("tier0");
  }
  // --volume 需要 tier1 编码结果
  if (a.suites.has("volume")) a.suites.add("tier1");
  return a;
}

function printHelp() {
  console.log(
    [
      "GPSL0 独立验证器",
      "",
      "  node frontend/scripts/verify_gpsl0.mjs --all",
      "",
      "套件开关：--default --tier0 --tier1 --volume --windows[=N] --variants --robustness --refdec",
      "过滤参数：--track=id1,id2  --limit=N  --window-tracks=N  --seed=N",
      "其他：--codec=<path>  --json=<path>  --quiet",
      "",
      "退出码 0=PASS / 1=FAIL / 2=环境问题（例如 codec 尚未落地）",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// codec 加载
// ---------------------------------------------------------------------------

function resolveCodecPath(override) {
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.resolve(REPO_ROOT, override);
    return fs.existsSync(abs) ? abs : null;
  }
  for (const rel of CODEC_CANDIDATES) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) return abs;
  }
  // 目录存在但文件名不同：扫描可能的入口候选
  const dir = path.join(REPO_ROOT, "frontend/src/services/gpsl0");
  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith(".d.ts"))
      .sort();
    const preferred = files.find((f) => /^(index|gpsl0|codec)\.(ts|mjs|js)$/.test(f));
    if (preferred) return path.join(dir, preferred);
    if (files.length) return path.join(dir, files[0]);
  }
  return null;
}

async function loadCodec(override) {
  const abs = resolveCodecPath(override);
  if (!abs) {
    return {
      path: null,
      mod: null,
      error:
        "找不到 codec 入口。已尝试: " +
        CODEC_CANDIDATES.join(", ") +
        "（以及 frontend/src/services/gpsl0/ 下的 index|gpsl0|codec.*）",
    };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    return { path: abs, mod: null, error: `import ${abs} 失败: ${e?.stack || e}` };
  }
  const ns = mod?.default && typeof mod.default === "object" ? { ...mod.default, ...mod } : mod;
  const pick = (...names) => {
    for (const n of names) if (typeof ns[n] === "function") return ns[n].bind(ns);
    return null;
  };
  const api = {
    encode: pick("encodeGpsl0", "encode"),
    decode: pick("decodeGpsl0", "decode"),
    decodeWindow: pick("decodeGpsl0Window", "decodeWindow"),
    inspectHeader: pick("inspectGpsl0Header", "inspectHeader"),
  };
  if (!api.encode || !api.decode) {
    return {
      path: abs,
      mod,
      error: `codec 入口 ${path.relative(REPO_ROOT, abs)} 未导出 encodeGpsl0/decodeGpsl0（导出: ${Object.keys(ns).join(", ")}）`,
    };
  }
  const buf = fs.readFileSync(abs);
  return {
    path: abs,
    mod,
    api,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
    mtime: fs.statSync(abs).mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function truncate(s, n = 120) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** 从 inspectHeader 结果中稳健地读取块大小。 */
function blockPointsOf(headerMeta) {
  const candidates = ["block_points", "blockPoints", "blockSize", "block_size"];
  for (const k of candidates) {
    const v = headerMeta?.[k];
    if (Number.isInteger(v) && v > 0) return v;
  }
  return DEFAULT_BLOCK_POINTS;
}

// ---------------------------------------------------------------------------
// 套件 1/2：默认档 / Tier-1(1e6) / Tier-0 完全无损 (+ 体积)
// ---------------------------------------------------------------------------
// 说明（对应 docs/gpsl0_format.md v1）：
//  - 默认档：quantum="auto"（= 数据自然格点 gcd）→ lat/lon 逐点严格无损；altQuantum=10（1m，有损 ≤5）；
//  - Tier-1：quantum=10（1e-6 deg，11cm）→ lat/lon 偏差 ≤5（1e7 单位）；仅对坐标能被 10 整除的轨迹适用；
//  - Tier-0 完全无损：quantum="auto" + altQuantum=1 → t/lat/lon/alt 四通道逐点严格相等。
const TIER_CONFIG = {
  default: {
    prefix: "DEF",
    label: "默认档 (quantum=auto 坐标无损, altQuantum=10)",
    opts: {},
    coordExact: true,
    altExact: false,
    altBound: 5,
    volumeTarget: "tier1",
    coordDivisibleBy: 1,
  },
  tier1: {
    prefix: "T1",
    label: "Tier-1 (quantum=10, 1e-6 deg ≈11cm)",
    opts: { quantum: 10 },
    coordExact: false,
    coordBound: TIER1_MAX_DEV_UNITS,
    altExact: false,
    altBound: 5,
    volumeTarget: "tier1",
    coordDivisibleBy: 10,
  },
  tier0strict: {
    prefix: "T0",
    label: "Tier-0 完全无损 (quantum=auto, altQuantum=1)",
    opts: { quantum: "auto", altQuantum: 1 },
    coordExact: true,
    altExact: true,
    volumeTarget: "tier0",
    coordDivisibleBy: 1,
  },
};

const TIER_SUITE_KEYS = { default: "defaultTier", tier1: "tier1", tier0strict: "tier0strict" };

function runTierSuite(checks, tracks, codec, tier, args) {
  const cfg = TIER_CONFIG[tier];
  const { prefix, label: tierName, coordExact, coordBound, altExact, altBound } = cfg;
  const gpzSizes = loadGpzSizes();
  const perTrack = [];
  const t0 = performance.now();

  let okTracks = 0;
  let totalBytes = 0;
  let totalMismatches = 0;
  let globalMaxLat = 0;
  let globalMaxLon = 0;
  let globalMaxAlt = 0;
  let globalMaxT = 0;
  let globalMaxLatM = 0;
  let globalMaxLonM = 0;
  let quantViolations = 0;
  let rangeViolations = 0;
  let collapseViolations = 0;
  const worstDevTracks = [];
  const defaultOptChecks = [];
  const headerChecks = [];
  const globalChanMismatch = { t: 0, lat: 0, lon: 0, alt: 0 };
  const skippedTracks = [];
  let skipReasonCounts = 0;

  for (const tr of tracks) {
    // Tier-1(quantum=10) 只适用于坐标能被 10 整除的轨迹；其它轨迹计为 skipped
    let bytes;
    let encMs = 0;
    try {
      const enc = U.timedSync(() => codec.api.encode(tr, cfg.opts));
      bytes = enc.result;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(`encodeGpsl0 未返回 Uint8Array（${tr.id}: ${typeof bytes}）`);
      }
      encMs = enc.ms;
    } catch (e) {
      const msg = String(e?.message || e);
      if (tier === "tier1" && /multiple of quantum|quantum/i.test(msg)) {
        skippedTracks.push({ id: tr.id, n: tr.n, reason: truncate(msg, 120) });
        continue;
      }
      throw e;
    }
    const dec = U.timedSync(() => codec.api.decode(bytes));
    const got = dec.result;
    // 与**原始值**逐点比较（误差界直接对原始数据定义；量化网格另用 grid 检查）
    const cmp = U.compareTracks(got, tr);

    // 各通道 diff 明细
    const channelMismatches = {
      t: cmp.t.mismatches,
      lat: cmp.lat.mismatches,
      lon: cmp.lon.mismatches,
      alt: cmp.alt.mismatches,
    };

    // 默认档位抽查：不带 opts 的 encode 必须与显式 {quantum:"auto", altQuantum:10} 字节级一致
    if (tier === "default" && defaultOptChecks.length < 3) {
      try {
        const explicit = codec.api.encode(tr, { quantum: "auto", altQuantum: 10 });
        const same =
          explicit instanceof Uint8Array &&
          explicit.length === bytes.length &&
          Buffer.compare(Buffer.from(explicit), Buffer.from(bytes)) === 0;
        defaultOptChecks.push({ id: tr.id, same, defBytes: bytes.length, explicitBytes: explicit?.length ?? null });
      } catch (e) {
        defaultOptChecks.push({ id: tr.id, same: false, error: truncate(e?.message || e, 120) });
      }
    }

    // 读取 header meta（网格检查用真实 quantum；前 3 条做 header 交叉校验）
    let meta = null;
    if (codec.api.inspectHeader) {
      try {
        meta = codec.api.inspectHeader(bytes);
      } catch (e) {
        headerChecks.push({ id: tr.id, tier, error: truncate(e?.message || e, 120) });
      }
    }
    if (meta && headerChecks.length < 3) {
      const nPointsMeta = meta?.n_points ?? meta?.nPoints ?? null;
      const expectedVersion = codec.api.DEFAULT_VERSION ?? 2;
      const expectedModelId = codec.api.DEFAULT_MODEL_ID ?? 22;
      headerChecks.push({
        id: tr.id,
        tier,
        versionOk: (meta?.version ?? null) === expectedVersion,
        nPointsOk: nPointsMeta === tr.n,
        modelIdOk: (meta?.model_id ?? meta?.modelId ?? null) === expectedModelId,
        meta: {
          version: meta?.version ?? null,
          n_points: nPointsMeta,
          coordQuantum: meta?.coord_quantum ?? meta?.coordQuantum ?? null,
          altQuantum: meta?.alt_quantum ?? meta?.altQuantum ?? null,
          model_id: meta?.model_id ?? meta?.modelId ?? null,
        },
      });
    }
    const coordQ = Number(meta?.coord_quantum ?? meta?.coordQuantum ?? 0) || 0;
    const altQ = Number(meta?.alt_quantum ?? meta?.altQuantum ?? 0) || 0;

    let trackMaxLat = cmp.lat.maxAbs || 0;
    let trackMaxLon = cmp.lon.maxAbs || 0;
    const maxAlt = cmp.alt.maxAbs || 0;
    const maxT = cmp.t.maxAbs || 0;

    let devLatM = 0;
    let devLonM = 0;
    let sumLatM = 0;
    let sumLonM = 0;
    for (let i = 0; i < tr.n; i++) {
      const latDev = got.lat[i] - tr.lat[i];
      const lonDev = got.lon[i] - tr.lon[i];
      if (Math.abs(latDev) > trackMaxLat) trackMaxLat = Math.abs(latDev);
      if (Math.abs(lonDev) > trackMaxLon) trackMaxLon = Math.abs(lonDev);
      const latM = U.latUnitsToMeters(latDev);
      const lonM = U.lonUnitsToMeters(lonDev, tr.lat[i]);
      sumLatM += latM;
      sumLonM += lonM;
      if (latM > devLatM) devLatM = latM;
      if (lonM > devLonM) devLonM = lonM;
    }

    // 网格检查：解码值必须是 quantum 的整数倍（coord 按 header 的 coord_quantum，alt 按 alt_quantum）
    let quantBad = 0;
    if (coordQ > 1) {
      for (let i = 0; i < got.lat.length; i++) {
        if (got.lat[i] % coordQ !== 0) quantBad++;
        if (got.lon[i] % coordQ !== 0) quantBad++;
      }
    }
    if (altQ > 1) {
      for (let i = 0; i < got.alt.length; i++) {
        if (got.alt[i] % altQ !== 0) quantBad++;
      }
    }
    quantViolations += quantBad;

    // 量化越界 / 轨迹塌缩
    let badRange = 0;
    for (let i = 0; i < got.lat.length; i++) {
      if (!U.inLatRange(got.lat[i]) || !U.inLonRange(got.lon[i])) badRange++;
    }
    rangeViolations += badRange;

    let distinct = 0;
    let collapsed = false;
    if (tr.n >= 2) {
      const limit = Math.min(tr.n, 4096);
      for (let i = 0; i < limit; i++) {
        if (got.lat[i] !== got.lat[0] || got.lon[i] !== got.lon[0]) {
          distinct++;
          break;
        }
      }
      collapsed = distinct === 0;
      if (collapsed) collapseViolations++;
    }

    const totalMismatch = cmp.totalMismatches;
    totalMismatches += totalMismatch;
    for (const k of ["t", "lat", "lon", "alt"]) globalChanMismatch[k] += channelMismatches[k];
    const coordOk = coordExact
      ? trackMaxLat === 0 && trackMaxLon === 0
      : trackMaxLat <= coordBound && trackMaxLon <= coordBound;
    const altOk = altExact ? maxAlt === 0 : maxAlt <= altBound;
    const trackOk = coordOk && altOk && maxT === 0;
    if (trackOk) okTracks++;
    totalBytes += bytes.length;

    if (trackMaxLat > globalMaxLat) globalMaxLat = trackMaxLat;
    if (trackMaxLon > globalMaxLon) globalMaxLon = trackMaxLon;
    if (maxAlt > globalMaxAlt) globalMaxAlt = maxAlt;
    if (maxT > globalMaxT) globalMaxT = maxT;
    if (devLatM > globalMaxLatM) globalMaxLatM = devLatM;
    if (devLonM > globalMaxLonM) globalMaxLonM = devLonM;
    if (trackMaxLat > 0 || trackMaxLon > 0 || maxAlt > 0 || maxT > 0) {
      worstDevTracks.push({ id: tr.id, n: tr.n, latMax: trackMaxLat, lonMax: trackMaxLon, altMax: maxAlt, tMax: maxT });
    }

    const gpzBytes = gpzSizes.get(tr.id) ?? null;
    perTrack.push({
      id: tr.id,
      n: tr.n,
      opts: cfg.opts,
      bytes: bytes.length,
      gpzBytes,
      ratioVsGpz: gpzBytes ? bytes.length / gpzBytes : null,
      bitsPerPoint: U.bitsPerPoint(bytes.length, tr.n),
      encodeMs: +encMs.toFixed(3),
      decodeMs: +dec.ms.toFixed(3),
      coordQuantum: coordQ,
      altQuantum: altQ,
      mismatches: totalMismatch,
      channelMismatches,
      firstMismatch:
        cmp.t.firstMismatch || cmp.lat.firstMismatch || cmp.lon.firstMismatch || cmp.alt.firstMismatch || null,
      latMaxUnits: trackMaxLat,
      lonMaxUnits: trackMaxLon,
      altMaxUnits: maxAlt,
      tMaxUnits: maxT,
      latMaxMeters: +devLatM.toFixed(4),
      lonMaxMeters: +devLonM.toFixed(4),
      latMeanUnits: +cmp.lat.meanAbs.toFixed(4),
      lonMeanUnits: +cmp.lon.meanAbs.toFixed(4),
      latMeanMeters: +(sumLatM / Math.max(1, tr.n)).toFixed(5),
      lonMeanMeters: +(sumLonM / Math.max(1, tr.n)).toFixed(5),
      quantBad,
      badRange,
      collapsed,
    });
  }

  const elapsedMs = performance.now() - t0;
  const nTracks = tracks.length;
  const nPoints = totalPoints(tracks);

  const nApplicable = nTracks - skippedTracks.length;

  checks.add(
    `${prefix}-ROUNDTRIP`,
    `${tierName}: ${okTracks}/${nApplicable} 条轨迹通过`,
    okTracks === nApplicable && nApplicable > 0 ? "PASS" : "FAIL",
    `tracks=${okTracks}/${nApplicable}${skippedTracks.length ? `（${skippedTracks.length} 条不适用被跳过）` : ""}, ` +
      `与原始值的逐点 diff=${totalMismatches} ` +
      `(t=${globalChanMismatch.t}, lat=${globalChanMismatch.lat}, lon=${globalChanMismatch.lon}, alt=${globalChanMismatch.alt}), ` +
      `maxLat=${globalMaxLat}, maxLon=${globalMaxLon}, maxAlt=${globalMaxAlt}, maxT=${globalMaxT}（1e7 单位）`
  );
  checks.assert(
    `${prefix}-T-EXACT`,
    `${tierName}: 时间戳逐点严格相等`,
    globalMaxT === 0 && globalChanMismatch.t === 0,
    `tDiff=${globalChanMismatch.t}, maxT=${globalMaxT}`
  );
  if (coordExact) {
    checks.assert(
      `${prefix}-COORD-EXACT`,
      `${tierName}: 经纬度逐点严格相等（坐标完全无损）`,
      globalMaxLat === 0 && globalMaxLon === 0,
      `latDiff=${globalChanMismatch.lat}, lonDiff=${globalChanMismatch.lon}, maxLat=${globalMaxLat}, maxLon=${globalMaxLon}`
    );
  } else {
    checks.assert(
      `${prefix}-COORD-BOUND`,
      `${tierName}: 经纬度逐点偏差 ≤ ${coordBound}（1e7 单位，≈${(coordBound * U.LAT_M_PER_UNIT * 100).toFixed(1)} cm 纬度）`,
      globalMaxLat <= coordBound && globalMaxLon <= coordBound,
      `maxLat=${globalMaxLat}u/${globalMaxLatM.toFixed(4)}m, maxLon=${globalMaxLon}u/${globalMaxLonM.toFixed(4)}m`
    );
  }
  if (altExact) {
    checks.assert(
      `${prefix}-ALT-EXACT`,
      `${tierName}: alt 逐点严格相等（altQuantum=1 → 0.1m 无损）`,
      globalMaxAlt === 0 && globalChanMismatch.alt === 0,
      `altDiff=${globalChanMismatch.alt}, maxAlt=${globalMaxAlt}×0.1m`
    );
  } else {
    checks.assert(
      `${prefix}-ALT-BOUND`,
      `${tierName}: alt 量化偏差 ≤ ${altBound}（0.1m 单位，altQuantum=10 → 1m 步长）`,
      globalMaxAlt <= altBound,
      `maxAlt=${globalMaxAlt}×0.1m, altDiffPoints=${globalChanMismatch.alt}`
    );
  }
  checks.assert(
    `${prefix}-GRID`,
    `${tierName}: 解码值落在 header 声明的量化格上（coord_quantum / alt_quantum 的整数倍）`,
    quantViolations === 0,
    `nonGridValues=${quantViolations}`
  );
  checks.assert(
    `${prefix}-RANGE`,
    `${tierName}: 无量化越界（lat∈[-90,90], lon∈[-180,180]）`,
    rangeViolations === 0,
    `violations=${rangeViolations}`
  );
  checks.assert(
    `${prefix}-NO-COLLAPSE`,
    `${tierName}: 无整条轨迹塌缩成单点`,
    collapseViolations === 0,
    `collapsedTracks=${collapseViolations}`
  );
  if (skippedTracks.length) {
    checks.info(
      `${prefix}-SKIPPED`,
      `${tierName}: 不适用轨迹`,
      `${skippedTracks.length} 条（坐标不能被 quantum=${cfg.coordDivisibleBy} 整除，encoder 拒绝）: ` +
        skippedTracks.slice(0, 5).map((s) => `${s.id}(n=${s.n})`).join(", ")
    );
  }

  // ---- 默认档位 / header 交叉校验 ----
  if (tier === "default") {
    if (defaultOptChecks.length === 0) {
      checks.skip("DEF-DEFAULT-OPTS", "默认 opts 语义", "codec encode 未执行（无轨迹）");
    } else {
      const allSame = defaultOptChecks.every((c) => c.same);
      checks.assert(
        "DEF-DEFAULT-OPTS",
        "默认 opts 等价于显式 {quantum:'auto', altQuantum:10}（逐字节一致）",
        allSame,
        defaultOptChecks
          .map((c) => `${c.id}:${c.same ? "same" : `diff(${c.defBytes}B vs ${c.explicitBytes}B)`}`)
          .join(", ")
      );
    }
  }
  if (codec.api.inspectHeader) {
    const bad = headerChecks.filter((c) => c.error || !c.versionOk || !c.nPointsOk || !c.modelIdOk);
    checks.assert(
      `HDR-${prefix}`,
      `${tierName}: inspectGpsl0Header 与 encode 输入一致（version / n_points / model_id）`,
      headerChecks.length > 0 && bad.length === 0,
      bad.length
        ? JSON.stringify(bad.slice(0, 3))
        : headerChecks.map((c) => `${c.id}:${JSON.stringify(c.meta)}`).join("; ")
    );
  } else {
    checks.skip(`HDR-${prefix}`, "inspectGpsl0Header 交叉校验", "codec 未导出 inspectGpsl0Header");
  }

  // ---- 体积 ----
  const gpzTotal = [...gpzSizes.values()].reduce((a, b) => a + b, 0);
  const target = DESIGN_TARGET_BYTES[cfg.volumeTarget];
  const bpp = U.bitsPerPoint(totalBytes, nPoints);
  const ratioVsGpz = gpzTotal / totalBytes;
  const inRange = totalBytes >= target[0] && totalBytes <= target[1];
  const underBudget = totalBytes <= target[1];
  const sortedByRatio = [...perTrack].filter((r) => r.ratioVsGpz != null).sort((a, b) => b.ratioVsGpz - a.ratioVsGpz);
  const worst5 = sortedByRatio.slice(0, 5);
  const best5 = sortedByRatio.slice(-5).reverse();

  checks.assert(
    `VOL-${prefix}`,
    `${tierName}: 总体积不超过设计目标上限 ${(target[1] / 1e6).toFixed(1)} MB`,
    underBudget,
    `total=${totalBytes}B (${U.formatBytes(totalBytes)}), target=${(target[0] / 1e6).toFixed(1)}–${(target[1] / 1e6).toFixed(1)} MB ` +
      `(${inRange ? "落在目标区间" : totalBytes < target[0] ? "低于目标下限，优于目标" : "超出目标上限"}), ${bpp.toFixed(2)} bits/pt, vs GPZ ${ratioVsGpz.toFixed(2)}x`
  );
  checks.info(
    `VOL-${prefix}-DETAIL`,
    "体积分解",
    `tracks=${nTracks}, points=${nPoints}, gpsl0=${totalBytes}B, gpz=${gpzTotal}B, ratio=${ratioVsGpz.toFixed(2)}x, B/pt=${(totalBytes / nPoints).toFixed(3)}, bits/pt=${bpp.toFixed(3)}`
  );
  checks.info(
    `T-${prefix}-TIME`,
    "编解码耗时（全量串行）",
    `encode=${(perTrack.reduce((a, r) => a + r.encodeMs, 0) / 1000).toFixed(2)}s, decode=${(perTrack.reduce((a, r) => a + r.decodeMs, 0) / 1000).toFixed(2)}s, wall=${(elapsedMs / 1000).toFixed(2)}s`
  );
  if (worstDevTracks.length) {
    checks.info(
      `T-${prefix}-DEVIATIONS`,
      "超出零误差的轨迹（前 5）",
      worstDevTracks.slice(0, 5).map((r) => `${r.id}:lat=${r.latMax},lon=${r.lonMax},alt=${r.altMax},t=${r.tMax}`).join("; ")
    );
  }

  return {
    tier,
    opts: cfg.opts,
    tracks: nTracks,
    applicableTracks: nApplicable,
    skippedTracks,
    points: nPoints,
    elapsedMs: +elapsedMs.toFixed(1),
    totals: {
      bytes: totalBytes,
      bitsPerPoint: +bpp.toFixed(4),
      bytesPerPoint: +(totalBytes / nPoints).toFixed(4),
      gpzBytes: gpzTotal,
      ratioVsGpz: +ratioVsGpz.toFixed(4),
      inDesignTarget: inRange,
      underDesignBudget: underBudget,
      designTargetBytes: target,
    },
    maxDeviation: {
      latUnits: globalMaxLat,
      lonUnits: globalMaxLon,
      altUnits: globalMaxAlt,
      tUnits: globalMaxT,
      latMeters: +globalMaxLatM.toFixed(4),
      lonMeters: +globalMaxLonM.toFixed(4),
    },
    quantViolations,
    rangeViolations,
    collapseViolations,
    defaultOptChecks,
    headerChecks,
    worst5,
    best5,
    perTrack,
  };
}

// ---------------------------------------------------------------------------
// 套件 3：随机访问
// ---------------------------------------------------------------------------

function runWindowSuite(checks, tracks, codec, args) {
  if (!codec.api.decodeWindow) {
    checks.skip("WIN", "随机访问 decodeGpsl0Window", "codec 未导出 decodeGpsl0Window");
    return { skipped: "codec 未导出 decodeGpsl0Window" };
  }
  const big = tracks.filter((t) => t.n >= 30000).sort((a, b) => b.n - a.n);
  const picked = big.slice(0, Math.max(1, args.windowTracks));
  if (picked.length === 0) {
    checks.skip("WIN", "随机访问", "数据集中没有 ≥30000 点的轨迹");
    return { skipped: "no large tracks" };
  }
  const perTrack = [];
  let totalWindows = 0;
  let totalMismatches = 0;
  let firstFailure = null;
  let windowMs = [];
  let fullDecodeMs = [];
  let blockPointsUsed = null;

  for (const tr of picked) {
    const enc = U.timedSync(() => codec.api.encode(tr));
    const bytes = enc.result;
    let bp = DEFAULT_BLOCK_POINTS;
    if (codec.api.inspectHeader) {
      try {
        bp = blockPointsOf(codec.api.inspectHeader(bytes));
      } catch {
        /* 用默认值 */
      }
    }
    if (blockPointsUsed == null) blockPointsUsed = bp;

    const full = U.timedSync(() => codec.api.decode(bytes));
    fullDecodeMs.push(full.ms);
    const expected = {
      t: full.result.t,
      lat: full.result.lat,
      lon: full.result.lon,
      alt: full.result.alt,
    };

    const rng = U.mulberry32(args.seed ^ (tr.id.length * 2654435761));
    const wins = U.makeWindows(tr.n, args.windows, bp, rng);
    const row = { id: tr.id, n: tr.n, bytes: bytes.length, blockPoints: bp, windows: [], maxMismatches: 0 };

    for (const w of wins) {
      totalWindows++;
      const slice = U.sliceTrack(expected, w.start, w.len);
      let res;
      try {
        res = U.timedSync(() => codec.api.decodeWindow(bytes, w.start, w.len));
        windowMs.push(res.ms);
        const got = res.result;
        const cmp = U.compareTracks(got, slice);
        if (cmp.totalMismatches > 0) {
          totalMismatches += cmp.totalMismatches;
          row.maxMismatches = Math.max(row.maxMismatches, cmp.totalMismatches);
          if (!firstFailure) {
            const anyField = ["t", "lat", "lon", "alt"].find((f) => cmp[f].firstMismatch);
            firstFailure = {
              track: tr.id,
              window: w,
              field: anyField,
              expectedLen: w.len,
              actualLen: got?.[anyField]?.length,
              firstMismatch: cmp[anyField]?.firstMismatch,
            };
          }
        }
        row.windows.push({
          start: w.start,
          len: w.len,
          kind: w.kind,
          ms: +res.ms.toFixed(4),
          mismatches: cmp.totalMismatches,
          actualLen: got?.t?.length ?? null,
        });
      } catch (e) {
        totalMismatches++;
        if (!firstFailure) {
          firstFailure = { track: tr.id, window: w, thrown: String(e?.message || e) };
        }
        row.windows.push({ start: w.start, len: w.len, kind: w.kind, thrown: String(e?.message || e) });
      }
    }
    perTrack.push(row);
  }

  const msStats = U.statsOf(windowMs);
  checks.assert(
    "WIN-EQ",
    `随机访问：${totalWindows} 个窗口 decodeWindow 与全量 decode 切片逐点相等`,
    totalMismatches === 0,
    `windows=${totalWindows}, mismatches=${totalMismatches}, tracks=${picked.map((t) => `${t.id}:${t.n}`).join(",")}, blockPoints=${blockPointsUsed}` +
      (firstFailure ? `, firstFailure=${JSON.stringify(firstFailure)}` : "")
  );
  checks.info(
    "WIN-PERF",
    "窗口解码耗时（每个窗口一次冷解码）",
    `n=${msStats.n}, mean=${msStats.mean.toFixed(3)}ms, p50=${msStats.p50.toFixed(3)}ms, p95=${msStats.p95.toFixed(3)}ms, max=${msStats.max.toFixed(3)}ms; fullDecodeMean=${U.statsOf(fullDecodeMs).mean.toFixed(2)}ms`
  );
  return {
    blockPoints: blockPointsUsed,
    tracks: picked.map((t) => t.id),
    windows: totalWindows,
    mismatches: totalMismatches,
    firstFailure,
    timing: {
      meanMs: +msStats.mean.toFixed(4),
      p50Ms: +msStats.p50.toFixed(4),
      p95Ms: +msStats.p95.toFixed(4),
      maxMs: +msStats.max.toFixed(4),
    },
    perTrack,
  };
}

// ---------------------------------------------------------------------------
// 套件 3b：编码选项变体（三种坐标预测器 / alt 模式 / 量化档 / 同步窗口 / model_id / 空文件）
// ---------------------------------------------------------------------------

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function maxAbsDiff(a, b) {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return a.length === b.length ? m : Infinity;
}

function runVariantsSuite(checks, tracks, codec, args) {
  if (!tracks.length) {
    checks.skip("VAR", "编码选项变体", "无轨迹数据");
    return { skipped: "no tracks" };
  }
  const byN = [...tracks].sort((a, b) => b.n - a.n);
  const med = byN.find((t) => t.n >= 500) ?? byN[byN.length - 1];
  const big = byN.find((t) => t.n >= 30000) ?? byN[0];
  const out = { coordModes: [], altModes: [], altQuantums: [], syncWindows: [], models: [], edges: [] };

  // ---- 1. 四种坐标预测器（v2: 0=tn, 1=naive, 2=tn-clamped, 3=d1） ----
  for (const [name, expectedMode] of [
    ["tn", 0],
    ["naive", 1],
    ["tn-clamped", 2],
    ["d1", 3],
  ]) {
    try {
      const b = codec.api.encode(med, { coordPredictor: name });
      const meta = codec.api.inspectHeader?.(b) ?? null;
      const d = codec.api.decode(b);
      const mode = meta?.coordMode ?? meta?.coord_mode ?? null;
      out.coordModes.push({
        name,
        expectedMode,
        actualMode: mode,
        latDiff: maxAbsDiff(d.lat, med.lat),
        lonDiff: maxAbsDiff(d.lon, med.lon),
        altMax: maxAbsDiff(d.alt, med.alt),
        bytes: b.length,
      });
    } catch (e) {
      out.coordModes.push({ name, expectedMode, error: truncate(String(e?.message || e), 160) });
    }
  }
  const coordModesOk = out.coordModes.every(
    (r) => !r.error && r.latDiff === 0 && r.lonDiff === 0 && (r.actualMode == null || r.actualMode === r.expectedMode)
  );
  checks.assert(
    "VAR-COORD-MODES",
    "变体：四种坐标预测器（tn / naive / tn-clamped / d1）均可编码+解码，且坐标无损、meta.coordMode 正确",
    coordModesOk,
    out.coordModes
      .map((r) => r.error ?? `${r.name}:mode=${r.actualMode}(want ${r.expectedMode}),latDiff=${r.latDiff},lonDiff=${r.lonDiff}`)
      .join("; ")
  );

  // ---- 2. alt 模式（1=一阶差分默认，2=衰减二阶） ----
  for (const mode of [1, 2]) {
    try {
      const b = codec.api.encode(med, { altMode: mode });
      const meta = codec.api.inspectHeader?.(b) ?? null;
      const d = codec.api.decode(b);
      out.altModes.push({
        altMode: mode,
        metaDamped: meta?.altDamped ?? meta?.alt_damped ?? null,
        latDiff: maxAbsDiff(d.lat, med.lat),
        altMax: maxAbsDiff(d.alt, med.alt),
      });
    } catch (e) {
      out.altModes.push({ altMode: mode, error: truncate(String(e?.message || e), 160) });
    }
  }
  const altModesOk = out.altModes.every(
    (r) => !r.error && r.latDiff === 0 && r.altMax <= 5 && (r.metaDamped == null || r.metaDamped === (r.altMode === 2))
  );
  checks.assert(
    "VAR-ALT-MODES",
    "变体：altMode 1（一阶）与 2（衰减二阶）均可解码，坐标无损、alt 偏差 ≤5、meta.altDamped 正确",
    altModesOk,
    out.altModes.map((r) => r.error ?? `altMode=${r.altMode}:damped=${r.metaDamped},latDiff=${r.latDiff},altMax=${r.altMax}`).join("; ")
  );

  // ---- 3. altQuantum 档位（auto/1/2/5/10） ----
  for (const aq of ["auto", 1, 2, 5, 10]) {
    try {
      const b = codec.api.encode(med, { altQuantum: aq });
      const meta = codec.api.inspectHeader?.(b) ?? null;
      const d = codec.api.decode(b);
      const q = Number(meta?.altQuantum ?? meta?.alt_quantum ?? 0);
      const step = q > 0 ? q : 1;
      let gridBad = 0;
      for (let i = 0; i < d.alt.length; i++) if (d.alt[i] % step !== 0) gridBad++;
      out.altQuantums.push({
        altQuantum: aq,
        resolved: q,
        altMax: maxAbsDiff(d.alt, med.alt),
        gridBad,
        bytes: b.length,
      });
    } catch (e) {
      out.altQuantums.push({ altQuantum: aq, error: truncate(String(e?.message || e), 160) });
    }
  }
  const altQOk = out.altQuantums.every((r) => {
    if (r.error) return false;
    const step = Math.max(1, r.resolved);
    const bound = Math.floor(step / 2);
    return r.gridBad === 0 && r.altMax <= bound;
  });
  checks.assert(
    "VAR-ALT-QUANTUM",
    "变体：altQuantum ∈ {auto,1,2,5,10} 均落在声明格点，偏差 ≤ step/2",
    altQOk,
    out.altQuantums
      .map((r) => r.error ?? `q=${r.altQuantum}->${r.resolved}:max=${r.altMax},gridBad=${r.gridBad}`)
      .join("; ")
  );

  // ---- 4. 同步窗口（blockPoints/syncBlocks）与随机访问 ----
  {
    const baseBytes = codec.api.encode(big);
    const baseDec = codec.api.decode(baseBytes);
    const combos = [
      [64, 0],
      [64, 1],
      [64, 2],
      [256, 1],
      [4096, 0],
    ];
    for (const [bp, sync] of combos) {
      try {
        const b = codec.api.encode(big, { blockPoints: bp, syncBlocks: sync });
        const meta = codec.api.inspectHeader?.(b) ?? null;
        const dec = codec.api.decode(b);
        const eq = arraysEqual(dec.t, baseDec.t) && arraysEqual(dec.lat, baseDec.lat) && arraysEqual(dec.lon, baseDec.lon) && arraysEqual(dec.alt, baseDec.alt);
        const rng = U.mulberry32((args.seed + bp * 31 + sync) >>> 0);
        const wins = U.makeWindows(big.n, Math.min(args.windows, 12), bp, rng);
        let winMismatch = 0;
        let winMsMax = 0;
        for (const w of wins) {
          try {
            const t0 = performance.now();
            const wd = codec.api.decodeWindow(b, w.start, w.len);
            winMsMax = Math.max(winMsMax, performance.now() - t0);
            const exp = U.sliceTrack(dec, w.start, w.len);
            const cmp = U.compareTracks(wd, exp);
            winMismatch += cmp.totalMismatches;
          } catch (e) {
            winMismatch++;
          }
        }
        out.syncWindows.push({
          blockPoints: bp,
          syncBlocks: sync,
          metaBlockPoints: meta?.blockPoints ?? meta?.block_points ?? null,
          metaSyncBlocks: meta?.syncBlocks ?? meta?.sync_blocks ?? null,
          fullEqual: eq,
          windows: wins.length,
          windowMismatches: winMismatch,
          maxWindowMs: +winMsMax.toFixed(2),
          bytes: b.length,
        });
      } catch (e) {
        out.syncWindows.push({ blockPoints: bp, syncBlocks: sync, error: truncate(String(e?.message || e), 160) });
      }
    }
    const syncOk = out.syncWindows.every((r) => !r.error && r.fullEqual && r.windowMismatches === 0);
    checks.assert(
      "VAR-SYNC-WINDOWS",
      "变体：blockPoints/syncBlocks 组合下全量解码与默认档 bit-exact，且跨 sync 窗口 decodeWindow 全部逐点相等",
      syncOk,
      out.syncWindows
        .map(
          (r) =>
            r.error ??
            `bp=${r.blockPoints},sync=${r.syncBlocks}:fullEqual=${r.fullEqual},winMismatch=${r.windowMismatches},maxWinMs=${r.maxWindowMs}`
        )
        .join("; ")
    );
  }

  // ---- 5. model_id 变体（v1: 1..9，v3: 22） ----
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 22]) {
    try {
      const b = codec.api.encode(med, { modelId: id });
      const meta = codec.api.inspectHeader?.(b) ?? null;
      const d = codec.api.decode(b);
      out.models.push({
        modelId: id,
        actual: meta?.modelId ?? meta?.model_id ?? null,
        latDiff: maxAbsDiff(d.lat, med.lat),
        lonDiff: maxAbsDiff(d.lon, med.lon),
        altMax: maxAbsDiff(d.alt, med.alt),
        bytes: b.length,
      });
    } catch (e) {
      out.models.push({ modelId: id, error: truncate(String(e?.message || e), 160) });
    }
  }
  const supported = out.models.filter((r) => !r.error);
  const modelsOk =
    supported.length === 10 &&
    supported.every((r) => r.latDiff === 0 && r.lonDiff === 0 && r.altMax <= 5 && (r.actual == null || r.actual === r.modelId));
  checks.assert(
    "VAR-MODELS",
    `变体：model_id 已支持档位（${supported.map((r) => r.modelId).join(",") || "none"}）roundtrip 正确`,
    modelsOk,
    out.models.map((r) => r.error ?? `id=${r.modelId}:latDiff=${r.latDiff},lonDiff=${r.lonDiff},altMax=${r.altMax}`).join("; ")
  );

  // ---- 6. 边界：空文件 / 单点 / 两点 ----
  {
    const mk = (t, lat, lon, alt) => ({ id: `synthetic-${lat.length}`, n: lat.length, t, lat, lon, alt });
    const cases = [
      ["empty", mk(new Int32Array(0), new Int32Array(0), new Int32Array(0), new Int32Array(0))],
      ["single", mk(Int32Array.from([1700000000]), Int32Array.from([311196800]), Int32Array.from([1214730000]), Int32Array.from([150]))],
      [
        "two",
        mk(
          Int32Array.from([1700000000, 1700000001]),
          Int32Array.from([311196800, 311196900]),
          Int32Array.from([1214730000, 1214730100]),
          Int32Array.from([150, 151])
        ),
      ],
    ];
    for (const [name, tr] of cases) {
      try {
        // 边界测试用完全无损档（auto + altQuantum=1），才能断言四通道逐点相等
        const b = codec.api.encode(tr, { quantum: "auto", altQuantum: 1 });
        const d = codec.api.decode(b);
        const meta = codec.api.inspectHeader?.(b) ?? null;
        const eq =
          arraysEqual(d.t, tr.t) && arraysEqual(d.lat, tr.lat) && arraysEqual(d.lon, tr.lon) && arraysEqual(d.alt, tr.alt);
        // 默认档（alt 1m）在此样本上的 alt 偏差应 ≤5
        const defaultDec = codec.api.decode(codec.api.encode(tr));
        const defaultAltMax = tr.n > 0 ? maxAbsDiff(defaultDec.alt, tr.alt) : 0;
        let winOk = null;
        if (tr.n >= 1 && codec.api.decodeWindow) {
          const wd = codec.api.decodeWindow(b, 0, 1);
          winOk = wd.t.length === 1 && wd.t[0] === tr.t[0] && wd.lat[0] === tr.lat[0];
        }
        out.edges.push({
          name,
          n: tr.n,
          bytes: b.length,
          equal: eq,
          defaultAltMax,
          nPointsMeta: meta?.nPoints ?? meta?.n_points ?? null,
          winOk,
        });
      } catch (e) {
        out.edges.push({ name, n: tr.n, error: truncate(String(e?.message || e), 160) });
      }
    }
    const edgesOk = out.edges.every(
      (r) =>
        !r.error &&
        r.equal &&
        r.defaultAltMax <= 5 &&
        (r.nPointsMeta == null || r.nPointsMeta === r.n) &&
        (r.winOk == null || r.winOk === true)
    );
    checks.assert(
      "VAR-EDGE",
      "变体：空文件 / 单点 / 两点 roundtrip 与窗口解码（doc §10.6/§10.7）",
      edgesOk,
      out.edges.map((r) => r.error ?? `${r.name}:n=${r.n},bytes=${r.bytes},equal=${r.equal},defaultAltMax=${r.defaultAltMax},winOk=${r.winOk}`).join("; ")
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// 套件 4：健壮性（坏文件；子进程隔离，超时 + 堆上限）
// ---------------------------------------------------------------------------

const ROBUST_PROBE_SRC = `// 自动生成的健壮性探针（.cache 生成物，不是 codec 源码）
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [codecPath, fixturePath, outPath, mode, startStr, lenStr] = process.argv.slice(2);
const write = (o) => { try { fs.writeFileSync(outPath, JSON.stringify(o)); } catch {} };

const heapMB = process.memoryUsage().heapUsed / 1048576;
try {
  const mod = await import(pathToFileURL(codecPath).href);
  const ns = mod?.default && typeof mod.default === "object" ? { ...mod.default, ...mod } : mod;
  const bytes = new Uint8Array(fs.readFileSync(fixturePath));
  const t0 = performance.now();
  let r;
  if (mode === "header") {
    if (typeof ns.inspectGpsl0Header !== "function") throw new Error("NO_API inspectGpsl0Header");
    r = ns.inspectGpsl0Header(bytes);
  } else if (mode === "window") {
    if (typeof ns.decodeGpsl0Window !== "function") throw new Error("NO_API decodeGpsl0Window");
    r = ns.decodeGpsl0Window(bytes, Number(startStr), Number(lenStr));
  } else {
    if (typeof ns.decodeGpsl0 !== "function") throw new Error("NO_API decodeGpsl0");
    r = ns.decodeGpsl0(bytes);
  }
  const out = {
    ok: true,
    mode,
    ms: +(performance.now() - t0).toFixed(3),
    heapMB: +heapMB.toFixed(1),
    n: r && typeof r === "object" ? (Array.isArray(r.t) || ArrayBuffer.isView(r.t) ? r.t.length : null) : null,
    kind: r == null ? "null" : typeof r,
  };
  if (out.n != null && out.n !== undefined) {
    // 内容指纹：静默解出时用于判断是否与原始一致
    let h = 2166136261 >>> 0;
    const arrays = [r.t, r.lat, r.lon, r.alt];
    for (const a of arrays) {
      if (!a) continue;
      const step = Math.max(1, Math.floor(a.length / 4096));
      for (let i = 0; i < a.length; i += step) {
        h ^= (a[i] | 0) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    out.fingerprint = h >>> 0;
  }
  write(out);
} catch (e) {
  write({
    threw: true,
    mode,
    name: e?.name || "Error",
    message: String(e?.message ?? e).slice(0, 400),
    heapMB: +heapMB.toFixed(1),
  });
}
`;

function prepareRobustnessProbe() {
  ensureDir(ROBUST_DIR);
  const probePath = path.join(ROBUST_DIR, "_probe.mjs");
  fs.writeFileSync(probePath, ROBUST_PROBE_SRC, "utf8");
  return probePath;
}

function runRobustnessSuite(checks, tracks, codec, args) {
  if (tracks.length === 0) {
    checks.skip("ROB", "健壮性", "无轨迹数据");
    return { skipped: "no tracks" };
  }
  ensureDir(ROBUST_DIR);
  const probePath = prepareRobustnessProbe();

  // 基准样本：最小轨迹 + 一中等轨迹。按 n 排序取。
  const sorted = [...tracks].sort((a, b) => a.n - b.n);
  const small = sorted[0];
  const medium = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))];
  const cases = [];
  const fixtureMeta = [];

  const runCase = (label, category, bytes, { mode = "decode", start = 0, len = 0, timeoutMs = 20000, maxOldSpaceMb = 512 } = {}) => {
    const fixturePath = path.join(ROBUST_DIR, `fixture-${cases.length}.gpsl0`);
    const outPath = path.join(ROBUST_DIR, `out-${cases.length}.json`);
    fs.writeFileSync(fixturePath, Buffer.from(bytes));
    let r;
    try {
      r = U.runIsolatedNode(probePath, [codec.path, fixturePath, outPath, mode, String(start), String(len)], {
        timeoutMs,
        maxOldSpaceMb,
        outFile: outPath,
        cwd: REPO_ROOT,
      });
    } catch (e) {
      r = { status: "spawn-error", error: String(e?.message || e), elapsedMs: 0 };
    }
    const entry = {
      label,
      category,
      fixtureBytes: bytes.length,
      status: r.status, // ok | threw | hang | crash | oom | spawn-error
      elapsedMs: +r.elapsedMs.toFixed(1),
      exitCode: r.exitCode ?? null,
      signal: r.signal ?? null,
      error: r.error ?? null,
      detected: r.status === "threw",
      decodedPoints: r.result?.n ?? null,
      message: r.result?.message ?? null,
    };
    cases.push(entry);
    return entry;
  };

  const mutate = (buf, fn) => {
    const copy = Buffer.from(buf);
    fn(copy);
    return copy;
  };

  const crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc32Table[i] = c >>> 0;
  }
  const crc32Buf = (u8, lo = 0, hi = u8.length) => {
    let c = 0xffffffff;
    for (let i = lo; i < hi; i++) c = crc32Table[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  try {
    const fixtures = [
      [small, undefined, ""],
      [medium, undefined, ""],
      [small, { version: 1, modelId: 7 }, "-v1"],
    ];
    for (const [tr, encOpts, suffix] of fixtures) {
      const enc = U.timedSync(() => codec.api.encode(tr, encOpts));
      const bytes = Buffer.from(enc.result);
      const tag = `${tr.id}${suffix}(n=${tr.n})`;
      let meta = null;
      try {
        meta = codec.api.inspectHeader?.(bytes) ?? null;
      } catch {
        /* 用默认布局 */
      }
      const ver = Number(meta?.version ?? bytes.readUInt16LE(8));
      const nb = Number(meta?.nBlocks ?? meta?.n_blocks ?? Math.ceil(tr.n / 4096));
      const bp = Number(meta?.blockPoints ?? meta?.block_points ?? 4096);
      const headerLen = ver === 2 ? 36 : 48;
      const payloadStart =
        ver === 2
          ? nb > 0
            ? Number(meta?.blockIndex?.[0]?.byteOffset ?? headerLen)
            : headerLen
          : headerLen + nb * 24;
      const indexLen = Math.max(0, payloadStart - headerLen);
      fixtureMeta.push({
        id: `${tr.id}${suffix}`,
        version: ver,
        n: tr.n,
        bytes: bytes.length,
        sha256: sha256(bytes),
        nBlocks: nb,
        blockPoints: bp,
      });
      fs.writeFileSync(path.join(ROBUST_DIR, `base-${tr.id}${suffix}.gpsl0`), bytes);

      const setU32 = (off, v) => mutate(bytes, (b) => b.writeUInt32LE(v >>> 0, off));
      const setU16 = (off, v) => mutate(bytes, (b) => b.writeUInt16LE(v & 0xffff, off));
      const setU8 = (off, v) => mutate(bytes, (b) => (b[off] = v & 0xff));

      // --- 1. magic / version / flags ---
      runCase(`${tag} 坏 magic[0]`, "magic", mutate(bytes, (b) => (b[0] ^= 0xff)));
      runCase(`${tag} 坏 magic[7]`, "magic", mutate(bytes, (b) => (b[7] ^= 0x01)));
      runCase(`${tag} version=99`, "magic", setU16(8, 99));

      if (ver === 2) {
        const withV2HdrCrc = (fn) =>
          mutate(bytes, (b) => {
            fn(b);
            b.writeUInt32LE(crc32Buf(b, 0, 28), 28);
          });
        const withV2IdxCrc = (fn) =>
          mutate(bytes, (b) => {
            fn(b);
            b.writeUInt32LE(crc32Buf(b, headerLen, payloadStart), 32);
          });

        runCase(`${tag} flags 未定义位 bit5`, "header-field", setU16(10, (bytes.readUInt16LE(10) | 0x20) & 0xffff));
        runCase(
          `${tag} flags 未定义位 bit5 (valid crc)`,
          "header-field",
          withV2HdrCrc((b) => b.writeUInt16LE((b.readUInt16LE(10) | 0x20) & 0xffff, 10))
        );

        // --- 2. 截断：v2 头 / 索引 / 载荷边界 ---
        const cuts = new Set([1, 4, 8, 12, 16, 24, 28, 32, 35, 36]);
        cuts.add(headerLen + Math.floor(indexLen / 2));
        cuts.add(payloadStart);
        cuts.add(payloadStart + 1);
        cuts.add(payloadStart + Math.floor((bytes.length - payloadStart) / 2));
        cuts.add(bytes.length - 1);
        cuts.add(bytes.length - 5);
        for (const c of [...cuts].filter((v) => v > 0 && v < bytes.length).sort((a, b) => a - b)) {
          runCase(`${tag} 截断 @${c}/${bytes.length}B`, "truncate", bytes.subarray(0, c));
        }

        // --- 3. v2 header 字段精确篡改（36B header：raw CRC 与 valid-CRC 双重校验） ---
        runCase(`${tag} coord_quantum=0 @12 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(0, 12)));
        runCase(`${tag} coord_quantum=3 @12 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(3, 12)));
        runCase(`${tag} coord_quantum=10000001 @12 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(10000001, 12)));
        runCase(`${tag} alt_quantum=3 @26 (valid crc)`, "header-field", withV2HdrCrc((b) => (b[26] = 3)));
        runCase(`${tag} n_points=n+1 @16 (raw)`, "header-field", setU32(16, (tr.n + 1) >>> 0));
        runCase(`${tag} n_points=n+bp @16 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE((tr.n + bp) >>> 0, 16)));
        runCase(`${tag} n_points=0x7FFFFFFF @16 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(0x7fffffff, 16)));
        runCase(`${tag} block_points=0 @20 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(0, 20)));
        runCase(`${tag} block_points=1 @20 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(1, 20)));
        runCase(`${tag} block_points=0x200001 @20 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt32LE(0x200001, 20)));
        runCase(`${tag} sync_blocks=n_blocks+1 @24 (valid crc)`, "header-field", withV2HdrCrc((b) => b.writeUInt16LE((nb + 1) & 0xffff, 24)));
        runCase(`${tag} model_id=99 @27 (valid crc)`, "header-field", withV2HdrCrc((b) => (b[27] = 99)));
        runCase(`${tag} coord_quantum=0 @12 (raw)`, "header-field", setU32(12, 0));
        runCase(`${tag} alt_quantum=3 @26 (raw)`, "header-field", setU8(26, 3));
        runCase(`${tag} crc32_header 翻 bit @28`, "header-field", mutate(bytes, (b) => (b[28] ^= 0x01)));
        runCase(`${tag} crc32_index 翻 bit @32`, "header-field", mutate(bytes, (b) => (b[32] ^= 0x01)));

        // --- 4. v2 delta-varint 索引字段篡改 ---
        if (indexLen >= 10) {
          runCase(`${tag} v2 index[0] raw flip`, "index-field", mutate(bytes, (b) => (b[headerLen] ^= 0x01)));
          runCase(
            `${tag} v2 index[last].crc32_payload 翻 bit (valid index crc)`,
            "index-field",
            withV2IdxCrc((b) => (b[payloadStart - 1] ^= 0x01))
          );
          runCase(
            `${tag} v2 index[last].byte_length varint 破坏 (valid index crc)`,
            "index-field",
            withV2IdxCrc((b) => (b[payloadStart - 5] |= 0x80))
          );
          runCase(
            `${tag} v2 index[last].byte_length +/-1 (valid index crc)`,
            "index-field",
            withV2IdxCrc((b) => (b[payloadStart - 5] ^= 0x01))
          );
        }
      } else {
        const idx = (blk, field) => headerLen + blk * 24 + field;
        const lastBlk = Math.max(0, nb - 1);

        runCase(`${tag} flags coord_mode=3（v1 保留）`, "header-field", setU16(10, (bytes.readUInt16LE(10) | 0x18) & 0xffff));
        runCase(`${tag} flags 未定义位 bit5`, "header-field", setU16(10, (bytes.readUInt16LE(10) | 0x20) & 0xffff));

        // --- 2. 截断：v1 头 / 索引 / 载荷边界 ---
        const cuts = new Set([1, 4, 8, 12, 16, 24, 32, 40, 44, 47, 48]);
        cuts.add(headerLen + Math.floor(indexLen / 2));
        cuts.add(headerLen + indexLen);
        cuts.add(payloadStart + 1);
        cuts.add(payloadStart + Math.floor((bytes.length - payloadStart) / 2));
        cuts.add(bytes.length - 1);
        cuts.add(bytes.length - 5);
        for (const c of [...cuts].filter((v) => v > 0 && v < bytes.length).sort((a, b) => a - b)) {
          runCase(`${tag} 截断 @${c}/${bytes.length}B`, "truncate", bytes.subarray(0, c));
        }

        // --- 3. v1 header 字段精确篡改（docs/gpsl0_format.md §1.1 / §8） ---
        runCase(`${tag} coord_quantum=0 @12`, "header-field", setU32(12, 0));
        runCase(`${tag} coord_quantum=3 @12`, "header-field", setU32(12, 3));
        runCase(`${tag} coord_quantum=10000001 @12`, "header-field", setU32(12, 10000001));
        runCase(`${tag} alt_quantum=3 @16`, "header-field", setU32(16, 3));
        runCase(`${tag} n_points=n+1 @20`, "header-field", setU32(20, tr.n + 1));
        runCase(`${tag} n_points=0x7FFFFFFF @20`, "header-field", setU32(20, 0x7fffffff));
        runCase(`${tag} block_points=0 @24`, "header-field", setU32(24, 0));
        runCase(`${tag} block_points=1 @24`, "header-field", setU32(24, 1));
        runCase(`${tag} block_points=0x200001 @24`, "header-field", setU32(24, 0x200001));
        runCase(`${tag} sync_blocks=n_blocks+1 @28`, "header-field", setU32(28, nb + 1));
        runCase(`${tag} n_blocks=n_blocks+1 @32`, "header-field", setU32(32, nb + 1));
        runCase(`${tag} model_id=99 @36`, "header-field", setU32(36, 99));
        runCase(`${tag} crc32_header 翻 bit @40`, "header-field", mutate(bytes, (b) => (b[40] ^= 0x01)));

        // --- 4. v1 索引字段精确篡改（§1.2 / §8） ---
        runCase(`${tag} index[0].point_count=0`, "index-field", setU32(idx(0, 8), 0));
        runCase(`${tag} index[0].point_count=block_points+1`, "index-field", setU32(idx(0, 8), bp + 1));
        runCase(`${tag} index[0].byte_offset=0xFFFFFFFF`, "index-field", setU32(idx(0, 12), 0xffffffff));
        runCase(`${tag} index[0].byte_length=0xFFFFFFFF`, "index-field", setU32(idx(0, 16), 0xffffffff));
        runCase(`${tag} index[0].crc32_payload 翻 bit`, "index-field", mutate(bytes, (b) => (b[idx(0, 20)] ^= 0x01)));
        runCase(`${tag} index[last].end_ts=0（<start_ts）`, "index-field", setU32(idx(lastBlk, 4), 0));
        if (nb > 1) {
          const off0 = bytes.readUInt32LE(idx(0, 12));
          runCase(`${tag} index[1].byte_offset=index[0].offset（重叠）`, "index-field", setU32(idx(1, 12), off0));
        }
        runCase(`${tag} index 点数之和=n_points+1`, "index-field", setU32(idx(lastBlk, 8), bytes.readUInt32LE(idx(lastBlk, 8)) + 1));
      }

      // --- 5. 随机翻 bit（header / 索引 / 载荷三区，按精确布局） ---
      const regions = [
        ["header", [0, headerLen]],
        ["index", [headerLen, payloadStart]],
        ["payload", [payloadStart, bytes.length]],
      ];
      for (const [region, [lo, hi]] of regions) {
        if (hi <= lo) continue;
        for (let k = 0; k < 6; k++) {
          const rng = U.mulberry32((args.seed + k * 7919 + lo) >>> 0);
          const pos = lo + Math.floor(rng() * (hi - lo));
          const bit = 1 << Math.floor(rng() * 8);
          runCase(
            `${tag} bitflip ${region} @${pos} bit${Math.floor(Math.log2(bit))}`,
            `bitflip-${region}`,
            mutate(bytes, (b) => (b[pos] ^= bit))
          );
        }
      }

      // --- 6. 窗口参数非法（§8 BadWindow） ---
      const winCases = [
        [-1, 1],
        [0, 0],
        [tr.n, 1],
        [0, tr.n + 1],
      ];
      for (const [start, len] of winCases) {
        runCase(`${tag} window(start=${start},len=${len})`, "window", bytes, { mode: "window", start, len });
      }

      // --- 7. 空文件 / 1 字节 ---
      runCase(`${tag} 空文件`, "empty", Buffer.alloc(0));
      runCase(`${tag} 1 字节`, "empty", Buffer.from([0x47]));

      cases.push({
        label: `${tag} 容器布局`,
        category: "layout",
        status: "skip",
        detail: `header=${headerLen}B, index=${indexLen}B, payloadStart=${payloadStart}B, nBlocks=${nb}, blockPoints=${bp}`,
      });
    }
  } finally {
    // 清理大 fixture，避免 .cache 膨胀（保留 base 样本供复现）
    for (const f of fs.readdirSync(ROBUST_DIR)) {
      if (f.startsWith("fixture-") || f.startsWith("out-")) {
        try {
          fs.unlinkSync(path.join(ROBUST_DIR, f));
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 分类统计
  const byStatus = {};
  for (const c of cases) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  const catastrophic = cases.filter((c) => c.status === "hang" || c.status === "crash" || c.status === "oom" || c.status === "spawn-error");
  const silent = cases.filter((c) => c.status === "ok");
  const thrown = cases.filter((c) => c.status === "threw");
  const pick = (cats) => cases.filter((c) => cats.includes(c.category));
  // 硬性结构损坏（§8）：坏 magic/version、截断、header 字段、空文件 -> 必须抛错
  const structural = pick(["magic", "truncate", "header-field", "empty"]).filter((c) => c.status === "ok" || c.status === "threw");
  const structuralSilent = structural.filter((c) => c.status === "ok");
  // 索引字段篡改（§8 BadIndex/CrcMismatch）-> 必须抛错
  const indexField = pick(["index-field"]).filter((c) => c.status === "ok" || c.status === "threw");
  const indexFieldSilent = indexField.filter((c) => c.status === "ok");
  // 载荷翻转（块级 crc32）-> 必须抛错（CrcMismatch）
  const payloadFlips = pick(["bitflip-payload"]).filter((c) => c.status === "ok" || c.status === "threw");
  const payloadFlipSilent = payloadFlips.filter((c) => c.status === "ok");
  // 窗口参数非法 -> 必须抛错（BadWindow）
  const windowCases = pick(["window"]).filter((c) => c.status === "ok" || c.status === "threw");
  const windowSilent = windowCases.filter((c) => c.status === "ok");
  // 随机翻 bit：header/index 属于"未校验但可能被结构检查拒绝"的观测项
  const headerFlips = pick(["bitflip-header"]);
  const indexFlips = pick(["bitflip-index"]);

  if (catastrophic.length === 0) {
    checks.pass(
      "ROB-NO-CRASH",
      "健壮性：坏文件不得挂死/崩溃/OOM（全部在隔离子进程内执行）",
      `cases=${cases.length}, threw=${thrown.length}, silentDecode=${silent.length}, hang/crash/oom=0, byStatus=${JSON.stringify(byStatus)}`
    );
  } else {
    checks.fail(
      "ROB-NO-CRASH",
      "健壮性：坏文件不得挂死/崩溃/OOM（全部在隔离子进程内执行）",
      `cases=${cases.length}, catastrophic=${catastrophic.length}, byStatus=${JSON.stringify(byStatus)}, first=${catastrophic[0].label}(${catastrophic[0].status})`
    );
  }
  checks.assert(
    "ROB-STRUCT-REJECT",
    "健壮性：结构性损坏（坏 magic/version / 截断 / header 字段 / 空文件）应抛 Error",
    structuralSilent.length === 0,
    `structuralCases=${structural.length}, silentlyDecoded=${structuralSilent.length}` +
      (structuralSilent.length ? `, e.g. ${structuralSilent.slice(0, 5).map((c) => c.label).join("; ")}` : "")
  );
  checks.assert(
    "ROB-INDEX-REJECT",
    "健壮性：索引字段非法（point_count/byte_offset/byte_length/点数之和/end_ts/CRC）应抛 Error",
    indexFieldSilent.length === 0,
    `indexCases=${indexField.length}, silentlyDecoded=${indexFieldSilent.length}` +
      (indexFieldSilent.length ? `, e.g. ${indexFieldSilent.slice(0, 5).map((c) => c.label).join("; ")}` : "")
  );
  checks.assert(
    "ROB-PAYLOAD-CRC",
    "健壮性：载荷翻 bit 必须被块级 crc32 检出（CrcMismatch）",
    payloadFlipSilent.length === 0,
    `payloadFlipCases=${payloadFlips.length}, silentlyDecoded=${payloadFlipSilent.length}` +
      (payloadFlipSilent.length ? `, e.g. ${payloadFlipSilent.slice(0, 5).map((c) => c.label).join("; ")}` : "")
  );
  checks.assert(
    "ROB-WINDOW-REJECT",
    "健壮性：非法窗口参数应抛 BadWindow",
    windowSilent.length === 0,
    `windowCases=${windowCases.length}, silentlyDecoded=${windowSilent.length}` +
      (windowSilent.length ? `, e.g. ${windowSilent.slice(0, 3).map((c) => c.label).join("; ")}` : "")
  );
  checks.info(
    "ROB-INDEX-FLIP",
    "健壮性：索引区随机翻 bit 的可发现性（v2 有 crc32_index 校验；v1 靠越界/点数之和/CRC 检查兜底）",
    `indexFlips=${indexFlips.length}, detected=${indexFlips.filter((c) => c.status === "threw").length}, silent=${indexFlips.filter((c) => c.status === "ok").length}` +
      (indexFlips.some((c) => c.status === "ok")
        ? `; silentExamples=${indexFlips.filter((c) => c.status === "ok").slice(0, 3).map((c) => c.label).join("; ")}`
        : "")
  );
  checks.info(
    "ROB-HEADER-FLIP",
    "健壮性：header 区随机翻 bit 的可发现性（v2 crc32 覆盖 0..27 且 28..35 为 header/index crc32；v1 覆盖 0..39）",
    `headerFlips=${headerFlips.length}, detected=${headerFlips.filter((c) => c.status === "threw").length}, silent=${headerFlips.filter((c) => c.status === "ok").length}` +
      (headerFlips.some((c) => c.status === "ok")
        ? `; silentExamples=${headerFlips.filter((c) => c.status === "ok").slice(0, 3).map((c) => c.label).join("; ")}`
        : "")
  );

  return {
    cases: cases.map((c) => ({
      label: c.label,
      category: c.category,
      status: c.status,
      detected: c.detected ?? false,
      elapsedMs: c.elapsedMs,
      exitCode: c.exitCode,
      signal: c.signal,
      fixtureBytes: c.fixtureBytes,
      decodedPoints: c.decodedPoints,
      message: truncate(c.message, 160),
      error: truncate(c.error, 160),
    })),
    summary: {
      total: cases.length,
      byStatus,
      thrown: thrown.length,
      silentDecode: silent.length,
      catastrophic: catastrophic.length,
      structuralSilent: structuralSilent.map((c) => c.label),
      indexFieldSilent: indexFieldSilent.map((c) => c.label),
      payloadFlipDetected: payloadFlips.filter((c) => c.status === "threw").length,
      payloadFlipSilent: payloadFlipSilent.map((c) => c.label),
      windowSilent: windowSilent.map((c) => c.label),
      indexFlipDetected: indexFlips.filter((c) => c.status === "threw").length,
      indexFlipSilent: indexFlips.filter((c) => c.status === "ok").length,
      headerFlipDetected: headerFlips.filter((c) => c.status === "threw").length,
      headerFlipSilent: headerFlips.filter((c) => c.status === "ok").length,
    },
    fixtures: fixtureMeta,
  };
}

// ---------------------------------------------------------------------------
// 套件 5：跨实现（独立 reference decoder）
// ---------------------------------------------------------------------------

async function runRefdecSuite(checks, tracks, codec, args) {
  if (!fs.existsSync(REFDEC_PATH)) {
    checks.skip("REFDEC", "跨实现：独立解码器", `缺少 ${path.relative(REPO_ROOT, REFDEC_PATH)}（等待 docs/gpsl0_format.md 落地后编写）`);
    return { skipped: "refdec missing" };
  }
  let ref;
  try {
    ref = await import(pathToFileURL(REFDEC_PATH).href);
  } catch (e) {
    checks.fail("REFDEC-LOAD", "跨实现：加载独立解码器", truncate(String(e?.stack || e), 300));
    return { error: String(e?.message || e) };
  }
  const decodeRef = ref.decodeGpsl0Ref || ref.decodeGpsl0;
  if (typeof decodeRef !== "function") {
    checks.fail("REFDEC-API", "跨实现：独立解码器需导出 decodeGpsl0Ref", `导出: ${Object.keys(ref).join(", ")}`);
    return { error: "missing decodeGpsl0Ref" };
  }

  // 抽样：最小轨迹 + 若干条（含大轨迹）
  const sample = [];
  const sorted = [...tracks].sort((a, b) => a.n - b.n);
  sample.push(sorted[0]);
  const rand = U.mulberry32(args.seed);
  const pool = tracks.filter((t) => !sample.includes(t));
  while (sample.length < Math.min(5, tracks.length)) {
    const idx = Math.floor(rand() * pool.length);
    const tr = pool.splice(idx, 1)[0];
    if (tr) sample.push(tr);
  }

  const perTrack = [];
  let totalMismatch = 0;
  let firstFailure = null;
  let skipped = 0;
  // 跨实现验证：verify_gpsl0_refdec.mjs 为 v1 独立参考解码器，三档显式以 v1/modelId=7 编码比对
  const configs = [
    { label: "default", opts: { version: 1, modelId: 7 }, strictOriginal: false },
    { label: "q10", opts: { version: 1, modelId: 7, quantum: 10 }, strictOriginal: false },
    { label: "lossless", opts: { version: 1, modelId: 7, quantum: "auto", altQuantum: 1 }, strictOriginal: true },
  ];
  for (const tr of sample) {
    for (const cfg of configs) {
      let bytes;
      try {
        bytes = codec.api.encode(tr, cfg.opts);
      } catch (e) {
        // q10 对自然格点不是 10 倍数的轨迹不适用
        if (cfg.label === "q10" && /multiple of quantum|quantum/i.test(String(e?.message || e))) {
          skipped++;
          perTrack.push({ id: tr.id, config: cfg.label, skipped: truncate(String(e.message), 100) });
          continue;
        }
        throw e;
      }
      let got;
      try {
        got = decodeRef(bytes);
      } catch (e) {
        totalMismatch++;
        firstFailure ??= { track: tr.id, config: cfg.label, thrown: truncate(String(e?.message || e), 200) };
        perTrack.push({ id: tr.id, config: cfg.label, error: truncate(String(e?.message || e), 160) });
        continue;
      }
      // 与 codec 自身解码结果比较（两个实现必须 bit-exact 一致）
      const codecDec = codec.api.decode(bytes);
      const cmpVsCodec = U.compareTracks(got, codecDec);
      // lossless 档：还要求对原始四点数组逐点严格相等（独立实现能证明无损）
      const cmpVsOrig = cfg.strictOriginal ? U.compareTracks(got, tr) : null;
      const mismatch = cmpVsCodec.totalMismatches + (cmpVsOrig?.totalMismatches ?? 0);
      totalMismatch += mismatch;
      if (mismatch > 0 && !firstFailure) {
        const f = ["t", "lat", "lon", "alt"].find((k) => cmpVsCodec[k].firstMismatch || cmpVsOrig?.[k].firstMismatch);
        firstFailure = {
          track: tr.id,
          config: cfg.label,
          field: f,
          pointIndex: cmpVsCodec[f]?.firstMismatch?.index ?? cmpVsOrig?.[f]?.firstMismatch?.index ?? null,
          vsCodec: cmpVsCodec[f]?.firstMismatch ?? null,
          vsOriginal: cmpVsOrig?.[f]?.firstMismatch ?? null,
        };
      }
      perTrack.push({
        id: tr.id,
        n: tr.n,
        config: cfg.label,
        bytes: bytes.length,
        vsCodecMismatches: cmpVsCodec.totalMismatches,
        vsOriginalMismatches: cmpVsOrig?.totalMismatches ?? null,
      });
    }
  }

  checks.assert(
    "REFDEC-EQ",
    `跨实现：独立解码器与 codec 解码结果 bit-exact（${sample.length} 条 × 3 档）`,
    totalMismatch === 0,
    `samples=${sample.map((t) => `${t.id}:${t.n}`).join(",")}, mismatches=${totalMismatch}, skipped=${skipped}` +
      (firstFailure ? `, firstFailure=${JSON.stringify(firstFailure)}` : "")
  );
  return { sample: sample.map((t) => ({ id: t.id, n: t.n })), mismatches: totalMismatch, skipped, firstFailure, perTrack };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  ensureDir(CACHE_DIR);

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    repoRoot: REPO_ROOT,
    options: {
      suites: [...args.suites],
      tracks: args.tracks,
      limit: args.limit,
      windows: args.windows,
      windowTracks: args.windowTracks,
      seed: args.seed,
      codec: args.codec || null,
    },
    dataset: null,
    codec: null,
    suites: {},
    checks: [],
    summary: null,
  };
  const checks = new U.Checks();
  const log = (...a) => {
    if (!args.quiet) console.log(...a);
  };

  // --- codec ---
  const codec = await loadCodec(args.codec);
  report.codec = {
    path: codec.path ? path.relative(REPO_ROOT, codec.path) : null,
    sha256: codec.sha256 ?? null,
    size: codec.size ?? null,
    mtime: codec.mtime ?? null,
    error: codec.error ?? null,
    exports: codec.api
      ? Object.entries(codec.api)
          .filter(([, v]) => typeof v === "function")
          .map(([k]) => k)
      : [],
  };
  if (!codec.api) {
    checks.fail("CODEC-LOAD", "加载 codec codec 入口", truncate(codec.error, 300));
    report.dataset = { tracks: 0, points: 0 };
    report.checks = checks.items;
    report.summary = { ...checks.counts, blocked: true };
    ensureDir(path.dirname(args.json));
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    log(`\n[BLOCKED] ${codec.error}`);
    log(`\n结果已写入 ${path.relative(REPO_ROOT, args.json)}`);
    return 2;
  }
  log(`[codec] ${path.relative(REPO_ROOT, codec.path)}  sha256=${codec.sha256.slice(0, 16)}…`);

  // --- dataset ---
  let tracks = loadDataset({ verbose: !args.quiet });
  if (args.tracks.length) {
    const wanted = new Set(args.tracks);
    tracks = tracks.filter((t) => wanted.has(t.id));
    const missing = [...wanted].filter((id) => !tracks.some((t) => t.id === id));
    if (missing.length) checks.fail("DATA-TRACK", "指定 track 不存在", missing.join(","));
  }
  if (args.limit > 0) tracks = tracks.slice(0, args.limit);
  if (tracks.length === 0) {
    checks.fail("DATA", "数据集为空", "检查 --track/--limit");
  }
  const nPoints = totalPoints(tracks);
  report.dataset = {
    tracks: tracks.length,
    points: nPoints,
    ids: args.tracks.length || args.limit ? tracks.map((t) => t.id) : undefined,
  };
  log(`[data] ${tracks.length} tracks / ${nPoints} points`);

  // --- suites ---
  if (args.suites.has("default")) {
    log("\n== 默认档（quantum=auto 坐标无损 + altQuantum=10）==");
    report.suites.default = runTierSuite(checks, tracks, codec, "default", args);
    const t = report.suites.default.totals;
    log(`  ${t.bytes} B, ${t.bitsPerPoint} bits/pt, vs GPZ ${t.ratioVsGpz}x`);
  }
  if (args.suites.has("tier0")) {
    log("\n== Tier-0（quantum=auto + altQuantum=1 四通道完全无损）==");
    report.suites.tier0 = runTierSuite(checks, tracks, codec, "tier0strict", args);
    const t = report.suites.tier0.totals;
    log(`  ${t.bytes} B, ${t.bitsPerPoint} bits/pt, vs GPZ ${t.ratioVsGpz}x`);
  }
  if (args.suites.has("tier1")) {
    log("\n== Tier-1（quantum=10, 1e-6 deg ≈11cm）==");
    report.suites.tier1 = runTierSuite(checks, tracks, codec, "tier1", args);
    const t = report.suites.tier1.totals;
    log(
      `  ${t.bytes} B, ${t.bitsPerPoint} bits/pt, vs GPZ ${t.ratioVsGpz}x, ` +
        `maxDev lat=${report.suites.tier1.maxDeviation.latUnits}u lon=${report.suites.tier1.maxDeviation.lonUnits}u`
    );
  }
  if (args.suites.has("windows")) {
    log("\n== 随机访问 ==");
    report.suites.windows = runWindowSuite(checks, tracks, codec, args);
    log(
      `  windows=${report.suites.windows.windows ?? "skipped"}, mismatches=${report.suites.windows.mismatches ?? "n/a"}`
    );
  }
  if (args.suites.has("variants")) {
    log("\n== 编码选项变体（预测器/alt/量化/同步窗口/model_id/边界）==");
    report.suites.variants = runVariantsSuite(checks, tracks, codec, args);
    const v = report.suites.variants;
    log(
      `  coordModes=${v.coordModes.length}, altModes=${v.altModes.length}, altQuantums=${v.altQuantums.length}, ` +
        `syncWindows=${v.syncWindows.length}, models=${v.models.length}, edges=${v.edges.length}`
    );
  }
  if (args.suites.has("robustness")) {
    log("\n== 健壮性（隔离子进程）==");
    report.suites.robustness = runRobustnessSuite(checks, tracks, codec, args);
    const s = report.suites.robustness.summary;
    log(`  cases=${s.total} byStatus=${JSON.stringify(s.byStatus)} catastrophic=${s.catastrophic}`);
  }
  if (args.suites.has("refdec")) {
    log("\n== 跨实现解码 ==");
    report.suites.refdec = await runRefdecSuite(checks, tracks, codec, args);
    log(`  ${report.suites.refdec.mismatches ?? "skipped"} mismatches`);
  }

  // --- 汇总 ---
  report.checks = checks.items;
  report.summary = { ...checks.counts };
  const total = checks.items.filter((c) => c.status === "PASS" || c.status === "FAIL").length;
  log("\n== 检查结果 ==");
  for (const it of checks.items) {
    if (it.status === "INFO") continue;
    log(`  [${it.status}] ${it.id}  ${it.title}${it.detail ? `  — ${it.detail}` : ""}`);
  }
  log(
    `\nSummary: PASS=${checks.counts.PASS} FAIL=${checks.counts.FAIL} SKIP=${checks.counts.SKIP} INFO=${checks.counts.INFO} ` +
      `(checks=${total})`
  );

  ensureDir(path.dirname(args.json));
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  log(`结果已写入 ${path.relative(REPO_ROOT, args.json)}`);

  return checks.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
