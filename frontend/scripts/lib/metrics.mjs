// GPSL0 shared metrics / reporting helpers.
//
// Imported by bench scripts AND by the verifier, so the API below is a stable
// contract: additive changes only, never rename or change the meaning of an
// existing export. Pure Node, no dependencies, no side effects on import
// (`loadTrackSizes()` is the only function that touches the filesystem and it
// lazy-loads `./dataset.mjs` so importing this module alone stays cheap).
//
// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
//
// bitsPerPoint(bytes, nPoints) -> number
//     Information rate, bits per encoded point. Returns 0 when nPoints <= 0
//     instead of NaN so it can be summed/printed safely.
//     bitsPerPoint(10_275_509, 2_022_295) === 40.649...
//
// bytesPerPoint(bytes, nPoints) -> number
//     Same, in bytes per point (0 when nPoints <= 0).
//
// formatBytes(bytes, opts?) -> string
//     Human readable size. DEFAULT IS DECIMAL SI (1 kB = 1000 B) so that the
//     printed number and bits/pt agree exactly:
//       formatBytes(10_275_509)                -> "10.28 MB"   (= 40.65 bits/pt on 2.02M pts)
//       formatBytes(10_275_509, { binary:true } -> "9.80 MiB"   (= the KiB/MiB number)
//     opts: { binary?: boolean, digits?: number }  (digits default: 2 -> 2 decimals)
//     For bytes < 1 kB the value is printed as an integer with a "B" suffix.
//     NOTE: the design doc mixes the two conventions (9.80 "MB" is really 9.80
//     MiB); always quote `bytes` from the JSON alongside a formatted string.
//
// percentile(values, p) -> number
//     Linear-interpolation percentile (numpy default / type 7). `p` is 0..1;
//     values > 1 are treated as percentages so `percentile(a, 95) ===
//     percentile(a, 0.95)`. Does not mutate the input. Empty input -> 0.
//
// aggregate(rows) -> object
//     Sums per-track rows into a totals object. A row is any object carrying a
//     byte count and a point count; the accepted key names are, in priority
//     order:
//         bytes : `bytes` | `gpzBytes` | `size`
//         points: `points` | `n` | `pointCount`
//     Returns:
//       { tracks, bytes, points, bytesPerPoint, bitsPerPoint,
//         minBitsPerPoint, maxBitsPerPoint, p50BitsPerPoint,
//         p95BitsPerPoint, p99BitsPerPoint }
//     min/max/p50/p95/p99 are computed over the per-track bits/pt distribution
//     (rows with points > 0 only), so "worst/best track" questions are answered
//     from the same object.
//
// loadTrackSizes(opts?) -> Promise<Array<{id, gpzBytes, n, bytesPerPoint, bitsPerPoint}>>
//     Async on purpose: joins the raw .gpz file sizes with the decoded point
//     counts from `./dataset.mjs` (dynamic import, so importing metrics.mjs
//     alone never pulls the codec). opts forwarded to loadDataset(), e.g.
//     { useCache:false }.
//
// markdownTable(headers, rows, opts?) -> string
//     GitHub-flavoured markdown table. `headers` string[]; `rows` array of
//     arrays (numbers are String()'d). Cells containing `|` are escaped.
//     opts: { align?: ("left"|"right"|"center")[] } — omit for plain `---`.
//
// printTable(headers, rows, opts?) -> void
//     Aligned plain-text table to stdout (same value conventions as
//     markdownTable). opts: { title?: string } prints a title line above it.
//
// timed(fn) -> { result, ms }
//     Runs fn() synchronously once and returns its return value plus wall time
//     in ms (performance.now, sub-ms resolution).
//
// timedAsync(fn) -> Promise<{ result, ms }>
//     Same for an async fn / promise-returning fn.
//
// ---------------------------------------------------------------------------
// Conventions used by every GPSL0 script (keep consistent!)
// ---------------------------------------------------------------------------
// * "per-object / R2 view": compress each track separately and SUM the sizes.
//   This is the real line-up against the current 123 R2 objects.
// * "concatenated view": join all tracks into one buffer and compress once.
//   Reference only — it shows the cross-track redundancy headroom, it is NOT a
//   valid single-object container.
// * Always report BOTH `bytes` and `bitsPerPoint`; never round the bytes.

export function bitsPerPoint(bytes, nPoints) {
  if (!(nPoints > 0)) return 0;
  return (bytes * 8) / nPoints;
}

export function bytesPerPoint(bytes, nPoints) {
  if (!(nPoints > 0)) return 0;
  return bytes / nPoints;
}

export function formatBytes(bytes, opts = {}) {
  const { binary = false, digits = 2 } = opts;
  const base = binary ? 1024 : 1000;
  const units = binary ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "kB", "MB", "GB", "TB"];
  let v = Number(bytes) || 0;
  let i = 0;
  while (Math.abs(v) >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  const fixed = v.toFixed(digits);
  return `${fixed} ${units[i]}`;
}

export function percentile(values, p) {
  const arr = Array.from(values || [], Number).filter((v) => Number.isFinite(v));
  if (arr.length === 0) return 0;
  let q = Number(p);
  if (!Number.isFinite(q)) return 0;
  if (q > 1) q /= 100;
  if (q <= 0) return arr.reduce((a, b) => Math.min(a, b), Infinity);
  if (q >= 1) return arr.reduce((a, b) => Math.max(a, b), -Infinity);
  arr.sort((a, b) => a - b);
  const pos = (arr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

function rowBytes(row) {
  const v = row?.bytes ?? row?.gpzBytes ?? row?.size ?? 0;
  return Number(v) || 0;
}

function rowPoints(row) {
  const v = row?.points ?? row?.n ?? row?.pointCount ?? 0;
  return Number(v) || 0;
}

export function aggregate(rows) {
  const list = rows || [];
  let bytes = 0;
  let points = 0;
  const perTrack = [];
  for (const row of list) {
    const b = rowBytes(row);
    const n = rowPoints(row);
    bytes += b;
    points += n;
    if (n > 0) perTrack.push(bitsPerPoint(b, n));
  }
  return {
    tracks: list.length,
    bytes,
    points,
    bytesPerPoint: bytesPerPoint(bytes, points),
    bitsPerPoint: bitsPerPoint(bytes, points),
    minBitsPerPoint: perTrack.length ? Math.min(...perTrack) : 0,
    maxBitsPerPoint: perTrack.length ? Math.max(...perTrack) : 0,
    p50BitsPerPoint: percentile(perTrack, 0.5),
    p95BitsPerPoint: percentile(perTrack, 0.95),
    p99BitsPerPoint: percentile(perTrack, 0.99),
  };
}

export async function loadTrackSizes(opts = {}) {
  const { loadDataset, loadGpzSizes } = await import("./dataset.mjs");
  const sizes = loadGpzSizes();
  const tracks = loadDataset(opts);
  return tracks.map((tr) => {
    const gpzBytes = sizes.get(tr.id) ?? 0;
    return {
      id: tr.id,
      gpzBytes,
      n: tr.n,
      bytesPerPoint: bytesPerPoint(gpzBytes, tr.n),
      bitsPerPoint: bitsPerPoint(gpzBytes, tr.n),
    };
  });
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function markdownTable(headers, rows, opts = {}) {
  const { align = [] } = opts;
  const head = (headers || []).map((h) => cellText(h).replace(/\|/g, "\\|"));
  const body = (rows || []).map((r) =>
    (r || []).map((c) => cellText(c).replace(/\|/g, "\\|"))
  );
  const sep = head.map((_, i) => {
    const a = align[i];
    if (a === "right") return "---:";
    if (a === "center") return ":---:";
    if (a === "left") return ":---";
    return "---";
  });
  const lines = [];
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(`| ${sep.join(" | ")} |`);
  for (const r of body) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

function displayWidth(s) {
  // Count CJK / fullwidth glyphs as 2 columns so Chinese table cells stay aligned.
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export function printTable(headers, rows, opts = {}) {
  const { title } = opts;
  const head = (headers || []).map(cellText);
  const body = (rows || []).map((r) => (r || []).map(cellText));
  const nCols = Math.max(head.length, ...body.map((r) => r.length), 0);
  const widths = new Array(nCols).fill(0);
  const measure = (r) => {
    for (let i = 0; i < nCols; i++) {
      widths[i] = Math.max(widths[i], displayWidth(r[i] ?? ""));
    }
  };
  measure(head);
  body.forEach(measure);
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - displayWidth(s)));
  const line = (r) =>
    r.map((c, i) => pad(c ?? "", widths[i]).padEnd(widths[i] + 0)).join("  ").trimEnd();
  const out = [];
  if (title) out.push(title);
  out.push(line(head));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) out.push(line(r));
  console.log(out.join("\n"));
}

export function timed(fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  return { result, ms };
}

export async function timedAsync(fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { result, ms };
}
