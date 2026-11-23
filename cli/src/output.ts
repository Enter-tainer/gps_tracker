import { stderr as errOut, stdout as out } from "node:process";

export function isJsonOutput(opts: { json?: boolean; pretty?: boolean }): boolean {
  if (opts.json) return true;
  if (opts.pretty) return false;
  return !out.isTTY;
}

export function writeJson(data: unknown, pretty = false): void {
  out.write(JSON.stringify(data, null, pretty ? 2 : 0) + "\n");
}

export function formatDurationHuman(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${rem}s`;
  return `${rem}s`;
}

export function parseTimestampFlag(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid timestamp: ${raw}`);
    }
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Invalid timestamp "${raw}". Use ISO-8601 (e.g. 2025-10-03T14:30:00+08:00) or Unix seconds.`
    );
  }
  return Math.floor(ms / 1000);
}

export function printError(
  err: unknown,
  code: string,
  jsonMode: boolean
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    out.write(JSON.stringify({ error: code, message }) + "\n");
  } else {
    errOut.write(`Error [${code}]: ${message}\n`);
  }
}
