import { parseArgs } from "node:util";

import type { CoordSystem } from "./analyze.ts";
import { ApiError, AuthRequiredError, TraceveilClient } from "./api.ts";
import { runAuthCommand } from "./commands/auth.ts";
import { runRegionsCommand } from "./commands/regions.ts";
import {
  runBboxCommand,
  runNearbyCommand,
  runWhereCommand
} from "./commands/spatial.ts";
import { runStatsCommand } from "./commands/stats.ts";
import { runTracksCommand } from "./commands/tracks.ts";
import { isJsonOutput, printError } from "./output.ts";

const HELP_TEXT = `traceveil - Agent-friendly CLI for querying Traceveil GPS tracks

Usage:
  traceveil <command> [options]

Auth Commands:
  traceveil auth login --url <https://host> [--device] [--port 8789] [--manual]
  traceveil auth status [--url <url>]
  traceveil auth logout

Query Commands:
  traceveil stats [--year YYYY] [--month YYYY-MM] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  traceveil tracks list [--from] [--to] [--region <name|rid>] [--country] [--query]
                        [--min-km] [--max-km] [--sort date|distance|duration|elev] [--asc] [--limit 20] [--offset 0]
  traceveil tracks show <id>
  traceveil tracks analyze <id> [--stop-radius 100] [--stop-min-min 5] [--max-waypoints 24]
  traceveil tracks points <id> [--from-ts <ts>] [--to-ts <ts>] [--max-points 100]
                               [--format json|gpx|geojson] [-o <file>]
  traceveil regions list [--level 0|1|2|3] [--country] [--parent <rid>] [--search <q>]
                         [--sort heat|days|area|recent|tracks] [--limit 50] [--offset 0]
  traceveil regions show <rid|name> [--level 0|1|2|3] [--country] [--limit 20] [--offset 0]
  traceveil where --at <iso-or-unix> [--window-hours 24]
  traceveil nearby --lat <lat> --lon <lon> [--radius 500] [--coord wgs84|gcj02] [--exact]
                   [--from] [--to] [--limit 20]
  traceveil bbox --min-lat <n> --min-lon <n> --max-lat <n> --max-lon <n>
                 [--coord wgs84|gcj02] [--from] [--to] [--limit 20]

Global Options:
  --url <url>      Override Traceveil base URL (or env TRACEVEIL_URL)
  --token <jwt>    Override Bearer token (or env TRACEVEIL_TOKEN)
  --json           Force compact JSON output (automatic when stdout is not a TTY)
  --pretty         Force human-readable output even when piped
  --no-cache       Bypass local GPSL0 blob cache
  -h, --help       Show help

Exit Codes:
  0  Success
  1  Usage, validation, or API error
  2  Authentication required / expired (run \`traceveil auth login\`)
`;

function parseOptNumber(val: string | undefined, name: string): number | undefined {
  if (val === undefined) return undefined;
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new Error(`Option --${name} must be a valid number (got "${val}")`);
  }
  return num;
}

function parseOptInt(val: string | undefined, name: string): number | undefined {
  if (val === undefined) return undefined;
  const num = Number.parseInt(val, 10);
  if (!Number.isFinite(num)) {
    throw new Error(`Option --${name} must be an integer (got "${val}")`);
  }
  return num;
}

function parseRequiredNumber(val: string | undefined, name: string): number {
  if (val === undefined) {
    throw new Error(`Missing required option --${name}`);
  }
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new Error(`Option --${name} must be a valid number (got "${val}")`);
  }
  return num;
}

function parseCoordOpt(val: string | undefined): CoordSystem | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase();
  if (lower === "wgs84" || lower === "gcj02") return lower;
  throw new Error(`Invalid --coord "${val}". Expected wgs84 or gcj02.`);
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        pretty: { type: "boolean" },
        url: { type: "string" },
        token: { type: "string" },
        "no-cache": { type: "boolean" },
        // auth
        device: { type: "boolean" },
        port: { type: "string" },
        "redirect-uri": { type: "string" },
        manual: { type: "boolean" },
        "no-browser": { type: "boolean" },
        scope: { type: "string" },
        issuer: { type: "string" },
        "client-id": { type: "string" },
        // stats & filters
        year: { type: "string" },
        month: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        region: { type: "string" },
        country: { type: "string" },
        query: { type: "string", short: "q" },
        "min-km": { type: "string" },
        "max-km": { type: "string" },
        sort: { type: "string" },
        asc: { type: "boolean" },
        limit: { type: "string" },
        offset: { type: "string" },
        // track analyze & points
        "stop-radius": { type: "string" },
        "stop-min-min": { type: "string" },
        "max-waypoints": { type: "string" },
        "from-ts": { type: "string" },
        "to-ts": { type: "string" },
        "max-points": { type: "string" },
        format: { type: "string" },
        output: { type: "string", short: "o" },
        // regions
        level: { type: "string" },
        parent: { type: "string" },
        search: { type: "string" },
        // spatial & where
        at: { type: "string" },
        "window-hours": { type: "string" },
        lat: { type: "string" },
        lon: { type: "string" },
        radius: { type: "string" },
        coord: { type: "string" },
        exact: { type: "boolean" },
        "min-lat": { type: "string" },
        "min-lon": { type: "string" },
        "max-lat": { type: "string" },
        "max-lon": { type: "string" }
      }
    });
  } catch (err) {
    const jsonMode = process.argv.includes("--json") || (!process.stdout.isTTY && !process.argv.includes("--pretty"));
    printError(err, "invalid_args", jsonMode);
    return 1;
  }

  const { values, positionals } = parsed;
  const jsonMode = isJsonOutput({ json: values.json, pretty: values.pretty });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const [cmd, subcmd, ...rest] = positionals;

  try {
    if (cmd === "auth") {
      if (!subcmd) {
        throw new Error("Usage: traceveil auth <login|status|logout>");
      }
      return await runAuthCommand(subcmd, {
        url: values.url,
        device: values.device,
        port: parseOptInt(values.port, "port"),
        redirectUri: values["redirect-uri"],
        manual: values.manual,
        noBrowser: values["no-browser"],
        scope: values.scope,
        issuer: values.issuer,
        clientId: values["client-id"],
        jsonMode,
        pretty: values.pretty
      });
    }

    const client = new TraceveilClient({
      url: values.url,
      token: values.token
    });

    if (cmd === "stats") {
      return await runStatsCommand(client, {
        year: values.year,
        month: values.month,
        from: values.from,
        to: values.to,
        jsonMode,
        pretty: values.pretty
      });
    }

    if (cmd === "tracks") {
      if (!subcmd) {
        throw new Error("Usage: traceveil tracks <list|show|analyze|points>");
      }
      return await runTracksCommand(client, subcmd, rest, {
        from: values.from,
        to: values.to,
        region: values.region,
        country: values.country,
        query: values.query,
        minKm: parseOptNumber(values["min-km"], "min-km"),
        maxKm: parseOptNumber(values["max-km"], "max-km"),
        sort: values.sort,
        asc: values.asc,
        limit: parseOptInt(values.limit, "limit"),
        offset: parseOptInt(values.offset, "offset"),
        stopRadius: parseOptNumber(values["stop-radius"], "stop-radius"),
        stopMinMin: parseOptNumber(values["stop-min-min"], "stop-min-min"),
        maxWaypoints: parseOptInt(values["max-waypoints"], "max-waypoints"),
        fromTs: values["from-ts"],
        toTs: values["to-ts"],
        maxPoints: parseOptInt(values["max-points"], "max-points"),
        format: values.format,
        output: values.output,
        noCache: values["no-cache"],
        jsonMode,
        pretty: values.pretty
      });
    }

    if (cmd === "regions") {
      if (!subcmd) {
        throw new Error("Usage: traceveil regions <list|show>");
      }
      return await runRegionsCommand(client, subcmd, rest, {
        level: parseOptInt(values.level, "level"),
        country: values.country,
        parent: parseOptInt(values.parent, "parent"),
        search: values.search ?? values.query,
        sort: values.sort,
        limit: parseOptInt(values.limit, "limit"),
        offset: parseOptInt(values.offset, "offset"),
        jsonMode,
        pretty: values.pretty
      });
    }

    if (cmd === "where") {
      if (!values.at) {
        throw new Error("Usage: traceveil where --at <iso-or-unix> [--window-hours 24]");
      }
      return await runWhereCommand(client, {
        at: values.at,
        windowHours: parseOptNumber(values["window-hours"], "window-hours"),
        noCache: values["no-cache"],
        jsonMode,
        pretty: values.pretty
      });
    }

    if (cmd === "nearby") {
      return await runNearbyCommand(client, {
        lat: parseRequiredNumber(values.lat, "lat"),
        lon: parseRequiredNumber(values.lon, "lon"),
        radius: parseOptNumber(values.radius, "radius"),
        coord: parseCoordOpt(values.coord),
        exact: values.exact,
        from: values.from,
        to: values.to,
        limit: parseOptInt(values.limit, "limit"),
        noCache: values["no-cache"],
        jsonMode,
        pretty: values.pretty
      });
    }

    if (cmd === "bbox") {
      return await runBboxCommand(client, {
        minLat: parseRequiredNumber(values["min-lat"], "min-lat"),
        minLon: parseRequiredNumber(values["min-lon"], "min-lon"),
        maxLat: parseRequiredNumber(values["max-lat"], "max-lat"),
        maxLon: parseRequiredNumber(values["max-lon"], "max-lon"),
        coord: parseCoordOpt(values.coord),
        from: values.from,
        to: values.to,
        limit: parseOptInt(values.limit, "limit"),
        jsonMode,
        pretty: values.pretty
      });
    }

    throw new Error(`Unknown command "${cmd}". Run \`traceveil --help\` for usage.`);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      printError(err, err.code, jsonMode);
      return 2;
    }
    if (err instanceof ApiError) {
      printError(err, err.code, jsonMode);
      return 1;
    }
    printError(err, "cli_error", jsonMode);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
