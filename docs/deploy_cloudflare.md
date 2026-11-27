# Deploying Traceveil (frontend + Cloudflare backend)

The web app ships as **one Cloudflare Worker** that serves both the built SPA and the
`/api/*` data plane, backed by a D1 database and an R2 bucket:

```
browser ──► gps-fog-tracker (Worker)
              ├─ ASSETS  = frontend/dist (SPA shell, PWA manifest, /api/* passes through)
              ├─ TRACKS_DB (D1  "gps_tracks")  → tracks / track_blobs / track_tiles
              └─ TRACKS_BUCKET (R2 "gps-tracks") → fog/global-fog.bin
```

`wrangler.jsonc` is the source of truth for the bindings (`frontend/wrangler.jsonc`).
GitHub Pages (`deploy-frontend.yml`) still publishes the same `dist/` as a static demo,
but it has **no API** — `/api/*` there returns 404, so pages is only the shell.

## 1. One-time infrastructure

```bash
cd frontend

# R2 bucket for the fog-of-war bitmap (and any future large objects)
npx wrangler r2 bucket create gps-tracks

# D1 database; copy the returned database_id into wrangler.jsonc
npx wrangler d1 create gps_tracks
#   "d1_databases": [{ "binding": "TRACKS_DB", "database_name": "gps_tracks",
#                      "database_id": "<uuid>", "migrations_dir": "migrations" }]

# schema (tracks, track_tiles, track_blobs)
npx wrangler d1 migrations apply gps_tracks --remote
```

`database_id` is **not** a secret — it is a public identifier and belongs in the config,
otherwise every `wrangler deploy` fails on the `00000000-…` placeholder.

## 2. Data

`local-data/` is git-ignored and produced locally from your own tracks:

```bash
cd frontend
npm run ingest      # downloads/ETLs source tracks into local-data/{index.json,d1/seed.sql,r2/…}
npm run sync:cf     # migrations + seed.sql into D1, fog bitmap into R2 (--remote)
npm run sync:cf -- --local   # same, against the local miniflare state
```

`npm run ingest` also packs every track into GPSL0 v3 (`version = 2, model_id = 22` by default,
`local-data/r2/tracks-gpsl0/*.gpsl0`, 123 files / 1,079,995 B for this corpus; legacy `v1` was
1,171,096 B, remaining decodable for migration) and stores the blobs
inline in `track_blobs`, so no per-track R2 objects are needed. `seed.sql` (~4 MB scale, 530
statements, largest ~44 KB) seeds in a single `wrangler d1 execute --file` call (~10 s — under
D1's per-statement limit). If the corpus grows past ~100 MB, split it first.

## 3. Deploy

```bash
cd frontend
npm run deploy:cf     # npm run build && npx wrangler deploy
```

Output ends with the worker URL (`https://gps-fog-tracker.<account>.workers.dev`) and a
Version ID. `preview_urls` is deliberately `false`: version preview URLs would otherwise
expose a second public hostname for the same data.

### Custom domain

Attach it in the dashboard (Workers → gps-fog-tracker → Settings → Domains & Routes), or
declare it in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "gpx.example.com", "custom_domain": true }]
```

## 4. Verification

```bash
# data plane (works without going through the public hostname)
npx wrangler d1 execute gps_tracks --remote --json \
  --command "SELECT count(*) tracks, sum(length(data)) blob_bytes FROM track_blobs"

# edge
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/bootstrap
```

A healthy private deploy answers **302** (Cloudflare Access login) when unauthenticated,
and `200 application/json` once the session cookie is present. Compare a served blob
byte-for-byte if in doubt: `SELECT hex(data) FROM track_blobs WHERE track_id=?` then hash
it against `local-data/r2/tracks-gpsl0/<id>.gpsl0`.

## 5. Private deployment: Cloudflare Access caveats

If the hostname is behind Cloudflare Access (recommended — the archive is personal data),
two things break and are easy to miss:

- **The web app manifest never loads.** Browsers fetch `manifest.json` *without*
  credentials, so Access redirects it to `<team>.cloudflareaccess.com`, which is a
  different origin without `Access-Control-Allow-Origin` → the console fills with
  `blocked by CORS policy` and the app is not installable. Fix: add an Access
  application for the hostname with path `manifest.json` (and `manifest.webmanifest`)
  whose policy action is **Bypass**. The manifest contains no data, so this is safe.
- **Service-worker updates can be swallowed.** `sw.js` is fetched with credentials, so it
  works while logged in, but an expired session turns an update check into a login HTML
  document. If the PWA starts behaving oddly, clear the SW registration
  (DevTools → Application → Service Workers → Unregister).

Other routes stay protected; all data is under `/api/*`, so protecting the whole hostname
protects all track data.

> **Agent / CLI Access (Managed OAuth)**: To let an AI agent or the `traceveil` CLI query
> read-only tracks via `/api/agent/*` behind Cloudflare Access Managed OAuth, follow
> [docs/agent_cli_setup.md](agent_cli_setup.md).

## 6. Upgrading Existing Remote D1 Blobs (`v1` -> `v3 m22`)

Because the Worker passes raw `track_blobs` bytes through unchanged and decoding happens in the
browser WASM / CLI, **always deploy the v3-capable (`model_id = 22`) Worker & WASM frontend
(`npm run deploy:cf`) before upgrading stored D1 rows**. Legacy `v1` blobs keep working after the
frontend update; conversely, older clients cannot decode `model_id = 22` blobs.

1. Inspect and verify a full decode -> re-encode -> verify pass without writing to remote D1:

```bash
cd frontend
npm run gpsl0:migrate-d1 -- --remote --dry-run
```

2. Once the updated frontend is live, apply the chunked migration (`version=2, model_id=22` and `--alt-quantum=10` = 1 m altitude quantization by default):

```bash
cd frontend
npm run gpsl0:migrate-d1 -- --remote --apply --confirm-frontend-deployed
```

(Any row already at `version=2` with `model_id=22` is skipped idempotently; legacy `v1` rows are upgraded in place.)

Every run backs up the original blobs under `blobs/*.gpsl0`, writes `manifest.json`, chunked
`migrate-chunk-*.sql` files, and `rollback.sql` under
`frontend/scripts/.cache/d1-v1-backup-<timestamp>/` (override with `--backup-dir=<DIR>`), and
post-verifies that migrated rows carry `version=2, model_id=22` headers. If anything needs to be
reverted, execute the generated `rollback.sql` against D1 (`npx wrangler d1 execute gps_tracks --remote --file=<backup-dir>/rollback.sql`).

## 7. Teardown

```bash
cd frontend
npx wrangler delete gps-fog-tracker
npx wrangler d1 delete gps_tracks
npx wrangler r2 bucket delete gps-tracks
```

`frontend/local-data/` stays on disk; nothing personal is committed to git
(`local-data/`, `*.gpx`, `*.gpz` are ignored).
