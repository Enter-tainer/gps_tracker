# Agent CLI & Cloudflare Access Managed OAuth Setup

This guide explains how to connect the `traceveil` CLI and Agent Skill to a
Cloudflare-hosted Traceveil deployment protected by **Cloudflare Access** using
**Cloudflare Access Managed OAuth (Beta)** — with **zero** extra SaaS apps and
**zero** Access Bypass rules.

## Architecture Overview

```text
1. Desktop / Laptop Login (RFC 9728 / RFC 8414 / RFC 7591 + PKCE + RFC 8707)
   traceveil auth login --url https://gps-fog-tracker.<team>.workers.dev
     -> probes /api/agent/me (Accept: application/json) -> 401 + resource_metadata
     -> fetches Authorization Server metadata (/.well-known/oauth-authorization-server)
     -> dynamically registers a public PKCE client (localhost / 127.0.0.1 callback)
     -> opens browser for normal Cloudflare Access login (Email OTP / SSO)
     -> exchanges code + code_verifier + resource for access_token & refresh_token

2. Cross-Device / SSH Login (--manual)
   traceveil auth login --url https://gps-fog-tracker.<team>.workers.dev --manual
     -> prints the authorization URL
     -> open URL in any browser -> copy the redirected http://localhost:8400/callback?code=... URL
     -> paste it back into the CLI prompt

3. Agent Queries (/api/agent/*)
   traceveil stats / tracks / regions / where / nearby
     -> Authorization: Bearer <access_token> (auto-refreshed via refresh_token)
     -> Cloudflare Access verifies Bearer token at the edge & injects Cf-Access-Jwt-Assertion
     -> Worker runs pure D1/R2 read-only queries; GPSL0 blobs decoded & cached locally
```

---

## Step 1: Enable Managed OAuth on Your Existing Access Application

In the **Cloudflare Zero Trust Dashboard**:

1. Open **Access** -> **Applications** and select your existing Traceveil application.
2. Open **Settings / Other settings** -> **OAuth** -> expand **Managed OAuth (Beta)**:
   - Turn **Managed OAuth** **ON**.
   - Turn **Allow localhost clients** **ON**.
   - Turn **Allow loopback clients** **ON**.
   - Recommended lifetimes:
     - **Grant session duration** (refresh token lifetime): e.g. `7d`–`30d` (or same as session).
     - **Access token lifetime**: default `15m` (CLI silently refreshes with `refresh_token`).
3. Save the application.

No Bypass rules and no separate SaaS OIDC application are required.

---

## Step 2: Deploy the Worker

```bash
cd frontend
npx wrangler d1 migrations apply gps_tracks --remote
npm run deploy:cf
```

### Optional: Defense-in-Depth JWT Signature Verification inside the Worker

By default, `/api/agent/*` accepts requests authenticated by Cloudflare Access
at the edge (`Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email`, or
`Authorization: Bearer ...`). For extra defense-in-depth (verifying the RS256/ES256
signature of `Cf-Access-Jwt-Assertion` inside the Worker itself against
`/cdn-cgi/access/certs`), optionally set:

```bash
cd frontend
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
# e.g. https://<team>.cloudflareaccess.com

npx wrangler secret put CF_ACCESS_AUD
# optional: Application Audience (AUD) tag from Access -> Application -> Overview

npx wrangler secret put CF_ACCESS_ALLOWED_EMAILS
# optional comma-separated allowlist, e.g. you@example.com
```

Verify Managed OAuth discovery from the terminal:

```bash
curl -sS -o /dev/null -D - -H "Accept: application/json" https://<your-traceveil-host>/api/agent/me
# Expected: HTTP 401 with Www-Authenticate: Bearer ..., resource_metadata="..."
```

---

## Step 3: Build & Install the `traceveil` CLI

Requires **Node.js >= 20**.

```bash
cd cli
npm install
npm run build
npm link   # exposes `traceveil` globally on your PATH
```

Log in and run a query:

```bash
# Local browser login:
traceveil auth login --url https://<your-traceveil-host>

# Remote / SSH / cross-device login:
traceveil auth login --url https://<your-traceveil-host> --manual

# Check status and query tracks:
traceveil auth status
traceveil stats
```

Credentials are stored with `0600` permissions in your OS application data directory
(not cache):
- Windows: `%LOCALAPPDATA%\traceveil\oauth.json`
- macOS: `~/Library/Application Support/traceveil/oauth.json`
- Linux: `$XDG_DATA_HOME/traceveil/oauth.json` (default `~/.local/share/traceveil/oauth.json`)

Override via `--token`, `TRACEVEIL_TOKEN`, `TRACEVEIL_AUTH_FILE`, or `TRACEVEIL_CONFIG_DIR`.

### Local Development Mode (No Cloudflare Required)

When running `cd frontend && npm run dev` (`http://localhost:3000`) with
`local-data/` populated, `vite-local-api.ts` serves matching `/api/agent/*`
endpoints locally with no login required:

```bash
traceveil --url http://localhost:3000 stats
traceveil --url http://localhost:3000 tracks list --limit 5
```

---

## Step 4: Install the Agent Skill

Copy or symlink `skills/traceveil` into your agent's skills directory (for
project-local agents inside this repo, `skills/traceveil/SKILL.md` is already
available).
