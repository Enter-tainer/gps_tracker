---
name: traceveil
description: >
  Query personal GPS track history, travel statistics, visited administrative
  regions (countries, provinces, cities, districts), location at a specific
  timestamp, and spatial proximity ("have I been near X?") using the
  `traceveil` CLI backed by Cloudflare Access Managed OAuth. Trigger whenever
  the user asks about past trips, mileage, elevation gain, places visited,
  where they were at a given date/time, or wants to analyze or export a GPS
  track.
---

# Traceveil GPS Track Query Skill

Use the `traceveil` CLI to query personal GPS tracks, visited administrative
regions, and locally decoded GPSL0 track details.

## 1. Authentication Preflight (Required First Step)

Always check session status before running query commands:

```bash
traceveil auth status --json
```

- **Exit code `0`**: Authenticated (or targeting local dev server with `--url`).
  Proceed with query commands.
- **Exit code `2`** (`"error": "auth_required"`): Not logged in or session
  expired. **Do NOT try to bypass Cloudflare Access or scrape web pages.** Ask
  the user to authenticate interactively in their terminal via Cloudflare
  Access Managed OAuth:
  - Local / desktop browser (opens browser automatically and receives callback on `localhost`):
    ```bash
    traceveil auth login --url https://<your-traceveil-host>
    ```
  - Remote / SSH / cross-device (no local browser):
    ```bash
    traceveil auth login --url https://<your-traceveil-host> --manual
    ```
    The CLI prints an authorization URL. Have the user open it in any browser,
    complete Cloudflare Access login, copy the redirected `http://localhost:8400/callback?code=...&state=...`
    URL from the address bar (the browser page itself failing to load on a remote
    device is expected), and paste it back into the CLI prompt.
  Wait until login succeeds, then re-run `traceveil auth status --json`.

*(Note: When stdout is piped by an agent, `traceveil` emits compact JSON
automatically; passing `--json` explicitly guarantees machine-readable output
and structured `{ "error": ..., "message": ... }` errors. Access tokens auto-refresh
transparently using `refresh_token` while the grant session remains valid.)*

## 2. Intent -> Command Routing

| User Question / Intent | Command |
| --- | --- |
| Overall stats, total km/hours/elevation, yearly summary | `traceveil stats [--year YYYY \| --month YYYY-MM \| --from YYYY-MM-DD --to YYYY-MM-DD] --json` |
| List tracks by date range, region, country, title, or distance | `traceveil tracks list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--region <name\|rid>] [--country CN] [--query <text>] [--min-km N] [--sort date\|distance\|duration\|elev] [--limit 20] --json` |
| Inspect metadata and crossed regions for one track | `traceveil tracks show <track_id> --json` |
| Trip breakdown: stops/dwell locations, moving segments, speeds, waypoints | `traceveil tracks analyze <track_id> [--stop-radius 100] [--stop-min-min 5] --json` |
| Where was I at a specific date/time? | `traceveil where --at <ISO-8601-or-unix> [--window-hours 24] --json` |
| Have I ever been near `(lat, lon)`? When & how close? | `traceveil nearby --lat <lat> --lon <lon> [--radius 500] [--coord wgs84\|gcj02] --exact [--from YYYY-MM-DD] --json` |
| Tracks inside a geographic bounding box | `traceveil bbox --min-lat S --min-lon W --max-lat N --max-lon E [--coord wgs84\|gcj02] --json` |
| Which countries / provinces / cities / districts have I visited? | `traceveil regions list [--level 0\|1\|2\|3] [--country CN] [--search <name>] [--sort heat\|days\|area\|recent\|tracks] --json` |
| Details, parent/child hierarchy, and tracks in a region | `traceveil regions show <rid\|name> [--limit 20] --json` |
| Export downsampled points or GPX / GeoJSON file | `traceveil tracks points <track_id> [--from-ts <ts>] [--to-ts <ts>] [--max-points 100] [--format json\|gpx\|geojson] [-o <file>]` |

## 3. Critical Rules & Pitfalls

1. **Coordinate Systems (`wgs84` vs `gcj02`)**:
   - Stored tracks are in **WGS-84**.
   - Coordinates from Chinese map apps (Gaode/Amap, Tencent Maps, Baidu-converted
     GCJ-02) are offset by ~100-700 m. If the user supplies coordinates from a
     Chinese map service (or asks about a Chinese POI looked up on Amap/Tencent),
     pass `--coord gcj02` to `nearby` / `bbox` so the CLI converts them to WGS-84
     automatically.
2. **Always prefer `--exact` on `nearby` when precision matters**:
   - Without `--exact`, `nearby` returns coarse Z15 Web Mercator tile candidates
     (~1.2 km grid). Add `--exact` to download/cache the `.gpsl0` track locally
     and compute exact minimum distance in meters (`min_distance_m`), closest
     timestamp (`closest_iso`), and dwell intervals (`visits`).
3. **Preserve Context Window**:
   - Never dump full-resolution `tracks points` into stdout unless explicitly
     inspecting a small time slice (`--from-ts` / `--to-ts` with `--max-points`).
   - Prefer `tracks analyze <id>` first — it returns stops, moving segments,
     inferred travel mode, elevation gain, and ~24 key waypoints in compact JSON.
   - Check `"truncated": true` in list responses and paginate with `--offset` if
     needed.
4. **Timezone Clarity**:
   - API timestamps (`start_iso`, `end_iso`, `at_iso`) are UTC ISO-8601 strings,
     while track `date` reflects the track's recorded local date. When calling
     `traceveil where --at`, include an explicit timezone offset when known
     (e.g., `2025-10-03T14:30:00+08:00`).
