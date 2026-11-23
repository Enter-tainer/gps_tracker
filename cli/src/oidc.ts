import { execFile } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { stdin as input, stderr as errOut } from "node:process";
import readline from "node:readline/promises";

import {
  normalizeBaseUrl,
  saveCredentials,
  type StoredCredentials
} from "./config.ts";
import { httpRequest } from "./http.ts";

export interface ProtectedResourceMetadata {
  resource?: string;
  protected?: boolean;
  team_domain?: string;
  authorization_servers?: string[];
}

export interface OAuthAsMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
}

export interface TokenEndpointResponse {
  access_token: string;
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

export type ManagedDiscoveryResult =
  | { localDev: true; baseUrl: string }
  | {
      localDev: false;
      baseUrl: string;
      resource: string;
      authorizationServer: string;
      asMeta: OAuthAsMetadata;
    };

export function generateCodeChallengeS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkcePair(): PkcePair {
  // Cloudflare Access Managed OAuth requires code_challenge to start with [a-zA-Z0-9].
  for (;;) {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = generateCodeChallengeS256(verifier);
    if (/^[a-zA-Z0-9]/.test(challenge)) {
      return { verifier, challenge };
    }
  }
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
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

export function openBrowserUrl(url: string): boolean {
  // On Windows, `cmd /c start` splits on `&` and corrupts OAuth query params.
  // `rundll32 url.dll,FileProtocolHandler` passes the URL as a single argv safely.
  try {
    if (process.platform === "win32") {
      execFile(
        "rundll32",
        ["url.dll,FileProtocolHandler", url],
        { windowsHide: true },
        () => undefined
      );
      return true;
    }
    if (process.platform === "darwin") {
      execFile("open", [url], () => undefined);
      return true;
    }
    execFile("xdg-open", [url], () => undefined);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function discoverManagedOAuth(
  rawUrl: string
): Promise<ManagedDiscoveryResult> {
  const baseUrl = normalizeBaseUrl(rawUrl);
  const probeUrl = `${baseUrl}/api/agent/me`;
  const probe = await httpRequest(probeUrl, {
    headers: { Accept: "application/json" },
    redirect: "manual"
  });

  if (probe.status === 200) {
    try {
      const body = await probe.json<{ local_dev?: boolean }>();
      if (body && body.local_dev) {
        return { localDev: true, baseUrl };
      }
    } catch {
      // Ignore non-JSON 200
    }
    throw new Error(
      `${baseUrl} returned HTTP 200 without Cloudflare Access protection. Ensure Cloudflare Access is enabled on this hostname.`
    );
  }

  let resourceMetadataUrl = `${baseUrl}/.well-known/cloudflare-access-protected-resource/`;
  const wwwAuth = probe.headers.get("www-authenticate") ?? "";
  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuth);
  if (match) {
    resourceMetadataUrl = match[1];
  } else if (probe.status >= 300 && probe.status < 400) {
    throw new Error(
      `Received HTTP ${probe.status} redirect without OAuth metadata. Enable "Managed OAuth (Beta)" in Cloudflare Zero Trust -> Access -> Applications -> Settings -> OAuth.`
    );
  }

  const prResp = await httpRequest(resourceMetadataUrl, {
    headers: { Accept: "application/json" }
  });
  if (!prResp.ok) {
    throw new Error(
      `Failed to fetch protected resource metadata from ${resourceMetadataUrl} (HTTP ${prResp.status})`
    );
  }

  const prMeta = await prResp.json<ProtectedResourceMetadata>();
  const authServer =
    (Array.isArray(prMeta.authorization_servers) &&
      prMeta.authorization_servers[0]) ||
    (prMeta.team_domain ? `https://${prMeta.team_domain}` : "");
  if (!authServer) {
    throw new Error(
      `Protected resource metadata missing authorization_servers: ${JSON.stringify(prMeta)}`
    );
  }

  const normalizedAs = authServer.replace(/\/+$/, "");
  const asMetaUrl = `${normalizedAs}/.well-known/oauth-authorization-server`;
  const asResp = await httpRequest(asMetaUrl, {
    headers: { Accept: "application/json" }
  });
  if (!asResp.ok) {
    throw new Error(
      `Failed to fetch OAuth authorization server metadata from ${asMetaUrl} (HTTP ${asResp.status})`
    );
  }

  const asMeta = await asResp.json<OAuthAsMetadata>();
  if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) {
    throw new Error(
      `OAuth authorization server metadata missing required endpoints at ${asMetaUrl}`
    );
  }

  let resource = baseUrl;
  if (typeof prMeta.resource === "string" && prMeta.resource.trim()) {
    try {
      resource = new URL(prMeta.resource).origin;
    } catch {
      resource = baseUrl;
    }
  }

  return {
    localDev: false,
    baseUrl,
    resource,
    authorizationServer: normalizedAs,
    asMeta
  };
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  resource: string
): Promise<{ client_id: string; client_secret?: string }> {
  const attempts = [
    {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Traceveil CLI",
      resource
    },
    {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Traceveil CLI"
    }
  ];

  let lastErr = "";
  for (const body of attempts) {
    const resp = await httpRequest(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let parsed: { client_id?: string; client_secret?: string } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { client_id?: string; client_secret?: string }) : null;
    } catch {
      parsed = null;
    }
    if (resp.ok && parsed?.client_id) {
      return {
        client_id: parsed.client_id,
        client_secret: parsed.client_secret
      };
    }
    lastErr = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
  }

  throw new Error(
    `Dynamic Client Registration failed (${lastErr}). Ensure Managed OAuth and localhost/loopback clients are enabled in Cloudflare Access.`
  );
}

function listenOnPortRange(
  preferredPort: number,
  tries = 10
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolvePort, reject) => {
    if (preferredPort === 0) {
      const server = http.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolvePort({ server, port });
      });
      return;
    }

    let attempt = 0;
    const tryPort = (port: number) => {
      const server = http.createServer();
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < tries) {
          attempt += 1;
          tryPort(preferredPort + attempt);
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => resolvePort({ server, port }));
    };
    tryPort(preferredPort);
  });
}

function waitForCallbackCode(
  server: http.Server,
  callbackPath: string,
  expectedState: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolveCode, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(
          new Error(
            `Timed out waiting for OAuth browser callback (${Math.round(timeoutMs / 1000)}s)`
          )
        );
      }
    }, timeoutMs);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const errDesc = url.searchParams.get("error_description");

      const sendHtml = (status: number, html: string) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      };

      if (err) {
        sendHtml(
          400,
          `<h2>Authorization Failed</h2><p>${escapeHtml(err)}: ${escapeHtml(errDesc ?? "")}</p>`
        );
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth error (${err}): ${errDesc ?? ""}`));
        }
        return;
      }

      if (!code) {
        sendHtml(400, "<h2>Missing authorization code</h2>");
        return;
      }

      if (state && expectedState && state !== expectedState) {
        sendHtml(400, "<h2>OAuth state mismatch</h2>");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(new Error("OAuth callback state mismatch"));
        }
        return;
      }

      sendHtml(
        200,
        "<h2>Traceveil CLI Authorized</h2><p>Login succeeded. You can close this page and return to your terminal.</p>"
      );
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        server.close();
        resolveCode(code);
      }
    });
  });
}

async function exchangeAuthorizationCode(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}): Promise<TokenEndpointResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    resource: params.resource
  });
  if (params.clientSecret) {
    form.set("client_secret", params.clientSecret);
  }

  const resp = await httpRequest(params.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  const text = await resp.text();
  let data: TokenEndpointResponse;
  try {
    data = JSON.parse(text) as TokenEndpointResponse;
  } catch {
    throw new Error(
      `Token endpoint returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 300)}`
    );
  }

  if (!resp.ok || data.error || !data.access_token) {
    throw new Error(
      `Token exchange failed (${resp.status}): ${data.error_description || data.error || text.slice(0, 300)}`
    );
  }
  return data;
}

async function fetchUserIdentity(
  baseUrl: string,
  accessToken: string
): Promise<{ email: string | null; sub: string | null }> {
  try {
    const resp = await httpRequest(`${baseUrl}/api/agent/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      redirect: "manual",
      attempts: 1,
      timeoutMs: 10_000
    });
    if (resp.ok) {
      const info = await resp.json<{ email?: unknown; sub?: unknown }>();
      return {
        email: typeof info.email === "string" ? info.email : null,
        sub: typeof info.sub === "string" ? info.sub : null
      };
    }
  } catch {
    // Best-effort enrichment only
  }
  return { email: null, sub: null };
}

function buildCredentials(params: {
  baseUrl: string;
  resource: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  redirectUri: string;
  tokens: TokenEndpointResponse;
  previousRefreshToken?: string;
  identity?: { email: string | null; sub: string | null };
}): StoredCredentials {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = decodeJwtPayload(params.tokens.access_token);
  const expFromJwt =
    payload && typeof payload.exp === "number" ? payload.exp : null;
  const expiresIn =
    typeof params.tokens.expires_in === "number" && params.tokens.expires_in > 0
      ? params.tokens.expires_in
      : 900;
  const expiresAt = expFromJwt ?? nowSec + expiresIn;

  const email =
    params.identity?.email ??
    (payload && typeof payload.email === "string" ? payload.email : null);
  const sub =
    params.identity?.sub ??
    (payload && typeof payload.sub === "string" ? payload.sub : null);

  return {
    url: normalizeBaseUrl(params.baseUrl),
    resource: params.resource,
    issuer: params.issuer,
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    authorization_endpoint: params.authorizationEndpoint,
    token_endpoint: params.tokenEndpoint,
    ...(params.registrationEndpoint
      ? { registration_endpoint: params.registrationEndpoint }
      : {}),
    ...(params.revocationEndpoint
      ? { revocation_endpoint: params.revocationEndpoint }
      : {}),
    redirect_uri: params.redirectUri,
    access_token: params.tokens.access_token,
    refresh_token: params.tokens.refresh_token ?? params.previousRefreshToken,
    expires_at: expiresAt,
    email,
    sub,
    updated_at: nowSec
  };
}

export async function loginWithManagedOAuth(opts: {
  url: string;
  port?: number;
  redirectHost?: string;
  redirectUri?: string;
  resource?: string;
  scope?: string;
  manual?: boolean;
  noBrowser?: boolean;
  timeoutSec?: number;
  clientId?: string;
}): Promise<StoredCredentials> {
  const disc = await discoverManagedOAuth(opts.url);
  if (disc.localDev) {
    throw new Error(
      `Target ${disc.baseUrl} is running in local Vite dev mode (no Cloudflare Access auth required). Pass --url directly to query commands.`
    );
  }

  const resource = opts.resource?.trim() || disc.resource;
  const pkce = generatePkcePair();
  const state = generateState();

  let server: http.Server | null = null;
  let redirectUri = opts.redirectUri?.trim() || "";
  let callbackPath = "/callback";

  if (!opts.manual) {
    let listenPort = opts.port ?? 8400;
    let host = opts.redirectHost?.trim() || "localhost";
    if (redirectUri) {
      const parsed = new URL(redirectUri);
      callbackPath = parsed.pathname || "/callback";
      listenPort = parsed.port ? Number(parsed.port) : listenPort;
      host = parsed.hostname || host;
    }
    const bound = await listenOnPortRange(listenPort);
    server = bound.server;
    if (!redirectUri) {
      redirectUri = `http://${host}:${bound.port}${callbackPath}`;
    }
  } else if (!redirectUri) {
    const host = opts.redirectHost?.trim() || "localhost";
    const port = opts.port && opts.port > 0 ? opts.port : 8400;
    redirectUri = `http://${host}:${port}/callback`;
  }

  let clientId = opts.clientId?.trim() || "";
  let clientSecret: string | undefined;
  if (!clientId) {
    if (!disc.asMeta.registration_endpoint) {
      server?.close();
      throw new Error(
        "Authorization server does not advertise registration_endpoint and no --client-id was supplied."
      );
    }
    const reg = await registerDynamicClient(
      disc.asMeta.registration_endpoint,
      redirectUri,
      resource
    ).catch((err) => {
      server?.close();
      throw err;
    });
    clientId = reg.client_id;
    clientSecret = reg.client_secret;
  }

  const authUrl = new URL(disc.asMeta.authorization_endpoint);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", resource);
  authUrl.searchParams.set("state", state);
  if (opts.scope?.trim()) {
    authUrl.searchParams.set("scope", opts.scope.trim());
  }

  const authUrlStr = authUrl.toString();
  let code = "";

  if (opts.manual) {
    errOut.write(
      `\n1. Open this URL in any browser and complete Cloudflare Access login:\n\n  ${authUrlStr}\n\n` +
        `2. After login, your browser will redirect to ${redirectUri}?code=... (it is normal if that localhost page fails to load on another device).\n` +
        `3. Copy the full redirected URL from the browser address bar.\n\n`
    );
    const rl = readline.createInterface({ input, output: errOut });
    try {
      const pasted = (
        await rl.question("Paste the redirected callback URL (or authorization code): ")
      ).trim();
      if (pasted.startsWith("http://") || pasted.startsWith("https://")) {
        const cb = new URL(pasted);
        const cbErr = cb.searchParams.get("error");
        if (cbErr) {
          throw new Error(
            `OAuth error (${cbErr}): ${cb.searchParams.get("error_description") ?? ""}`
          );
        }
        const cbState = cb.searchParams.get("state");
        if (cbState && cbState !== state) {
          throw new Error("Callback state mismatch");
        }
        code = cb.searchParams.get("code") || "";
      } else {
        code = pasted;
      }
      if (!code) throw new Error("No authorization code found in input");
    } finally {
      rl.close();
    }
  } else if (server) {
    const codePromise = waitForCallbackCode(
      server,
      callbackPath,
      state,
      (opts.timeoutSec ?? 300) * 1000
    );
    errOut.write(
      `\nOpen this URL in your browser to authorize Traceveil CLI:\n\n  ${authUrlStr}\n\n`
    );
    if (!opts.noBrowser) {
      openBrowserUrl(authUrlStr);
    }
    errOut.write(`Waiting for browser callback on ${redirectUri}...\n`);
    code = await codePromise;
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: disc.asMeta.token_endpoint,
    clientId,
    clientSecret,
    code,
    redirectUri,
    codeVerifier: pkce.verifier,
    resource
  });

  const identity = await fetchUserIdentity(disc.baseUrl, tokens.access_token);
  const creds = buildCredentials({
    baseUrl: disc.baseUrl,
    resource,
    issuer: disc.asMeta.issuer || disc.authorizationServer,
    clientId,
    clientSecret,
    authorizationEndpoint: disc.asMeta.authorization_endpoint,
    tokenEndpoint: disc.asMeta.token_endpoint,
    registrationEndpoint: disc.asMeta.registration_endpoint,
    revocationEndpoint: disc.asMeta.revocation_endpoint,
    redirectUri,
    tokens,
    identity
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
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
    resource: creds.resource || creds.url
  });
  if (creds.client_secret) {
    form.set("client_secret", creds.client_secret);
  }

  const resp = await httpRequest(creds.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  const text = await resp.text();
  let data: TokenEndpointResponse;
  try {
    data = JSON.parse(text) as TokenEndpointResponse;
  } catch {
    throw new Error(
      `Token refresh returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 300)}`
    );
  }

  if (!resp.ok || data.error || !data.access_token) {
    throw new Error(
      `Token refresh failed (${resp.status}): ${data.error_description || data.error || text.slice(0, 300)}`
    );
  }

  const identity =
    creds.email || creds.sub
      ? { email: creds.email, sub: creds.sub }
      : await fetchUserIdentity(creds.url, data.access_token);

  const updated = buildCredentials({
    baseUrl: creds.url,
    resource: creds.resource || creds.url,
    issuer: creds.issuer,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    authorizationEndpoint: creds.authorization_endpoint,
    tokenEndpoint: creds.token_endpoint,
    registrationEndpoint: creds.registration_endpoint,
    revocationEndpoint: creds.revocation_endpoint,
    redirectUri: creds.redirect_uri,
    tokens: data,
    previousRefreshToken: creds.refresh_token,
    identity
  });
  saveCredentials(updated);
  return updated;
}

export async function revokeCredentials(
  creds: StoredCredentials
): Promise<boolean> {
  if (!creds.revocation_endpoint) return false;
  const token = creds.refresh_token || creds.access_token;
  if (!token) return false;

  try {
    const form = new URLSearchParams({
      token,
      client_id: creds.client_id
    });
    if (creds.refresh_token) {
      form.set("token_type_hint", "refresh_token");
    }
    const resp = await httpRequest(creds.revocation_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: form.toString(),
      attempts: 1,
      timeoutMs: 10_000
    });
    return resp.ok;
  } catch {
    return false;
  }
}
