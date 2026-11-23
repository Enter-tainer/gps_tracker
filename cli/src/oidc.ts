import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import readline from "node:readline/promises";
import { stdin as input, stderr as errOut, stdout as out } from "node:process";

import {
  normalizeBaseUrl,
  saveCredentials,
  type StoredCredentials
} from "./config.ts";

export interface AgentAuthConfigResponse {
  configured: boolean;
  local_dev?: boolean;
  error?: string;
  message?: string;
  issuer?: string;
  client_id?: string;
  audience?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  scopes?: string;
  device_flow_enabled?: boolean;
  device_start_endpoint?: string;
  device_poll_endpoint?: string;
  device_verification_uri?: string;
  device_callback_uri?: string;
  recommended_local_redirect_uri?: string;
}

export interface TokenEndpointResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generateCodeVerifier(byteLength = 48): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}

export function generateCodeChallengeS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkcePair(): PkcePair {
  const verifier = generateCodeVerifier();
  return {
    verifier,
    challenge: generateCodeChallengeS256(verifier)
  };
}

export function generateState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function isJwtString(token: string | undefined): token is string {
  return typeof token === "string" && token.split(".").length === 3;
}

export function selectBearerToken(creds: {
  access_token: string;
  id_token?: string;
  audience?: string;
  client_id?: string;
}): string {
  const expectedAud = creds.audience || creds.client_id;
  if (isJwtString(creds.access_token)) {
    const payload = decodeJwtPayload(creds.access_token);
    if (!expectedAud || !payload || !payload.aud) {
      return creds.access_token;
    }
    const aud = payload.aud;
    const matches =
      aud === expectedAud || (Array.isArray(aud) && aud.includes(expectedAud));
    if (matches) return creds.access_token;
  }
  if (isJwtString(creds.id_token)) {
    return creds.id_token;
  }
  return creds.access_token;
}

export async function fetchAuthConfig(
  baseUrl: string
): Promise<AgentAuthConfigResponse> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/agent/auth/config`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  const text = await resp.text();
  let data: AgentAuthConfigResponse;
  try {
    data = JSON.parse(text) as AgentAuthConfigResponse;
  } catch {
    throw new Error(
      `Unexpected non-JSON response from ${url} (HTTP ${resp.status})`
    );
  }
  if (!resp.ok && !data.configured) {
    throw new Error(
      data.message || data.error || `Server auth config returned HTTP ${resp.status}`
    );
  }
  return data;
}

export function openBrowserUrl(url: string): boolean {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      return true;
    }
    if (process.platform === "darwin") {
      const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function exchangeAuthorizationCode(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenEndpointResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier
  });

  const resp = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  const data = (await resp.json()) as TokenEndpointResponse;
  if (!resp.ok || data.error || !data.access_token) {
    throw new Error(
      `Token exchange failed (${resp.status}): ${data.error_description || data.error || "no access_token"}`
    );
  }
  return data;
}

function buildCredentialsFromTokens(params: {
  baseUrl: string;
  issuer: string;
  clientId: string;
  audience: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  tokens: TokenEndpointResponse;
  previousRefreshToken?: string;
}): StoredCredentials {
  const nowSec = Math.floor(Date.now() / 1000);
  const bearerCandidate = selectBearerToken({
    access_token: params.tokens.access_token,
    id_token: params.tokens.id_token,
    audience: params.audience,
    client_id: params.clientId
  });
  const payload =
    decodeJwtPayload(bearerCandidate) ??
    decodeJwtPayload(params.tokens.id_token ?? "") ??
    decodeJwtPayload(params.tokens.access_token);

  const expFromJwt =
    payload && typeof payload.exp === "number" ? payload.exp : null;
  const expiresIn =
    typeof params.tokens.expires_in === "number" && params.tokens.expires_in > 0
      ? params.tokens.expires_in
      : 3600;
  const expiresAt = expFromJwt ?? nowSec + expiresIn;

  const email =
    payload && typeof payload.email === "string" ? payload.email : null;
  const sub = payload && typeof payload.sub === "string" ? payload.sub : null;

  return {
    url: normalizeBaseUrl(params.baseUrl),
    issuer: params.issuer,
    client_id: params.clientId,
    audience: params.audience,
    authorization_endpoint: params.authorizationEndpoint,
    token_endpoint: params.tokenEndpoint,
    scopes: params.scopes,
    access_token: params.tokens.access_token,
    id_token: params.tokens.id_token,
    refresh_token: params.tokens.refresh_token ?? params.previousRefreshToken,
    expires_at: expiresAt,
    email,
    sub,
    updated_at: nowSec
  };
}

function waitForLocalCallback(params: {
  port: number;
  callbackPath: string;
  expectedState: string;
  timeoutMs: number;
}): {
  ready: Promise<{ actualPort: number }>;
  result: Promise<{ code: string }>;
  close: () => void;
} {
  let server: http.Server | null = null;
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  let resolveReady!: (v: { actualPort: number }) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<{ actualPort: number }>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveResult!: (v: { code: string }) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<{ code: string }>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  };

  server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (reqUrl.pathname !== params.callbackPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    const err = reqUrl.searchParams.get("error");
    const errDesc = reqUrl.searchParams.get("error_description");

    if (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<h2>Login Failed</h2><p>${errDesc || err}</p><p>You may close this window.</p>`
      );
      if (!settled) {
        settled = true;
        cleanup();
        rejectResult(new Error(`OIDC error: ${errDesc || err}`));
      }
      return;
    }

    if (!code || state !== params.expectedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h2>Invalid OAuth Callback</h2><p>State mismatch or missing code.</p>");
      if (!settled) {
        settled = true;
        cleanup();
        rejectResult(new Error("OAuth callback state mismatch or missing code"));
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<h2>Traceveil CLI Authorized</h2><p>Login succeeded. You can close this browser tab and return to your terminal.</p>"
    );
    if (!settled) {
      settled = true;
      cleanup();
      resolveResult({ code });
    }
  });

  server.on("error", (err) => {
    if (!settled) {
      settled = true;
      cleanup();
      rejectReady(err);
      rejectResult(err);
    }
  });

  server.listen(params.port, "127.0.0.1", () => {
    const addr = server?.address();
    const actualPort =
      typeof addr === "object" && addr ? addr.port : params.port;
    resolveReady({ actualPort });
  });

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      cleanup();
      rejectResult(new Error("Timed out waiting for OAuth browser callback"));
    }
  }, params.timeoutMs);

  return {
    ready,
    result,
    close: () => {
      if (!settled) {
        settled = true;
        cleanup();
      }
    }
  };
}

export async function loginWithPkce(opts: {
  url: string;
  port?: number;
  redirectUri?: string;
  scopes?: string;
  manual?: boolean;
  noBrowser?: boolean;
  timeoutSec?: number;
  issuer?: string;
  clientId?: string;
}): Promise<StoredCredentials> {
  const baseUrl = normalizeBaseUrl(opts.url);
  const cfg = await fetchAuthConfig(baseUrl);
  if (cfg.local_dev && !opts.issuer) {
    throw new Error(
      "Target URL is running in local Vite dev mode (no OIDC required). Pass --url directly to query commands."
    );
  }
  if (!cfg.configured || !cfg.authorization_endpoint || !cfg.token_endpoint || !cfg.client_id || !cfg.issuer) {
    throw new Error(cfg.message || "Worker OIDC configuration is incomplete");
  }

  const issuer = opts.issuer || cfg.issuer;
  const clientId = opts.clientId || cfg.client_id;
  const audience = cfg.audience || clientId;
  const scopes = opts.scopes || cfg.scopes || "openid email profile";
  const pkce = generatePkcePair();
  const state = generateState();

  let redirectUri = opts.redirectUri?.trim() || "";
  let callbackWaiter: ReturnType<typeof waitForLocalCallback> | null = null;

  if (!opts.manual) {
    const desiredPort = opts.port ?? 8789;
    let callbackPath = "/callback";
    let listenPort = desiredPort;
    if (redirectUri) {
      const parsed = new URL(redirectUri);
      callbackPath = parsed.pathname || "/callback";
      listenPort = parsed.port ? Number(parsed.port) : desiredPort;
    }

    callbackWaiter = waitForLocalCallback({
      port: listenPort,
      callbackPath,
      expectedState: state,
      timeoutMs: (opts.timeoutSec ?? 300) * 1000
    });
    const { actualPort } = await callbackWaiter.ready;
    if (!redirectUri) {
      redirectUri = `http://127.0.0.1:${actualPort}${callbackPath}`;
    }
  } else if (!redirectUri) {
    redirectUri = cfg.recommended_local_redirect_uri || "http://127.0.0.1:8789/callback";
  }

  const authUrl = new URL(cfg.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const authUrlStr = authUrl.toString();
  errOut.write(`\nOpen this URL in your browser to authorize Traceveil CLI:\n\n  ${authUrlStr}\n\n`);
  if (!opts.noBrowser && !opts.manual) {
    openBrowserUrl(authUrlStr);
  }

  let code = "";
  if (opts.manual) {
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const pasted = (
        await rl.question("Paste the redirected callback URL (or authorization code): ")
      ).trim();
      if (pasted.startsWith("http://") || pasted.startsWith("https://")) {
        const cb = new URL(pasted);
        const cbState = cb.searchParams.get("state");
        if (cbState && cbState !== state) {
          throw new Error("Callback state mismatch");
        }
        code = cb.searchParams.get("code") || "";
      } else {
        code = pasted;
      }
      if (!code) throw new Error("No authorization code provided");
    } finally {
      rl.close();
    }
  } else if (callbackWaiter) {
    errOut.write(`Waiting for browser callback on ${redirectUri}...\n`);
    const res = await callbackWaiter.result;
    code = res.code;
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: cfg.token_endpoint,
    clientId,
    code,
    redirectUri,
    codeVerifier: pkce.verifier
  });

  const creds = buildCredentialsFromTokens({
    baseUrl,
    issuer,
    clientId,
    audience,
    authorizationEndpoint: cfg.authorization_endpoint,
    tokenEndpoint: cfg.token_endpoint,
    scopes,
    tokens
  });
  saveCredentials(creds);
  return creds;
}

export async function loginWithDeviceFlow(opts: {
  url: string;
  scopes?: string;
  noBrowser?: boolean;
  timeoutSec?: number;
  onPrompt?: (info: {
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
  }) => void;
}): Promise<StoredCredentials> {
  const baseUrl = normalizeBaseUrl(opts.url);
  const cfg = await fetchAuthConfig(baseUrl);
  if (!cfg.configured || !cfg.token_endpoint || !cfg.client_id || !cfg.issuer || !cfg.authorization_endpoint) {
    throw new Error(cfg.message || "Worker OIDC configuration is incomplete");
  }

  const startEndpoint =
    cfg.device_start_endpoint || `${baseUrl}/api/agent/auth/device/start`;
  const pollEndpoint =
    cfg.device_poll_endpoint || `${baseUrl}/api/agent/auth/device/poll`;

  const pkce = generatePkcePair();
  const startResp = await fetch(startEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      code_challenge: pkce.challenge,
      code_challenge_method: "S256"
    })
  });
  const startData = (await startResp.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    message?: string;
  };
  if (
    !startResp.ok ||
    !startData.device_code ||
    !startData.user_code ||
    !startData.verification_uri ||
    !startData.verification_uri_complete
  ) {
    throw new Error(
      startData.message || startData.error || `Device flow start failed (${startResp.status})`
    );
  }

  const expiresIn = startData.expires_in ?? 600;
  const intervalMs = Math.max(1000, (startData.interval ?? 3) * 1000);

  if (opts.onPrompt) {
    opts.onPrompt({
      user_code: startData.user_code,
      verification_uri: startData.verification_uri,
      verification_uri_complete: startData.verification_uri_complete,
      expires_in: expiresIn
    });
  } else {
    errOut.write(
      `\nTo authorize this CLI session:\n` +
        `  1. Open: ${startData.verification_uri_complete}\n` +
        `     (or visit ${startData.verification_uri} and enter code: ${startData.user_code})\n` +
        `  2. Confirm and complete Cloudflare Access login.\n\nWaiting for authorization...\n`
    );
  }

  if (!opts.noBrowser && out.isTTY) {
    // Only auto-open browser when not suppressed; harmless no-op on headless SSH
    openBrowserUrl(startData.verification_uri_complete);
  }

  const deadlineMs =
    Date.now() + Math.min(expiresIn, opts.timeoutSec ?? expiresIn) * 1000;

  let authCode = "";
  let callbackRedirectUri = "";

  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollResp = await fetch(pollEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ device_code: startData.device_code })
    });
    const pollData = (await pollResp.json()) as {
      status?: string;
      code?: string;
      redirect_uri?: string;
      error?: string;
      message?: string;
    };

    if (pollResp.ok && pollData.status === "approved" && pollData.code && pollData.redirect_uri) {
      authCode = pollData.code;
      callbackRedirectUri = pollData.redirect_uri;
      break;
    }
    if (pollResp.ok && pollData.status === "authorization_pending") {
      continue;
    }
    throw new Error(
      pollData.message || pollData.error || `Device authorization failed (${pollResp.status})`
    );
  }

  if (!authCode) {
    throw new Error("Timed out waiting for device authorization");
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: cfg.token_endpoint,
    clientId: cfg.client_id,
    code: authCode,
    redirectUri: callbackRedirectUri,
    codeVerifier: pkce.verifier
  });

  const creds = buildCredentialsFromTokens({
    baseUrl,
    issuer: cfg.issuer,
    clientId: cfg.client_id,
    audience: cfg.audience || cfg.client_id,
    authorizationEndpoint: cfg.authorization_endpoint,
    tokenEndpoint: cfg.token_endpoint,
    scopes: opts.scopes || cfg.scopes || "openid email profile",
    tokens
  });
  saveCredentials(creds);
  return creds;
}

export async function refreshCredentials(
  creds: StoredCredentials
): Promise<StoredCredentials> {
  if (!creds.refresh_token) {
    throw new Error("No refresh_token available; run `traceveil auth login`");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.client_id,
    refresh_token: creds.refresh_token
  });

  const resp = await fetch(creds.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  const data = (await resp.json()) as TokenEndpointResponse;
  if (!resp.ok || data.error || !data.access_token) {
    throw new Error(
      `Token refresh failed (${resp.status}): ${data.error_description || data.error || "unknown error"}`
    );
  }

  const updated = buildCredentialsFromTokens({
    baseUrl: creds.url,
    issuer: creds.issuer,
    clientId: creds.client_id,
    audience: creds.audience || creds.client_id,
    authorizationEndpoint: creds.authorization_endpoint,
    tokenEndpoint: creds.token_endpoint,
    scopes: creds.scopes,
    tokens: data,
    previousRefreshToken: creds.refresh_token
  });
  saveCredentials(updated);
  return updated;
}
