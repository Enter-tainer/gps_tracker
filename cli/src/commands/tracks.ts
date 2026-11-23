import fs from "node:fs";
import path from "node:path";

import {
  analyzeTrack,
  decodeTrackPoints,
  downsamplePoints,
  formatGeoJson,
  formatGpx
} from "../analyze.ts";
import type {
  AgentTrackItem,
  AgentTrackRegionRef,
  TraceveilClient
} from "../api.ts";
import {
  formatDurationHuman,
  parseTimestampFlag,
  writeJson
} from "../output.ts";

export interface TracksListResponse {
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  tracks: AgentTrackItem[];
}

export interface TrackDetailResponse {
  track: AgentTrackItem;
  regions: AgentTrackRegionRef[];
}

export async function runTracksCommand(
  client: TraceveilClient,
  subcmd: string,
  posArgs: string[],
  flags: {
    from?: string;
    to?: string;
    region?: string;
    country?: string;
    query?: string;
    minKm?: number;
    maxKm?: number;
    sort?: string;
    asc?: boolean;
    limit?: number;
    offset?: number;
    stopRadius?: number;
    stopMinMin?: number;
    maxWaypoints?: number;
    fromTs?: string;
    toTs?: string;
    maxPoints?: number;
    format?: string;
    output?: string;
    noCache?: boolean;
    jsonMode: boolean;
    pretty?: boolean;
  }
): Promise<number> {
  if (subcmd === "list") {
    const params = new URLSearchParams();
    if (flags.from) params.set("from", flags.from);
    if (flags.to) params.set("to", flags.to);
    if (flags.region) {
      if (/^\d+$/.test(flags.region.trim())) {
        params.set("region_id", flags.region.trim());
      } else {
        params.set("region", flags.region.trim());
      }
    }
    if (flags.country) params.set("country", flags.country);
    if (flags.query) params.set("q", flags.query);
    if (typeof flags.minKm === "number") {
      params.set("min_distance_m", String(Math.round(flags.minKm * 1000)));
    }
    if (typeof flags.maxKm === "number") {
      params.set("max_distance_m", String(Math.round(flags.maxKm * 1000)));
    }

    const sortBase = flags.sort || "date";
    const sortDir = flags.asc ? "asc" : "desc";
    params.set("sort", `${sortBase}_${sortDir}`);
    if (typeof flags.limit === "number") params.set("limit", String(flags.limit));
    if (typeof flags.offset === "number") params.set("offset", String(flags.offset));

    const res = await client.getJson<TracksListResponse>(
      `/api/agent/tracks?${params.toString()}`
    );

    if (flags.jsonMode) {
      writeJson(res, Boolean(flags.pretty));
      return 0;
    }

    process.stdout.write(
      `Tracks (${res.tracks.length} of ${res.total}, offset=${res.offset}):\n`
    );
    for (const t of res.tracks) {
      process.stdout.write(
        `  ${t.date}  ${t.id.padEnd(26)}  ${t.distance_km.toFixed(2).padStart(7)} km  ${formatDurationHuman(t.duration_s).padStart(7)}  +${Math.round(t.elev_gain_m)}m  ${t.title}\n`
      );
    }
    if (res.truncated) {
      process.stdout.write(`  ... more results available (--offset ${res.offset + res.tracks.length})\n`);
    }
    return 0;
  }

  if (subcmd === "show") {
    const id = posArgs[0];
    if (!id) throw new Error("Usage: traceveil tracks show <track-id>");
    const res = await client.getJson<TrackDetailResponse>(
      `/api/agent/tracks/${encodeURIComponent(id)}`
    );

    if (flags.jsonMode) {
      writeJson(res, Boolean(flags.pretty));
      return 0;
    }

    const t = res.track;
    process.stdout.write(
      `ID        : ${t.id}\n` +
        `Title     : ${t.title}\n` +
        `Date      : ${t.date}\n` +
        `Time      : ${t.start_iso ?? t.start_time} .. ${t.end_iso ?? t.end_time}\n` +
        `Distance  : ${t.distance_km.toFixed(3)} km\n` +
        `Duration  : ${formatDurationHuman(t.duration_s)}\n` +
        `Elevation : +${Math.round(t.elev_gain_m)} m (min ${t.min_ele.toFixed(1)} m, max ${t.max_ele.toFixed(1)} m)\n` +
        `Points    : ${t.point_count}\n` +
        `BBox      : [${t.min_lon.toFixed(5)}, ${t.min_lat.toFixed(5)}, ${t.max_lon.toFixed(5)}, ${t.max_lat.toFixed(5)}]\n`
    );
    if (res.regions.length > 0) {
      process.stdout.write(`Regions   :\n`);
      for (const r of res.regions) {
        process.stdout.write(
          `  [L${r.level} rid=${r.rid}] ${r.nameZh || r.nameEn} (${r.nameEn}) - ${r.cellCount} cells\n`
        );
      }
    }
    return 0;
  }

  if (subcmd === "analyze") {
    const id = posArgs[0];
    if (!id) throw new Error("Usage: traceveil tracks analyze <track-id>");
    const detail = await client.getJson<TrackDetailResponse>(
      `/api/agent/tracks/${encodeURIComponent(id)}`
    );
    const bytes = await client.getTrackGpsl0(id, { noCache: flags.noCache });
    const points = decodeTrackPoints(bytes);
    const analysis = analyzeTrack(points, {
      stopRadiusM: flags.stopRadius ?? 100,
      stopMinDurationS: (flags.stopMinMin ?? 5) * 60,
      maxWaypoints: flags.maxWaypoints ?? 24
    });

    const outObj = {
      track: detail.track,
      regions: detail.regions,
      analysis
    };

    if (flags.jsonMode) {
      writeJson(outObj, Boolean(flags.pretty));
      return 0;
    }

    process.stdout.write(
      `Track ${detail.track.id} (${detail.track.title})\n` +
        `Decoded ${analysis.point_count} points, ${analysis.distance_km.toFixed(2)} km, ` +
        `${formatDurationHuman(analysis.duration_s)}, avg moving ${analysis.avg_moving_speed_kmh} km/h, ` +
        `max ${analysis.max_speed_kmh} km/h\n` +
        `Stops (${analysis.stops.length}):\n`
    );
    for (const s of analysis.stops) {
      process.stdout.write(
        `  #${s.index} ${s.start_iso}..${s.end_iso} (${formatDurationHuman(s.duration_s)}) at (${s.lat}, ${s.lon})\n`
      );
    }
    process.stdout.write(`Segments (${analysis.segments.length}):\n`);
    for (const seg of analysis.segments) {
      process.stdout.write(
        `  #${seg.index} [${seg.inferred_mode}] ${seg.distance_km} km in ${formatDurationHuman(seg.duration_s)} (${seg.avg_speed_kmh} km/h, +${seg.elev_gain_m}m)\n`
      );
    }
    return 0;
  }

  if (subcmd === "points") {
    const id = posArgs[0];
    if (!id) throw new Error("Usage: traceveil tracks points <track-id>");
    const detail = await client.getJson<TrackDetailResponse>(
      `/api/agent/tracks/${encodeURIComponent(id)}`
    );
    const bytes = await client.getTrackGpsl0(id, { noCache: flags.noCache });
    let points = decodeTrackPoints(bytes);
    const rawCount = points.length;

    if (flags.fromTs) {
      const minTs = parseTimestampFlag(flags.fromTs);
      points = points.filter((p) => p.ts >= minTs);
    }
    if (flags.toTs) {
      const maxTs = parseTimestampFlag(flags.toTs);
      points = points.filter((p) => p.ts <= maxTs);
    }

    const filteredCount = points.length;
    const format = (flags.format || "json").toLowerCase();
    const defaultMax = format === "json" ? 100 : 0;
    const maxPoints =
      typeof flags.maxPoints === "number" ? flags.maxPoints : defaultMax;
    if (maxPoints > 0 && points.length > maxPoints) {
      points = downsamplePoints(points, maxPoints);
    }

    let renderedText = "";
    if (format === "gpx") {
      renderedText = formatGpx(detail.track, points);
    } else if (format === "geojson") {
      renderedText = formatGeoJson(detail.track, points);
    } else if (format === "json") {
      const payload = {
        track_id: detail.track.id,
        raw_point_count: rawCount,
        filtered_point_count: filteredCount,
        returned_point_count: points.length,
        points: points.map((p) => ({
          ts: p.ts,
          iso: new Date(p.ts * 1000).toISOString(),
          lat: p.lat,
          lon: p.lon,
          alt: p.alt
        }))
      };
      if (flags.output) {
        renderedText = JSON.stringify(payload, null, 2) + "\n";
      } else if (flags.jsonMode) {
        writeJson(payload, Boolean(flags.pretty));
        return 0;
      } else {
        process.stdout.write(
          `Track ${detail.track.id}: ${points.length} points (of ${rawCount})\n`
        );
        for (const p of payload.points) {
          process.stdout.write(
            `  ${p.iso}  (${p.lat.toFixed(6)}, ${p.lon.toFixed(6)})  alt=${p.alt}m\n`
          );
        }
        return 0;
      }
    } else {
      throw new Error(`Unsupported --format "${format}". Expected json | gpx | geojson.`);
    }

    if (flags.output) {
      fs.mkdirSync(path.dirname(path.resolve(flags.output)), { recursive: true });
      fs.writeFileSync(flags.output, renderedText, "utf8");
      if (flags.jsonMode) {
        writeJson(
          {
            ok: true,
            track_id: detail.track.id,
            format,
            point_count: points.length,
            output_path: path.resolve(flags.output)
          },
          Boolean(flags.pretty)
        );
      } else {
        process.stdout.write(
          `Wrote ${points.length} points (${format}) to ${path.resolve(flags.output)}\n`
        );
      }
    } else {
      process.stdout.write(renderedText);
    }
    return 0;
  }

  throw new Error(
    `Unknown tracks subcommand: ${subcmd}. Expected list | show | analyze | points.`
  );
}
