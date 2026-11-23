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
import { latLonToTileFractional, encodeTileKey } from "../../frontend/src/utils/coordTransform.ts";
import workerHandler, { type Env } from "../../frontend/src/worker/index.ts";
import { generateCodeChallengeS256, generateCodeVerifier } from "../src/oidc.ts";

// Minimal D1-compatible wrapper around Node.js built-in DatabaseSync (Node 22+)
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

function startMockOidcProvider(opts: { clientId: string; userEmail: string }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kid?: string;
    alg?: string;
    use?: string;
  };
  jwk.kid = "test-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const authCodes = new Map<
    string,
    { codeChallenge: string; redirectUri: string; scope: string }
  >();
  const refreshTokens = new Set<string>(["refresh-tok-1"]);
  let tokenIssueCount = 0;

  let baseUrl = "";

  const signJwt = (payload: Record<string, unknown>) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-1" })
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    const sig = signer.sign(privateKey).toString("base64url");
    return `${header}.${body}.${sig}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    if (url.pathname === "/oidc/.well-known/openid-configuration") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          issuer: `${baseUrl}/oidc`,
          authorization_endpoint: `${baseUrl}/oidc/authorization`,
          token_endpoint: `${baseUrl}/oidc/token`,
          jwks_uri: `${baseUrl}/oidc/jwks`
        })
      );
      return;
    }

    if (url.pathname === "/oidc/jwks") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (url.pathname === "/oidc/authorization" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const scope = url.searchParams.get("scope") || "openid email profile";
      const code = `code-${crypto.randomBytes(8).toString("hex")}`;
      authCodes.set(code, { codeChallenge, redirectUri, scope });

      const cb = new URL(redirectUri);
      cb.searchParams.set("code", code);
      cb.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("Location", cb.toString());
      res.end();
      return;
    }

    if (url.pathname === "/oidc/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const grantType = form.get("grant_type");
      const now = Math.floor(Date.now() / 1000);

      if (grantType === "authorization_code") {
        const code = form.get("code") || "";
        const verifier = form.get("code_verifier") || "";
        const redirectUri = form.get("redirect_uri") || "";
        const record = authCodes.get(code);
        if (!record) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const computedChallenge = generateCodeChallengeS256(verifier);
        if (computedChallenge !== record.codeChallenge || redirectUri !== record.redirectUri) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE or redirect_uri mismatch" }));
          return;
        }
        authCodes.delete(code);
        tokenIssueCount++;
        const jwt = signJwt({
          iss: `${baseUrl}/oidc`,
          sub: "user-sub-1",
          aud: opts.clientId,
          email: opts.userEmail,
          name: "Test Traveler",
          iat: now,
          exp: now + 3600
        });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            token_type: "Bearer",
            access_token: jwt,
            id_token: jwt,
            refresh_token: "refresh-tok-1",
            expires_in: 3600
          })
        );
        return;
      }

      if (grantType === "refresh_token") {
        const rt = form.get("refresh_token") || "";
        if (!refreshTokens.has(rt)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenIssueCount++;
        const jwt = signJwt({
          iss: `${baseUrl}/oidc`,
          sub: "user-sub-1",
          aud: opts.clientId,
          email: opts.userEmail,
          name: "Test Traveler",
          iat: now,
          exp: now + 3600
        });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            token_type: "Bearer",
            access_token: jwt,
            id_token: jwt,
            refresh_token: "refresh-tok-1",
            expires_in: 3600
          })
        );
        return;
      }

      res.statusCode = 400;
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
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
    getTokenIssueCount: () => tokenIssueCount,
    signCustomJwt: (payload: Record<string, unknown>) => signJwt(payload),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function runCli(
  args: string[],
  envExtra: Record<string, string>
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
  });
}

test("End-to-end OIDC verification, Device Flow, and CLI queries against Worker handler", async () => {
  const clientId = "traceveil-agent-test-client";
  const userEmail = "traveler@example.com";
  const oidc = startMockOidcProvider({ clientId, userEmail });
  const oidcBase = await oidc.start();

  const d1 = new MockD1Database();
  const repoRoot = path.resolve(process.cwd(), "..");
  for (const mig of [
    "0001_init.sql",
    "0002_regions.sql",
    "0003_agent_device_auth.sql"
  ]) {
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
    OIDC_ISSUER: `${oidcBase}/oidc`,
    OIDC_CLIENT_ID: clientId,
    OIDC_AUD: clientId,
    OIDC_ALLOWED_EMAILS: userEmail
  };

  let workerUrl = "";
  const workerServer = http.createServer(async (req, res) => {
    const fullUrl = new URL(req.url || "/", workerUrl);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBuf = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }

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
    const outBuf = Buffer.from(await resp.arrayBuffer());
    res.end(outBuf);
  });

  await new Promise<void>((resolve) =>
    workerServer.listen(0, "127.0.0.1", resolve)
  );
  const wAddr = workerServer.address() as { port: number };
  workerUrl = `http://127.0.0.1:${wAddr.port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "traceveil-e2e-"));
  const cfgDir = path.join(tmpDir, "cfg");
  const cacheDir = path.join(tmpDir, "cache");
  const cliEnv = {
    TRACEVEIL_CONFIG_DIR: cfgDir,
    TRACEVEIL_CACHE_DIR: cacheDir
  };

  try {
    // 1. Unauthenticated access must fail with 401
    const unauth = await fetch(`${workerUrl}/api/agent/stats`);
    assert.equal(unauth.status, 401);

    // 2. Forged/wrong-aud JWT must fail with 401
    const wrongAudJwt = oidc.signCustomJwt({
      iss: `${oidcBase}/oidc`,
      sub: "user-sub-1",
      aud: "wrong-audience",
      email: userEmail,
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const badAuth = await fetch(`${workerUrl}/api/agent/stats`, {
      headers: { Authorization: `Bearer ${wrongAudJwt}` }
    });
    assert.equal(badAuth.status, 401);

    // 3. Disallowed email must fail with 403
    const otherEmailJwt = oidc.signCustomJwt({
      iss: `${oidcBase}/oidc`,
      sub: "user-sub-2",
      aud: clientId,
      email: "intruder@example.com",
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const forbidden = await fetch(`${workerUrl}/api/agent/stats`, {
      headers: { Authorization: `Bearer ${otherEmailJwt}` }
    });
    assert.equal(forbidden.status, 403);

    // 4. CLI auth status while logged out -> exit code 2 + structured JSON
    const loggedOutRes = await runCli(["auth", "status", "--json"], cliEnv);
    assert.equal(loggedOutRes.status, 2);
    const loggedOutJson = JSON.parse(loggedOutRes.stdout);
    assert.equal(loggedOutJson.authenticated, false);
    assert.equal(loggedOutJson.error, "auth_required");

    // 5. Device Flow E2E via Worker + Mock OIDC IdP
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallengeS256(verifier);

    const startRes = await fetch(`${workerUrl}/api/agent/auth/device/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_challenge: challenge,
        code_challenge_method: "S256"
      })
    });
    assert.equal(startRes.status, 200);
    const startBody = (await startRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };
    assert.ok(startBody.user_code.includes("-"));

    // Poll while pending
    const pendingRes = await fetch(`${workerUrl}/api/agent/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: startBody.device_code })
    });
    assert.equal(pendingRes.status, 200);
    assert.equal(
      ((await pendingRes.json()) as { status: string }).status,
      "authorization_pending"
    );

    // Approve in verification form -> follows 302 to mock OIDC -> redirects back to /device/callback
    const verifyRes = await fetch(`${workerUrl}/api/agent/auth/device/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_code: startBody.user_code,
        action: "approve"
      }).toString()
    });
    assert.equal(verifyRes.status, 200);
    const verifyHtml = await verifyRes.text();
    assert.ok(verifyHtml.includes("Authorization Complete"));

    // Poll returns one-time auth code
    const approvedRes = await fetch(`${workerUrl}/api/agent/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: startBody.device_code })
    });
    assert.equal(approvedRes.status, 200);
    const approvedJson = (await approvedRes.json()) as {
      status: string;
      code: string;
      redirect_uri: string;
    };
    assert.equal(approvedJson.status, "approved");

    // Re-polling consumed device_code fails
    const replayRes = await fetch(`${workerUrl}/api/agent/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: startBody.device_code })
    });
    assert.equal(replayRes.status, 400);

    // Exchange code + verifier at OIDC token endpoint
    const authCfg = (await (
      await fetch(`${workerUrl}/api/agent/auth/config`)
    ).json()) as { token_endpoint: string; issuer: string; authorization_endpoint: string };
    const tokRes = await fetch(authCfg.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: approvedJson.code,
        redirect_uri: approvedJson.redirect_uri,
        code_verifier: verifier
      }).toString()
    });
    assert.equal(tokRes.status, 200);
    const tokJson = (await tokRes.json()) as {
      access_token: string;
      id_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Save credentials with an ALREADY-EXPIRED expires_at to test automatic refresh in CLI!
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "credentials.json"),
      JSON.stringify({
        url: workerUrl,
        issuer: authCfg.issuer,
        client_id: clientId,
        audience: clientId,
        authorization_endpoint: authCfg.authorization_endpoint,
        token_endpoint: authCfg.token_endpoint,
        scopes: "openid email profile",
        access_token: oidc.signCustomJwt({
          iss: authCfg.issuer,
          sub: "user-sub-1",
          aud: clientId,
          email: userEmail,
          exp: Math.floor(Date.now() / 1000) - 120
        }),
        refresh_token: tokJson.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) - 120,
        email: userEmail,
        sub: "user-sub-1",
        updated_at: Math.floor(Date.now() / 1000)
      })
    );

    const beforeRefreshCount = oidc.getTokenIssueCount();

    // 6. CLI commands exercise transparent refresh + queries
    const statsOut = await runCli(["stats", "--json"], cliEnv);
    assert.equal(statsOut.status, 0, `${statsOut.stdout}\n${statsOut.stderr}`);
    const statsJson = JSON.parse(statsOut.stdout);
    assert.equal(statsJson.stats.trackCount, 1);
    assert.equal(statsJson.stats.visitedTilesZ15, 12);
    assert.equal(statsJson.visitedRegionCounts.l2, 1);
    assert.ok(oidc.getTokenIssueCount() > beforeRefreshCount);

    const listOut = await runCli(["tracks", "list", "--region", "北京", "--json"], cliEnv);
    assert.equal(listOut.status, 0, `${listOut.stdout}\n${listOut.stderr}`);
    const listJson = JSON.parse(listOut.stdout);
    assert.equal(listJson.total, 1);
    assert.equal(listJson.tracks[0].id, "2025-10-09-beijing-walk");

    const analyzeOut = await runCli(["tracks", "analyze", "2025-10-09-beijing-walk", "--json"], cliEnv);
    assert.equal(analyzeOut.status, 0, `${analyzeOut.stdout}\n${analyzeOut.stderr}`);
    const analyzeJson = JSON.parse(analyzeOut.stdout);
    assert.equal(analyzeJson.analysis.point_count, 4);
    assert.equal(analyzeJson.analysis.stops.length, 1);

    const showOut = await runCli(["tracks", "show", "2025-10-09-beijing-walk", "--json"], cliEnv);
    assert.equal(showOut.status, 0, `${showOut.stdout}\n${showOut.stderr}`);
    const showJson = JSON.parse(showOut.stdout);
    assert.equal(showJson.track.id, "2025-10-09-beijing-walk");
    assert.equal(showJson.regions[0].rid, 1101);

    const gpxOut = await runCli(["tracks", "points", "2025-10-09-beijing-walk", "--format", "gpx"], cliEnv);
    assert.equal(gpxOut.status, 0, `${gpxOut.stdout}\n${gpxOut.stderr}`);
    assert.ok(gpxOut.stdout.includes("<gpx "));

    const regionsOut = await runCli(["regions", "show", "北京市", "--json"], cliEnv);
    assert.equal(regionsOut.status, 0, `${regionsOut.stdout}\n${regionsOut.stderr}`);
    const regionsJson = JSON.parse(regionsOut.stdout);
    assert.equal(regionsJson.region.rid, 1101);
    assert.equal(regionsJson.ancestors[0].rid, 100);
    assert.equal(regionsJson.tracks.length, 1);

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
    const bboxJson = JSON.parse(bboxOut.stdout);
    assert.equal(bboxJson.total, 1);

    // 7. Logout clears credentials and auth status returns exit code 2 again
    const logoutOut = await runCli(["auth", "logout", "--json"], cliEnv);
    assert.equal(logoutOut.status, 0);
    assert.equal(JSON.parse(logoutOut.stdout).removed_credentials, true);

    const afterLogout = await runCli(["auth", "status", "--json"], cliEnv);
    assert.equal(afterLogout.status, 2);

    // 8. Programmatic PKCE loopback login E2E via `auth login --no-browser --port 0`
    const cliBin = path.resolve(process.cwd(), "dist", "cli.mjs");
    const loginChild = spawn(
      process.execPath,
      [cliBin, "auth", "login", "--url", workerUrl, "--port", "0", "--no-browser", "--json"],
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
        const match = loginStderr.match(/https?:\/\/127\.0\.0\.1:\d+\/oidc\/authorization\?[^\s]+/);
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

    const statusAfterPkce = await runCli(["auth", "status", "--json"], cliEnv);
    assert.equal(statusAfterPkce.status, 0, `${statusAfterPkce.stdout}\n${statusAfterPkce.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await Promise.all([
      oidc.close(),
      new Promise<void>((resolve) => workerServer.close(() => resolve()))
    ]);
  }
});
