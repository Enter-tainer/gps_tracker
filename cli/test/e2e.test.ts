import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { encodeGpsl0Points } from "../../frontend/src/services/gpsl0/index.ts";
import { encodeTileKey, latLonToTileFractional } from "../../frontend/src/utils/coordTransform.ts";
import workerHandler, { type Env } from "../../frontend/src/worker/index.ts";
import { generateCodeChallengeS256 } from "../src/oidc.ts";

class MockD1Prepared {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]) {
    return new MockD1Prepared(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>() {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...(this.params as never[])) as T[];
    return { results, success: true, meta: {} };
  }

  async run() {
    const stmt = this.db.prepare(this.sql);
    const res = stmt.run(...(this.params as never[]));
    return {
      success: true,
      meta: {
        changes: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid)
      }
    };
  }
}

class MockD1Database {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }

  prepare(sql: string) {
    return new MockD1Prepared(this.sqlite, sql);
  }

  async batch(stmts: MockD1Prepared[]) {
    const out = [];
    for (const s of stmts) {
      out.push(await s.run());
    }
    return out;
  }
}

function makeFogHeader(visitedTiles: number, exploredCells: number): Uint8Array {
  const buf = new Uint8Array(16);
  buf[0] = 0x46;
  buf[1] = 0x47;
  buf[2] = 0x50;
  buf[3] = 0x31;
  const view = new DataView(buf.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, visitedTiles, true);
  view.setUint32(12, exploredCells, true);
  return buf;
}

function createMockR2(fogHeader: Uint8Array) {
  const objects = new Map<string, Uint8Array>([["fog/global-fog.bin", fogHeader]]);
  return {
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const data = objects.get(key);
      if (!data) return null;
      const slice = opts?.range
        ? data.slice(opts.range.offset, opts.range.offset + opts.range.length)
        : data;
      return {
        httpEtag: '"mock-etag"',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          }
        }),
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        }
      };
    }
  };
}

function startMockAccessPlatform(opts: { appAud: string; userEmail: string }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  jwk.kid = "cf-access-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const registeredClients = new Map<string, { redirectUris: string[]; resource?: string }>();
  const authCodes = new Map<
    string,
    { clientId: string; codeChallenge: string; redirectUri: string; resource: string }
  >();
  const validTokens = new Map<string, { resource: string; email: string; expiresAt: number }>();
  const refreshTokens = new Map<string, { clientId: string; resource: string; email: string }>();
  const revokedTokens: string[] = [];
  let tokenIssueCount = 0;
  let baseUrl = "";

  const signAccessJwt = (payload: Record<string, unknown>) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "cf-access-key-1" })
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    const sig = signer.sign(privateKey).toString("base64url");
    return `${header}.${body}.${sig}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBuf = Buffer.concat(chunks);

    if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/cdn-cgi/access/oauth/authorization`,
          token_endpoint: `${baseUrl}/cdn-cgi/access/oauth/token`,
          registration_endpoint: `${baseUrl}/cdn-cgi/access/oauth/registration`,
          revocation_endpoint: `${baseUrl}/cdn-cgi/access/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        })
      );
      return;
    }

    if (url.pathname === "/cdn-cgi/access/certs" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (url.pathname === "/cdn-cgi/access/oauth/registration" && req.method === "POST") {
      const reg = JSON.parse(bodyBuf.toString("utf8")) as {
        redirect_uris?: string[];
        resource?: string;
      };
      if (!Array.isArray(reg.redirect_uris) || reg.redirect_uris.length === 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_client_metadata" }));
        return;
      }
      const clientId = `dyn-client-${registeredClients.size + 1}`;
      registeredClients.set(clientId, {
        redirectUris: reg.redirect_uris,
        resource: reg.resource
      });
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          client_id: clientId,
          redirect_uris: reg.redirect_uris,
          token_endpoint_auth_method: "none"
        })
      );
      return;
    }

    if (url.pathname === "/cdn-cgi/access/oauth/authorization" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const method = url.searchParams.get("code_challenge_method") || "";
      const resource = url.searchParams.get("resource") || "";

      const client = registeredClients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        res.statusCode = 400;
        res.end("invalid client_id or redirect_uri");
        return;
      }
      if (!resource) {
        res.statusCode = 400;
        res.end("invalid_target: No resource parameter found");
        return;
      }
      if (method !== "S256" || !/^[a-zA-Z0-9]/.test(codeChallenge)) {
        res.statusCode = 400;
        res.end("invalid code_challenge");
        return;
      }

      const code = `cf-code-${crypto.randomBytes(8).toString("hex")}`;
      authCodes.set(code, { clientId, codeChallenge, redirectUri, resource });

      const cb = new URL(redirectUri);
      cb.searchParams.set("code", code);
      cb.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("Location", cb.toString());
      res.end();
      return;
    }

    if (url.pathname === "/cdn-cgi/access/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(bodyBuf.toString("utf8"));
      const grantType = form.get("grant_type");
      const clientId = form.get("client_id") || "";
      const resource = form.get("resource") || "";
      const nowSec = Math.floor(Date.now() / 1000);

      if (!resource) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_target", error_description: "missing resource" }));
        return;
      }

      if (grantType === "authorization_code") {
        const code = form.get("code") || "";
        const verifier = form.get("code_verifier") || "";
        const redirectUri = form.get("redirect_uri") || "";
        const record = authCodes.get(code);
        if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri || record.resource !== resource) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        if (generateCodeChallengeS256(verifier) !== record.codeChallenge) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE mismatch" }));
          return;
        }
        authCodes.delete(code);
        tokenIssueCount++;
        const accessToken = `opaque-access-${tokenIssueCount}-${crypto.randomBytes(6).toString("hex")}`;
        const refreshToken = `cf-refresh-${tokenIssueCount}`;
        validTokens.set(accessToken, { resource, email: opts.userEmail, expiresAt: nowSec + 900 });
        refreshTokens.set(refreshToken, { clientId, resource, email: opts.userEmail });

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            token_type: "Bearer",
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 900
          })
        );
        return;
      }

      if (grantType === "refresh_token") {
        const rt = form.get("refresh_token") || "";
        const rec = refreshTokens.get(rt);
        if (!rec || rec.clientId !== clientId || rec.resource !== resource) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenIssueCount++;
        const accessToken = `opaque-access-${tokenIssueCount}-${crypto.randomBytes(6).toString("hex")}`;
        validTokens.set(accessToken, { resource, email: rec.email, expiresAt: nowSec + 900 });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            token_type: "Bearer",
            access_token: accessToken,
            refresh_token: rt,
            expires_in: 900
          })
        );
        return;
      }

      res.statusCode = 400;
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    if (url.pathname === "/cdn-cgi/access/oauth/revoke" && req.method === "POST") {
      const form = new URLSearchParams(bodyBuf.toString("utf8"));
      const tok = form.get("token") || "";
      revokedTokens.push(tok);
      validTokens.delete(tok);
      refreshTokens.delete(tok);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ revoked: true }));
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  return {
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      return baseUrl;
    },
    verifyOpaqueAccessToken(token: string) {
      const entry = validTokens.get(token);
      if (!entry) return null;
      if (Math.floor(Date.now() / 1000) > entry.expiresAt) return null;
      return entry;
    },
    signAccessJwt,
    getTokenIssueCount: () => tokenIssueCount,
    getRevokedTokens: () => revokedTokens.slice(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function runCli(
  args: string[],
  envExtra: Record<string, string>,
  stdinText?: string
): Promise<{ status: number; stdout: string; stderr: string }> {
  const cliBin = path.resolve(process.cwd(), "dist", "cli.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: {
        ...process.env,
        ...envExtra
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
  });
}

test("End-to-end Managed OAuth (DCR + PKCE + RFC 8707 + manual + refresh + revoke) against Worker", async () => {
  const appAud = "test-access-aud-tag";
  const userEmail = "traveler@example.com";
  const accessAs = startMockAccessPlatform({ appAud, userEmail });
  const asBase = await accessAs.start();

  const d1 = new MockD1Database();
  const repoRoot = path.resolve(process.cwd(), "..");
  for (const mig of ["0001_init.sql", "0002_regions.sql"]) {
    const sql = fs.readFileSync(
      path.join(repoRoot, "frontend", "migrations", mig),
      "utf8"
    );
    d1.sqlite.exec(sql);
  }

  // Seed test track + regions + spatial tiles + GPSL0 blob
  const startTs = 1_760_000_000;
  const rawPts = [
    { timestamp: startTs, latitude_scaled_1e7: 399000000, longitude_scaled_1e7: 1164000000, altitude_m_scaled_1e1: 500 },
    { timestamp: startTs + 120, latitude_scaled_1e7: 399010000, longitude_scaled_1e7: 1164000000, altitude_m_scaled_1e1: 550 },
    { timestamp: startTs + 480, latitude_scaled_1e7: 399011000, longitude_scaled_1e7: 1164001000, altitude_m_scaled_1e1: 560 },
    { timestamp: startTs + 600, latitude_scaled_1e7: 399050000, longitude_scaled_1e7: 1164050000, altitude_m_scaled_1e1: 650 }
  ];
  const blob = encodeGpsl0Points(rawPts);
  const endTs = rawPts[rawPts.length - 1].timestamp;

  d1.sqlite
    .prepare(
      `INSERT INTO tracks (
        id, date, title, source_file, point_count, distance_m, duration_s,
        elev_gain_m, min_ele, max_ele, start_time, end_time,
        min_lat, max_lat, min_lon, max_lon, r2_key, overview_coords, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "2025-10-09-beijing-walk",
      "2025-10-09",
      "Beijing Autumn Walk",
      "2025-10-09.gpz",
      rawPts.length,
      1250,
      600,
      15,
      50,
      65,
      startTs,
      endTs,
      39.9,
      39.905,
      116.4,
      116.405,
      "d1://track_blobs/2025-10-09-beijing-walk",
      "[[[116.4,39.9],[116.405,39.905]]]",
      startTs
    );
  d1.sqlite
    .prepare(`INSERT INTO track_blobs (track_id, data) VALUES (?, ?)`)
    .run("2025-10-09-beijing-walk", blob);

  const frac = latLonToTileFractional(39.901, 116.4, 15);
  const tileKey = encodeTileKey(frac.tx, frac.ty);
  d1.sqlite
    .prepare(
      `INSERT INTO track_tiles (tile_key, track_id, point_count, first_ts, last_ts) VALUES (?, ?, ?, ?, ?)`
    )
    .run(tileKey, "2025-10-09-beijing-walk", 3, startTs, startTs + 480);

  d1.sqlite
    .prepare(
      `INSERT INTO visited_regions (
        region_id, level, parent_id, country, name_zh, name_en,
        direct_child_count, leaf_child_count, lit_direct_children, lit_leaf_children,
        area_km2, explored_cells, explored_area_km2, visit_days, track_count,
        heat, first_ts, last_ts, bbox_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      100,
      0,
      null,
      "CN",
      "中国",
      "China",
      34,
      300,
      1,
      1,
      9600000,
      10,
      0.003,
      1,
      1,
      0.25,
      startTs,
      endTs,
      "[73,18,135,53]"
    );
  d1.sqlite
    .prepare(
      `INSERT INTO visited_regions (
        region_id, level, parent_id, country, name_zh, name_en,
        direct_child_count, leaf_child_count, lit_direct_children, lit_leaf_children,
        area_km2, explored_cells, explored_area_km2, visit_days, track_count,
        heat, first_ts, last_ts, bbox_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      1101,
      2,
      100,
      "CN",
      "北京市",
      "Beijing",
      16,
      16,
      1,
      1,
      16410,
      10,
      0.003,
      1,
      1,
      0.42,
      startTs,
      endTs,
      "[115.4,39.4,117.5,41.1]"
    );
  d1.sqlite
    .prepare(
      `INSERT INTO track_regions (region_id, track_id, cell_count, first_ts, last_ts) VALUES (?, ?, ?, ?, ?)`
    )
    .run(1101, "2025-10-09-beijing-walk", 10, startTs, endTs);

  const workerEnv: Env = {
    ASSETS: {
      fetch: async () => new Response("SPA", { status: 200 })
    } as unknown as Env["ASSETS"],
    TRACKS_DB: d1 as unknown as Env["TRACKS_DB"],
    TRACKS_BUCKET: createMockR2(makeFogHeader(12, 340)) as unknown as Env["TRACKS_BUCKET"],
    CF_ACCESS_TEAM_DOMAIN: asBase,
    CF_ACCESS_AUD: appAud,
    CF_ACCESS_ALLOWED_EMAILS: userEmail
  };

  let edgeUrl = "";
  const edgeProxy = http.createServer(async (req, res) => {
    const fullUrl = new URL(req.url || "/", edgeUrl);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBuf = Buffer.concat(chunks);

    if (fullUrl.pathname.startsWith("/.well-known/cloudflare-access-protected-resource")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          resource: edgeUrl,
          protected: true,
          authorization_servers: [asBase]
        })
      );
      return;
    }

    // Simulate Cloudflare Access Managed OAuth edge enforcement
    const authHeader = String(req.headers.authorization || "");
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const verified = m ? accessAs.verifyOpaqueAccessToken(m[1].trim()) : null;
    if (!verified) {
      const accept = String(req.headers.accept || "");
      if (accept.includes("application/json")) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Www-Authenticate",
          `Bearer realm="OAuth", error="invalid_token", resource_metadata="${edgeUrl}/.well-known/cloudflare-access-protected-resource${fullUrl.pathname}"`
        );
        res.end(JSON.stringify({ error: "invalid_token" }));
      } else {
        res.statusCode = 302;
        res.setHeader("Location", `${asBase}/login`);
        res.end();
      }
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const assertionJwt = accessAs.signAccessJwt({
      iss: asBase,
      sub: "user-sub-1",
      aud: [appAud],
      email: verified.email,
      name: "Test Traveler",
      iat: nowSec,
      exp: nowSec + 300
    });

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    headers.set("Cf-Access-Jwt-Assertion", assertionJwt);
    headers.set("Cf-Access-Authenticated-User-Email", verified.email);

    const request = new Request(fullUrl.toString(), {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD" || bodyBuf.length === 0
          ? undefined
          : bodyBuf
    });

    const resp = await workerHandler.fetch(request, workerEnv, {
      waitUntil: () => {},
      passThroughOnException: () => {}
    } as unknown as Parameters<typeof workerHandler.fetch>[2]);

    res.statusCode = resp.status;
    resp.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await resp.arrayBuffer()));
  });

  await new Promise<void>((resolve) => edgeProxy.listen(0, "127.0.0.1", resolve));
  const eAddr = edgeProxy.address() as { port: number };
  edgeUrl = `http://127.0.0.1:${eAddr.port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "traceveil-managed-e2e-"));
  const cfgDir = path.join(tmpDir, "cfg");
  const cacheDir = path.join(tmpDir, "cache");
  const cliEnv = {
    TRACEVEIL_CONFIG_DIR: cfgDir,
    TRACEVEIL_CACHE_DIR: cacheDir
  };

  try {
    // 1. Direct Worker strict JWT verification sanity checks (bypassing edge proxy)
    const directMissing = await workerHandler.fetch(
      new Request(`${edgeUrl}/api/agent/stats`),
      workerEnv,
      {} as never
    );
    assert.equal(directMissing.status, 401);

    const badAudJwt = accessAs.signAccessJwt({
      iss: asBase,
      sub: "user-sub-1",
      aud: "wrong-aud",
      email: userEmail,
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const directBadAud = await workerHandler.fetch(
      new Request(`${edgeUrl}/api/agent/stats`, {
        headers: { "Cf-Access-Jwt-Assertion": badAudJwt }
      }),
      workerEnv,
      {} as never
    );
    assert.equal(directBadAud.status, 401);

    const badEmailJwt = accessAs.signAccessJwt({
      iss: asBase,
      sub: "user-sub-2",
      aud: appAud,
      email: "intruder@example.com",
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const directBadEmail = await workerHandler.fetch(
      new Request(`${edgeUrl}/api/agent/stats`, {
        headers: { "Cf-Access-Jwt-Assertion": badEmailJwt }
      }),
      workerEnv,
      {} as never
    );
    assert.equal(directBadEmail.status, 403);

    // 2. Logged-out auth status -> exit code 2
    const loggedOut = await runCli(["auth", "status", "--json"], cliEnv);
    assert.equal(loggedOut.status, 2);
    assert.equal(JSON.parse(loggedOut.stdout).error, "auth_required");

    // 3. Loopback PKCE Managed OAuth login (`auth login --port 0 --no-browser --json`)
    const cliBin = path.resolve(process.cwd(), "dist", "cli.mjs");
    const loginChild = spawn(
      process.execPath,
      [cliBin, "auth", "login", "--url", edgeUrl, "--port", "0", "--no-browser", "--json"],
      { env: { ...process.env, ...cliEnv } }
    );
    let loginStdout = "";
    let loginStderr = "";
    let triggeredBrowser = false;
    loginChild.stdout.on("data", (c) => {
      loginStdout += c.toString();
    });
    loginChild.stderr.on("data", (c) => {
      loginStderr += c.toString();
      if (!triggeredBrowser) {
        const match = loginStderr.match(
          /https?:\/\/127\.0\.0\.1:\d+\/cdn-cgi\/access\/oauth\/authorization\?[^\s]+/
        );
        if (match && loginStderr.includes("Waiting for browser callback")) {
          triggeredBrowser = true;
          fetch(match[0], { redirect: "follow" }).catch(() => {});
        }
      }
    });
    const loginCode = await new Promise<number>((resolve, reject) => {
      loginChild.on("error", reject);
      loginChild.on("close", (code) => resolve(code ?? 1));
    });
    assert.equal(loginCode, 0, `${loginStdout}\n${loginStderr}`);
    const loginJson = JSON.parse(loginStdout);
    assert.equal(loginJson.authenticated, true);
    assert.equal(loginJson.email, userEmail);
    assert.equal(loginJson.has_refresh_token, true);

    // 4. Simulate expired/rejected access token -> edge returns 401 -> CLI transparently refreshes with resource!
    const oauthPath = path.join(cfgDir, "oauth.json");
    const saved = JSON.parse(fs.readFileSync(oauthPath, "utf8")) as Record<string, unknown>;
    saved.access_token = "expired-opaque-token";
    saved.expires_at = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(oauthPath, JSON.stringify(saved));

    const beforeRefresh = accessAs.getTokenIssueCount();
    const statsOut = await runCli(["stats", "--json"], cliEnv);
    assert.equal(statsOut.status, 0, `${statsOut.stdout}\n${statsOut.stderr}`);
    const statsJson = JSON.parse(statsOut.stdout);
    assert.equal(statsJson.stats.trackCount, 1);
    assert.equal(statsJson.stats.visitedTilesZ15, 12);
    assert.equal(statsJson.visitedRegionCounts.l2, 1);
    assert.ok(accessAs.getTokenIssueCount() > beforeRefresh);

    // 5. All query commands work with refreshed token
    const listOut = await runCli(["tracks", "list", "--region", "北京", "--json"], cliEnv);
    assert.equal(listOut.status, 0, `${listOut.stdout}\n${listOut.stderr}`);
    assert.equal(JSON.parse(listOut.stdout).total, 1);

    const showOut = await runCli(["tracks", "show", "2025-10-09-beijing-walk", "--json"], cliEnv);
    assert.equal(showOut.status, 0, `${showOut.stdout}\n${showOut.stderr}`);
    assert.equal(JSON.parse(showOut.stdout).regions[0].rid, 1101);

    const analyzeOut = await runCli(["tracks", "analyze", "2025-10-09-beijing-walk", "--json"], cliEnv);
    assert.equal(analyzeOut.status, 0, `${analyzeOut.stdout}\n${analyzeOut.stderr}`);
    assert.equal(JSON.parse(analyzeOut.stdout).analysis.stops.length, 1);

    const gpxOut = await runCli(["tracks", "points", "2025-10-09-beijing-walk", "--format", "gpx"], cliEnv);
    assert.equal(gpxOut.status, 0, `${gpxOut.stdout}\n${gpxOut.stderr}`);
    assert.ok(gpxOut.stdout.includes("<gpx "));

    const regionsOut = await runCli(["regions", "show", "北京市", "--json"], cliEnv);
    assert.equal(regionsOut.status, 0, `${regionsOut.stdout}\n${regionsOut.stderr}`);
    const regionsJson = JSON.parse(regionsOut.stdout);
    assert.equal(regionsJson.region.rid, 1101);
    assert.equal(regionsJson.ancestors[0].rid, 100);

    const whereOut = await runCli(["where", "--at", String(startTs + 60), "--json"], cliEnv);
    assert.equal(whereOut.status, 0, `${whereOut.stdout}\n${whereOut.stderr}`);
    const whereJson = JSON.parse(whereOut.stdout);
    assert.equal(whereJson.best_location.location.mode, "interpolated");
    assert.ok(Math.abs(whereJson.best_location.location.lat - 39.9005) < 1e-4);

    const nearbyOut = await runCli(
      ["nearby", "--lat", "39.901", "--lon", "116.4", "--radius", "200", "--exact", "--json"],
      cliEnv
    );
    assert.equal(nearbyOut.status, 0, `${nearbyOut.stdout}\n${nearbyOut.stderr}`);
    const nearbyJson = JSON.parse(nearbyOut.stdout);
    assert.equal(nearbyJson.total, 1);
    assert.ok(nearbyJson.matches[0].exact.min_distance_m < 20);

    const bboxOut = await runCli(
      ["bbox", "--min-lat", "39.89", "--min-lon", "116.39", "--max-lat", "39.91", "--max-lon", "116.41", "--json"],
      cliEnv
    );
    assert.equal(bboxOut.status, 0, `${bboxOut.stdout}\n${bboxOut.stderr}`);
    assert.equal(JSON.parse(bboxOut.stdout).total, 1);

    const tokenOut = await runCli(["auth", "token", "--json"], cliEnv);
    assert.equal(tokenOut.status, 0, `${tokenOut.stdout}\n${tokenOut.stderr}`);
    assert.ok(JSON.parse(tokenOut.stdout).access_token.startsWith("opaque-access-"));

    // 6. Logout revokes remote token & deletes oauth.json
    const logoutOut = await runCli(["auth", "logout", "--json"], cliEnv);
    assert.equal(logoutOut.status, 0, `${logoutOut.stdout}\n${logoutOut.stderr}`);
    const logoutJson = JSON.parse(logoutOut.stdout);
    assert.equal(logoutJson.removed_credentials, true);
    assert.equal(logoutJson.revoked, true);
    assert.ok(accessAs.getRevokedTokens().length >= 1);

    const afterLogout = await runCli(["auth", "status", "--json"], cliEnv);
    assert.equal(afterLogout.status, 2);

    // 7. Cross-device `--manual` login (user pastes redirected callback URL)
    const manualChild = spawn(
      process.execPath,
      [cliBin, "auth", "login", "--url", edgeUrl, "--manual", "--json"],
      { env: { ...process.env, ...cliEnv } }
    );
    let manualStdout = "";
    let manualStderr = "";
    let submittedManual = false;
    manualChild.stdout.on("data", (c) => {
      manualStdout += c.toString();
    });
    manualChild.stderr.on("data", async (c) => {
      manualStderr += c.toString();
      if (!submittedManual) {
        const match = manualStderr.match(
          /https?:\/\/127\.0\.0\.1:\d+\/cdn-cgi\/access\/oauth\/authorization\?[^\s]+/
        );
        if (match && manualStderr.includes("Paste the redirected callback URL")) {
          submittedManual = true;
          const resp = await fetch(match[0], { redirect: "manual" });
          const location = resp.headers.get("location") || "";
          manualChild.stdin.write(location + "\n");
          manualChild.stdin.end();
        }
      }
    });
    const manualCode = await new Promise<number>((resolve, reject) => {
      manualChild.on("error", reject);
      manualChild.on("close", (code) => resolve(code ?? 1));
    });
    assert.equal(manualCode, 0, `${manualStdout}\n${manualStderr}`);
    assert.equal(JSON.parse(manualStdout).authenticated, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await Promise.all([
      accessAs.close(),
      new Promise<void>((resolve) => edgeProxy.close(() => resolve()))
    ]);
  }
});
