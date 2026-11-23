import type { AgentRegionItem, AgentTrackItem, TraceveilClient } from "../api.ts";
import { formatDurationHuman, writeJson } from "../output.ts";

export interface RegionsListResponse {
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  regions: AgentRegionItem[];
}

export interface RegionDetailResponse {
  region: AgentRegionItem;
  ancestors: AgentRegionItem[];
  children: AgentRegionItem[];
  tracksTotal: number;
  tracksTruncated: boolean;
  tracks: Array<
    AgentTrackItem & {
      regionCellCount: number;
      regionFirstTs: number;
      regionLastTs: number;
      regionFirstIso: string | null;
      regionLastIso: string | null;
    }
  >;
}

const SORT_ALIAS: Record<string, string> = {
  heat: "heat",
  days: "visit_days",
  visit_days: "visit_days",
  area: "explored_area",
  explored_area: "explored_area",
  recent: "last_ts",
  last_ts: "last_ts",
  tracks: "track_count",
  track_count: "track_count"
};

export async function runRegionsCommand(
  client: TraceveilClient,
  subcmd: string,
  posArgs: string[],
  flags: {
    level?: number;
    country?: string;
    parent?: number;
    search?: string;
    sort?: string;
    limit?: number;
    offset?: number;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  if (subcmd === "list") {
    const params = new URLSearchParams();
    if (typeof flags.level === "number") params.set("level", String(flags.level));
    if (flags.country) params.set("country", flags.country);
    if (typeof flags.parent === "number") params.set("parent_id", String(flags.parent));
    if (flags.search) params.set("q", flags.search);
    if (flags.sort) {
      params.set("sort", SORT_ALIAS[flags.sort] ?? flags.sort);
    }
    if (typeof flags.limit === "number") params.set("limit", String(flags.limit));
    if (typeof flags.offset === "number") params.set("offset", String(flags.offset));

    const res = await client.getJson<RegionsListResponse>(
      `/api/agent/regions?${params.toString()}`
    );

    if (flags.jsonMode) {
      writeJson(res, Boolean(flags.pretty));
      return 0;
    }

    process.stdout.write(
      `Visited Regions (${res.regions.length} of ${res.total}):\n`
    );
    for (const r of res.regions) {
      const name = r.nameZh && r.nameZh !== r.nameEn ? `${r.nameZh} (${r.nameEn})` : r.nameEn || r.nameZh;
      process.stdout.write(
        `  [L${r.level} rid=${String(r.rid).padEnd(8)}] ${name} [${r.country}]  days=${r.visitDays}  tracks=${r.trackCount}  area=${r.exploredAreaKm2.toFixed(3)}/${r.areaKm2.toFixed(1)} km2  heat=${r.heat.toFixed(3)}\n`
      );
    }
    return 0;
  }

  if (subcmd === "show") {
    const target = posArgs[0];
    if (!target) throw new Error("Usage: traceveil regions show <rid|name>");

    let rid: number;
    if (/^\d+$/.test(target.trim())) {
      rid = Number.parseInt(target.trim(), 10);
    } else {
      const searchParams = new URLSearchParams({
        q: target.trim(),
        limit: "10"
      });
      if (typeof flags.level === "number") searchParams.set("level", String(flags.level));
      if (flags.country) searchParams.set("country", flags.country);
      const candidates = await client.getJson<RegionsListResponse>(
        `/api/agent/regions?${searchParams.toString()}`
      );
      if (candidates.regions.length === 0) {
        throw new Error(`No visited region matching "${target}"`);
      }
      const lower = target.trim().toLowerCase();
      const exact = candidates.regions.find(
        (r) =>
          r.nameZh.toLowerCase() === lower || r.nameEn.toLowerCase() === lower
      );
      rid = (exact ?? candidates.regions[0]).rid;
    }

    const params = new URLSearchParams();
    if (typeof flags.limit === "number") params.set("limit", String(flags.limit));
    if (typeof flags.offset === "number") params.set("offset", String(flags.offset));
    const qs = params.toString();

    const res = await client.getJson<RegionDetailResponse>(
      `/api/agent/regions/${rid}${qs ? `?${qs}` : ""}`
    );

    if (flags.jsonMode) {
      writeJson(res, Boolean(flags.pretty));
      return 0;
    }

    const r = res.region;
    const chain = [...res.ancestors, r]
      .map((a) => a.nameZh || a.nameEn)
      .join(" > ");
    process.stdout.write(
      `Region     : ${chain} (L${r.level}, rid=${r.rid}, ${r.country})\n` +
        `Visit Days : ${r.visitDays} (${r.first_iso ?? "-"} .. ${r.last_iso ?? "-"})\n` +
        `Tracks     : ${r.trackCount}\n` +
        `Explored   : ${r.exploredAreaKm2.toFixed(3)} / ${r.areaKm2.toFixed(1)} km2 (${(r.coverage_ratio * 100).toFixed(2)}%)\n` +
        `Heat       : ${r.heat.toFixed(3)}\n`
    );
    if (res.children.length > 0) {
      process.stdout.write(`Visited Children (${res.children.length}):\n`);
      for (const c of res.children) {
        process.stdout.write(
          `  [L${c.level} rid=${c.rid}] ${c.nameZh || c.nameEn} (${c.visitDays}d, ${c.trackCount} tracks)\n`
        );
      }
    }
    if (res.tracks.length > 0) {
      process.stdout.write(`Tracks (${res.tracks.length} of ${res.tracksTotal}):\n`);
      for (const t of res.tracks) {
        process.stdout.write(
          `  ${t.date}  ${t.id}  ${t.distance_km.toFixed(2)} km  ${formatDurationHuman(t.duration_s)}  ${t.title}\n`
        );
      }
    }
    return 0;
  }

  throw new Error(`Unknown regions subcommand: ${subcmd}. Expected list | show.`);
}
