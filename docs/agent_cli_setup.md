# Agent CLI & Cloudflare Access OIDC Setup

This guide explains how to connect the `traceveil` CLI and Agent Skill to a
Cloudflare-hosted Traceveil deployment protected by **Cloudflare Access** using
**Cloudflare Access for SaaS (OIDC)** — without exposing your existing web write
endpoints (`/api/tracks/upload`, `DELETE /api/tracks/:id`, `PUT /api/fog`).

## Architecture Overview

```text
1. Desktop / Laptop (PKCE Browser Flow)
   traceveil auth login --url https://gpx.example.com
     -> opens Cloudflare Access OIDC authorization URL
     -> redirects back to http://127.0.0.1:8789/callback with auth code
     -> CLI exchanges code + code_verifier at Cloudflare token endpoint
     -> saves access_token + refresh_token locally

2. Remote / SSH / Headless (Device Flow Bridge)
   traceveil auth login --url https://gpx.example.com --device
     -> CLI generates PKCE pair, calls POST /api/agent/auth/device/start
     -> User opens verification URL on any browser & completes Cloudflare Access login
     -> Worker callback stores one-time code; CLI polls & exchanges code + verifier

3. Read-Only Agent Queries
   traceveil stats / tracks / regions / where / nearby
     -> Authorization: Bearer <OIDC JWT>
     -> Worker verifies JWT signature against Cloudflare JWKS + iss + aud + email
     -> Pure D1/R2 read-only queries; GPSL0 blobs decoded & cached locally by CLI
```

---

## Step 1: Apply D1 Migration (`0003_agent_device_auth.sql`)

If you use `--device` login (or want full schema parity), apply the migration:

```bash
cd frontend
npx wrangler d1 migrations apply gps_tracks --remote
# Also for local dev if desired:
npx wrangler d1 migrations apply gps_tracks --local
```

---

## Step 2: Create a Cloudflare Access for SaaS (OIDC) Application

In the **Cloudflare Zero Trust Dashboard**:

1. Navigate to **Access** -> **Applications** -> **Add an application** -> **SaaS**.
2. Choose **OIDC** as the authentication protocol.
3. Configure **Redirect URLs** (add both):
   - `http://127.0.0.1:8789/callback` (for desktop `traceveil auth login`)
   - `https://<your-traceveil-host>/api/agent/auth/device/callback` (for headless `--device` flow)
4. Enable **PKCE** and enable **Allow PKCE without client secret** (`allow_pkce_without_client_secret`) so the CLI acts as a public OAuth client without embedding a secret.
5. Enable **Refresh Tokens** and set your desired Access Token lifetime (e.g. `1h`) and Refresh Token lifetime (e.g. `30d`).
6. Attach an **Access Policy** allowing only your identity (e.g., `Include -> Emails -> you@example.com`).
7. Copy the generated OIDC values from the SaaS app page:
   - **Client ID** (also used as `OIDC_AUD`)
   - **Issuer URL** (format: `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`)

---

## Step 3: Bypass Cloudflare Access Only for `/api/agent/*`

Because `/api/agent/*` authenticates via OIDC `Bearer` JWT tokens verified inside
the Worker, Cloudflare Access must not intercept those API paths with a 302
HTML login redirect:

1. Keep your existing **Self-hosted Access Application** protecting `https://<your-traceveil-host>` (all SPA pages and `/api/bootstrap`, `/api/tracks/upload`, `DELETE`, `PUT /api/fog` stay locked behind Access!).
2. Create an additional **Self-hosted Access Application** for:
   - Domain: `<your-traceveil-host>`
   - Path: `api/agent/*`
   - Policy action: **Bypass** (for **Everyone**).
   - *(Tip: if you use `workers.dev` only without a custom domain, consider disabling `workers_dev` once a custom domain is attached so traffic only enters through your Access-protected hostname.)*

Security note: The `/api/agent/*` router only exposes read-only query endpoints
plus OIDC public discovery and PKCE-bound device flow endpoints. No write or
delete operations exist under `/api/agent/*`, and all query routes verify the
RS256/ES256 OIDC JWT against Cloudflare's JWKS before touching D1 or R2.

---

## Step 4: Configure Worker Environment Variables & Deploy

Set the OIDC variables on your Worker (either via `wrangler secret put` or the
Cloudflare Dashboard -> Workers & Pages -> `gps-fog-tracker` -> Settings ->
Variables and Secrets):

```bash
cd frontend
npx wrangler secret put OIDC_ISSUER
# paste: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>

npx wrangler secret put OIDC_CLIENT_ID
# paste: <client-id>

npx wrangler secret put OIDC_ALLOWED_EMAILS
# optional defense-in-depth allowlist, e.g.: you@example.com
```

Optional variables:
- `OIDC_AUD`: defaults to `OIDC_CLIENT_ID` if omitted.
- `OIDC_SCOPES`: defaults to `openid email profile`.

Then build and deploy the Worker:

```bash
cd frontend
npm run deploy:cf
```

Verify the public discovery endpoint responds (and `/api/agent/stats` returns `401`, NOT `302`!):

```bash
curl -sS https://<your-traceveil-host>/api/agent/auth/config
curl -sS -o /dev/null -w '%{http_code}\n' https://<your-traceveil-host>/api/agent/stats
# Expected: 401
```

---

## Step 5: Build & Install the `traceveil` CLI

Requires **Node.js >= 20**.

```bash
cd cli
npm install
npm run build
npm link   # exposes `traceveil` globally on your PATH
```

Verify installation and log in:

```bash
traceveil --help
traceveil auth login --url https://<your-traceveil-host>
# Or on SSH / headless environments:
traceveil auth login --url https://<your-traceveil-host> --device

# Check status and run a test query:
traceveil auth status
traceveil stats
```

### Local Development Mode (No Cloudflare Required)

When running `cd frontend && npm run dev` (`http://localhost:3000`) with
`local-data/` populated, `vite-local-api.ts` serves matching `/api/agent/*`
endpoints locally with no OIDC needed:

```bash
traceveil --url http://localhost:3000 stats
traceveil --url http://localhost:3000 tracks list --limit 5
```

---

## Step 6: Install the Agent Skill

Copy or symlink `skills/traceveil` into your agent's skills directory, for example:
- Project-local / repo-aware agents: already available at `skills/traceveil/SKILL.md`.
- User-global skill directory (varies by agent, e.g. `~/.codex/skills/traceveil` or `~/.claude/skills/traceveil`).
