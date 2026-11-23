import type { TraceveilClient } from "../api.ts";
import { formatDurationHuman, writeJson } from "../output.ts";

export interface StatsResponse {
  filter: {
    year: string | null;
    month: string | null;
    from: string | null;
    to: string | null;
  };
  stats: {
    trackCount: number;
    totalPoints: number;
    totalDistanceM: number;
    totalDistanceKm: number;
    totalDurationS: number;
    totalElevGainM: number;
    firstDate: string | null;
    lastDate: string | null;
    visitedTilesZ15?: number;
    exploredCellsZ21?: number;
    exploredAreaKm2?: number;
  };
  visitedRegionCounts?: {
    l0: number;
    l1: number;
    l2: number;
    l3: number;
    total: number;
  };
  byYear: Array<{
    year: string;
    trackCount: number;
    distanceM: number;
    distanceKm: number;
    durationS: number;
    elevGainM: number;
    pointCount: number;
  }>;
}

export async function runStatsCommand(
  client: TraceveilClient,
  opts: {
    year?: string;
    month?: string;
    from?: string;
    to?: string;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  const params = new URLSearchParams();
  if (opts.year) params.set("year", opts.year);
  if (opts.month) params.set("month", opts.month);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);

  const qs = params.toString();
  const res = await client.getJson<StatsResponse>(
    `/api/agent/stats${qs ? `?${qs}` : ""}`
  );

  if (opts.jsonMode) {
    writeJson(res, Boolean(opts.pretty));
    return 0;
  }

  const s = res.stats;
  process.stdout.write(
    `Tracks      : ${s.trackCount}\n` +
      `Distance    : ${s.totalDistanceKm.toFixed(2)} km\n` +
      `Duration    : ${formatDurationHuman(s.totalDurationS)}\n` +
      `Elev Gain   : ${s.totalElevGainM} m\n` +
      `Points      : ${s.totalPoints}\n` +
      `Date Range  : ${s.firstDate ?? "-"} .. ${s.lastDate ?? "-"}\n`
  );
  if (typeof s.exploredAreaKm2 === "number") {
    process.stdout.write(
      `Fog Explored: ${s.exploredAreaKm2} km^2 (${s.visitedTilesZ15 ?? 0} Z15 tiles)\n`
    );
  }
  if (res.visitedRegionCounts) {
    const r = res.visitedRegionCounts;
    process.stdout.write(
      `Regions     : L0=${r.l0}, L1=${r.l1}, L2=${r.l2}, L3=${r.l3} (total ${r.total})\n`
    );
  }
  if (res.byYear.length > 0) {
    process.stdout.write(`\nBy Year:\n`);
    for (const y of res.byYear) {
      process.stdout.write(
        `  ${y.year}: ${y.trackCount} tracks, ${y.distanceKm.toFixed(1)} km, ${formatDurationHuman(y.durationS)}, +${y.elevGainM} m\n`
      );
    }
  }
  return 0;
}
