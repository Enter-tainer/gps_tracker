import type { D1Database } from "@cloudflare/workers-types";

export interface OidcEnv {
  TRACKS_DB: D1Database;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_AUD?: string;
  OIDC_SCOPES?: string;
  OIDC_ALLOWED_EMAILS?: string;
}

export interface OidcPrincipal {
  sub: string;
  email: string | null;
  name: string | null;
  exp: number;
  iat: number | null;
  iss: string;
  aud: string | string[];
}

export interface OidcDiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface JwkKey extends JsonWebKey {
  kid?: string;
  use?: string;
  alg?: string;
  kty: string;
}

interface JwksResponse {
  keys: JwkKey[];
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  email?: unknown;
  name?: unknown;
}

interface DeviceSessionRow {
  device_code_hash: string;
  user_code: string;
  oauth_state: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  status: string;
  auth_code: string | null;
  error: string | null;
  created_at: number;
  expires_at: number;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 15 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const DEVICE_CODE_TTL_S = 600;
const DEVICE_POLL_INTERVAL_S = 3;
const CLOCK_SKEW_S = 30;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const discoveryCache = new Map<
  string,
  { doc: OidcDiscoveryDoc; expiresAt: number }
>();
const jwksCache = new Map<
  string,
  { keys: JwkKey[]; expiresAt: number; lastFetchAt: number }
>();

export class OidcAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "OidcAuthError";
    this.code = code;
    this.status = status;
  }
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
    }
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

function parseScopes(raw?: string): string {
  const cleaned = (raw ?? "").trim();
  return cleaned || "openid email profile";
}

function parseAllowedEmails(raw?: string): Set<string> | null {
  if (!raw || !raw.trim()) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return set.size > 0 ? set : null;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const mod = padded.length % 4;
  if (mod === 1) {
    throw new Error("Invalid base64url length");
  }
  const full = mod === 0 ? padded : padded + "=".repeat(4 - mod);
  const bin = atob(full);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomTokenBytes(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function generateUserCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += USER_CODE_ALPHABET[buf[i] % USER_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizeUserCodeInput(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return "";
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function decodeJwtSegment<T>(segment: string): T {
  const bytes = base64UrlDecode(segment);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

function isOidcConfigured(env: OidcEnv): {
  configured: boolean;
  issuer: string;
  clientId: string;
  audience: string;
  scopes: string;
} {
  const issuer = normalizeIssuer(env.OIDC_ISSUER ?? "");
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  const audience = (env.OIDC_AUD ?? "").trim() || clientId;
  const scopes = parseScopes(env.OIDC_SCOPES);
  return {
    configured: Boolean(issuer && clientId),
    issuer,
    clientId,
    audience,
    scopes
  };
}

export async function discoverOidc(issuer: string): Promise<OidcDiscoveryDoc> {
  const norm = normalizeIssuer(issuer);
  const now = Date.now();
  const cached = discoveryCache.get(norm);
  if (cached && cached.expiresAt > now) {
    return cached.doc;
  }

  const discoveryUrl = `${norm}/.well-known/openid-configuration`;
  const resp = await fetch(discoveryUrl, {
    headers: { Accept: "application/json" }
  });
  if (!resp.ok) {
    throw new OidcAuthError(
      "oidc_discovery_failed",
      `Failed to fetch OIDC discovery from ${discoveryUrl} (${resp.status})`,
      502
    );
  }
  const doc = (await resp.json()) as Partial<OidcDiscoveryDoc>;
  if (
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new OidcAuthError(
      "oidc_discovery_invalid",
      "OIDC discovery document missing required endpoints",
      502
    );
  }
  const fullDoc: OidcDiscoveryDoc = {
    issuer: normalizeIssuer(doc.issuer ?? norm),
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    userinfo_endpoint:
      typeof doc.userinfo_endpoint === "string"
        ? doc.userinfo_endpoint
        : undefined
  };
  discoveryCache.set(norm, {
    doc: fullDoc,
    expiresAt: now + DISCOVERY_TTL_MS
  });
  return fullDoc;
}

async function fetchJwks(
  jwksUri: string,
  forceRefresh = false
): Promise<JwkKey[]> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (cached) {
    if (!forceRefresh && cached.expiresAt > now) {
      return cached.keys;
    }
    if (forceRefresh && now - cached.lastFetchAt < JWKS_REFRESH_COOLDOWN_MS) {
      return cached.keys;
    }
  }

  const resp = await fetch(jwksUri, {
    headers: { Accept: "application/json" }
  });
  if (!resp.ok) {
    throw new OidcAuthError(
      "jwks_fetch_failed",
      `Failed to fetch JWKS (${resp.status})`,
      502
    );
  }
  const body = (await resp.json()) as Partial<JwksResponse>;
  if (!Array.isArray(body.keys)) {
    throw new OidcAuthError("jwks_invalid", "Invalid JWKS payload", 502);
  }
  jwksCache.set(jwksUri, {
    keys: body.keys,
    expiresAt: now + JWKS_TTL_MS,
    lastFetchAt: now
  });
  return body.keys;
}

type VerifyAlgSpec =
  | {
      importAlg: RsaHashedImportParams;
      verifyAlg: AlgorithmIdentifier | EcdsaParams;
      kty: "RSA";
    }
  | {
      importAlg: EcKeyImportParams;
      verifyAlg: EcdsaParams;
      kty: "EC";
      namedCurve: string;
    };

function getAlgSpec(alg: string): VerifyAlgSpec {
  switch (alg) {
    case "RS256":
      return {
        kty: "RSA",
        importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verifyAlg: "RSASSA-PKCS1-v1_5"
      };
    case "RS384":
      return {
        kty: "RSA",
        importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
        verifyAlg: "RSASSA-PKCS1-v1_5"
      };
    case "RS512":
      return {
        kty: "RSA",
        importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
        verifyAlg: "RSASSA-PKCS1-v1_5"
      };
    case "ES256":
      return {
        kty: "EC",
        namedCurve: "P-256",
        importAlg: { name: "ECDSA", namedCurve: "P-256" },
        verifyAlg: { name: "ECDSA", hash: "SHA-256" }
      };
    case "ES384":
      return {
        kty: "EC",
        namedCurve: "P-384",
        importAlg: { name: "ECDSA", namedCurve: "P-384" },
        verifyAlg: { name: "ECDSA", hash: "SHA-384" }
      };
    default:
      throw new OidcAuthError(
        "unsupported_alg",
        `Unsupported JWT alg: ${alg}`,
        401
      );
  }
}

function selectMatchingJwk(
  keys: JwkKey[],
  header: JwtHeader,
  spec: VerifyAlgSpec
): JwkKey[] {
  return keys.filter((k) => {
    if (k.kty !== spec.kty) return false;
    if (k.use && k.use !== "sig") return false;
    if (header.kid && k.kid && k.kid !== header.kid) return false;
    if (header.kid && !k.kid) return false;
    if (spec.kty === "EC" && k.crv && k.crv !== spec.namedCurve) return false;
    if (k.alg && header.alg && k.alg !== header.alg) return false;
    return true;
  });
}

async function verifySignatureWithKey(
  jwk: JwkKey,
  spec: VerifyAlgSpec,
  signingInput: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    spec.importAlg,
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    spec.verifyAlg,
    key,
    signature as unknown as BufferSource,
    signingInput as unknown as BufferSource
  );
}

function checkAllowedEmail(
  email: string | null,
  allowedEmails: Set<string> | null
): void {
  if (!allowedEmails) return;
  if (!email || !allowedEmails.has(email.toLowerCase())) {
    throw new OidcAuthError(
      "forbidden_email",
      "Authenticated email is not in OIDC_ALLOWED_EMAILS allowlist",
      403
    );
  }
}

function validateIssuerAndAudience(
  payload: JwtPayload,
  expectedIssuers: Set<string>,
  expectedAudience: string
): { iss: string; aud: string | string[] } {
  if (typeof payload.iss !== "string") {
    throw new OidcAuthError("invalid_token", "Token missing iss claim", 401);
  }
  const tokenIss = normalizeIssuer(payload.iss);
  if (!expectedIssuers.has(tokenIss)) {
    throw new OidcAuthError(
      "invalid_issuer",
      `Unexpected token issuer: ${tokenIss}`,
      401
    );
  }

  let audList: string[] = [];
  if (typeof payload.aud === "string") {
    audList = [payload.aud];
  } else if (Array.isArray(payload.aud)) {
    audList = payload.aud.filter((a): a is string => typeof a === "string");
  }
  if (!audList.includes(expectedAudience)) {
    throw new OidcAuthError(
      "invalid_audience",
      "Token audience does not match OIDC_AUD / OIDC_CLIENT_ID",
      401
    );
  }

  return {
    iss: tokenIss,
    aud:
      typeof payload.aud === "string"
        ? payload.aud
        : (audList as string[])
  };
}

async function verifyOpaqueViaUserinfo(
  token: string,
  discovery: OidcDiscoveryDoc,
  allowedEmails: Set<string> | null,
  expectedAudience: string
): Promise<OidcPrincipal> {
  if (!discovery.userinfo_endpoint) {
    throw new OidcAuthError(
      "invalid_token",
      "Bearer token is not a JWT and OIDC userinfo_endpoint is unavailable",
      401
    );
  }
  const resp = await fetch(discovery.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) {
    throw new OidcAuthError(
      "invalid_token",
      `OIDC userinfo rejected bearer token (${resp.status})`,
      401
    );
  }
  const info = (await resp.json()) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  };
  if (typeof info.sub !== "string" || !info.sub) {
    throw new OidcAuthError(
      "invalid_token",
      "OIDC userinfo response missing sub",
      401
    );
  }
  const email = typeof info.email === "string" ? info.email : null;
  checkAllowedEmail(email, allowedEmails);
  return {
    sub: info.sub,
    email,
    name: typeof info.name === "string" ? info.name : null,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: null,
    iss: discovery.issuer,
    aud: expectedAudience
  };
}

export async function verifyOidcJwt(
  token: string,
  env: OidcEnv
): Promise<OidcPrincipal> {
  const cfg = isOidcConfigured(env);
  if (!cfg.configured) {
    throw new OidcAuthError(
      "oidc_not_configured",
      "Worker OIDC_ISSUER / OIDC_CLIENT_ID is not configured",
      503
    );
  }

  const allowedEmails = parseAllowedEmails(env.OIDC_ALLOWED_EMAILS);
  const discovery = await discoverOidc(cfg.issuer);

  const parts = token.split(".");
  if (parts.length !== 3) {
    return verifyOpaqueViaUserinfo(token, discovery, allowedEmails, cfg.audience);
  }

  const [headerB64, payloadB64, sigB64] = parts;
  let header: JwtHeader;
  let payload: JwtPayload;
  let signature: Uint8Array;
  try {
    header = decodeJwtSegment<JwtHeader>(headerB64);
    payload = decodeJwtSegment<JwtPayload>(payloadB64);
    signature = base64UrlDecode(sigB64);
  } catch {
    throw new OidcAuthError("invalid_token", "Malformed JWT encoding", 401);
  }

  if (!header.alg || header.alg === "none" || header.alg.startsWith("HS")) {
    throw new OidcAuthError(
      "unsupported_alg",
      `Rejected JWT alg: ${header.alg ?? "missing"}`,
      401
    );
  }

  const spec = getAlgSpec(header.alg);

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new OidcAuthError("invalid_token", "Token missing numeric exp", 401);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > payload.exp + CLOCK_SKEW_S) {
    throw new OidcAuthError("token_expired", "Bearer token has expired", 401);
  }
  if (
    typeof payload.nbf === "number" &&
    Number.isFinite(payload.nbf) &&
    nowSec + CLOCK_SKEW_S < payload.nbf
  ) {
    throw new OidcAuthError("token_not_active", "Bearer token not active yet", 401);
  }

  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new OidcAuthError("invalid_token", "Token missing sub claim", 401);
  }

  const issuerOrigin = (() => {
    try {
      return normalizeIssuer(new URL(cfg.issuer).origin);
    } catch {
      return cfg.issuer;
    }
  })();

  const expectedIssuers = new Set<string>([
    cfg.issuer,
    discovery.issuer,
    issuerOrigin
  ]);
  const { iss, aud } = validateIssuerAndAudience(
    payload,
    expectedIssuers,
    cfg.audience
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let keys = await fetchJwks(discovery.jwks_uri, false);
  let candidates = selectMatchingJwk(keys, header, spec);

  if (candidates.length === 0) {
    keys = await fetchJwks(discovery.jwks_uri, true);
    candidates = selectMatchingJwk(keys, header, spec);
  }

  let verified = false;
  for (const jwk of candidates) {
    try {
      if (await verifySignatureWithKey(jwk, spec, signingInput, signature)) {
        verified = true;
        break;
      }
    } catch {
      // Try next matching key if one JWK fails verification
    }
  }

  if (!verified && header.kid) {
    // Retry once on signature failure in case key rotated with same kid or stale cache
    const refreshedKeys = await fetchJwks(discovery.jwks_uri, true);
    const refreshedCandidates = selectMatchingJwk(refreshedKeys, header, spec);
    for (const jwk of refreshedCandidates) {
      try {
        if (await verifySignatureWithKey(jwk, spec, signingInput, signature)) {
          verified = true;
          break;
        }
      } catch {
        // Ignore individual key errors
      }
    }
  }

  if (!verified) {
    throw new OidcAuthError(
      "invalid_signature",
      "JWT signature verification failed",
      401
    );
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  checkAllowedEmail(email, allowedEmails);

  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : null,
    iss,
    aud
  };
}

export async function verifyOidcBearer(
  request: Request,
  env: OidcEnv
): Promise<OidcPrincipal> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim()) {
    throw new OidcAuthError(
      "missing_token",
      "Missing Authorization: Bearer <token> header",
      401
    );
  }
  return verifyOidcJwt(match[1].trim(), env);
}

async function handleGetAuthConfig(
  request: Request,
  env: OidcEnv
): Promise<Response> {
  const cfg = isOidcConfigured(env);
  if (!cfg.configured) {
    return jsonResponse(
      {
        configured: false,
        error: "oidc_not_configured",
        message: "OIDC_ISSUER and OIDC_CLIENT_ID are not set on the Worker"
      },
      503
    );
  }

  const discovery = await discoverOidc(cfg.issuer);
  const origin = new URL(request.url).origin;

  return jsonResponse({
    configured: true,
    issuer: discovery.issuer,
    client_id: cfg.clientId,
    audience: cfg.audience,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    jwks_uri: discovery.jwks_uri,
    scopes: cfg.scopes,
    device_flow_enabled: true,
    device_start_endpoint: `${origin}/api/agent/auth/device/start`,
    device_poll_endpoint: `${origin}/api/agent/auth/device/poll`,
    device_verification_uri: `${origin}/api/agent/auth/device/verify`,
    device_callback_uri: `${origin}/api/agent/auth/device/callback`,
    recommended_local_redirect_uri: "http://127.0.0.1:8789/callback"
  });
}

async function handleDeviceStart(
  request: Request,
  env: OidcEnv
): Promise<Response> {
  const cfg = isOidcConfigured(env);
  if (!cfg.configured) {
    return jsonResponse(
      {
        error: "oidc_not_configured",
        message: "OIDC_ISSUER and OIDC_CLIENT_ID are not set on the Worker"
      },
      503
    );
  }

  let body: {
    code_challenge?: unknown;
    code_challenge_method?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_request", message: "Invalid JSON body" }, 400);
  }

  const codeChallenge =
    typeof body.code_challenge === "string" ? body.code_challenge.trim() : "";
  const method =
    typeof body.code_challenge_method === "string"
      ? body.code_challenge_method.trim()
      : "S256";

  if (!codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return jsonResponse(
      { error: "invalid_request", message: "Valid PKCE code_challenge is required" },
      400
    );
  }
  if (method !== "S256") {
    return jsonResponse(
      { error: "invalid_request", message: "code_challenge_method must be S256" },
      400
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + DEVICE_CODE_TTL_S;
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/agent/auth/device/callback`;

  await env.TRACKS_DB.prepare(
    `DELETE FROM agent_device_sessions WHERE expires_at <= ?`
  )
    .bind(nowSec)
    .run();

  const deviceCode = randomTokenBytes(32);
  const deviceCodeHash = await sha256Hex(deviceCode);
  const oauthState = randomTokenBytes(24);
  let userCode = "";

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateUserCode();
    try {
      await env.TRACKS_DB.prepare(
        `INSERT INTO agent_device_sessions (
          device_code_hash, user_code, oauth_state, code_challenge,
          code_challenge_method, redirect_uri, status, auth_code, error,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`
      )
        .bind(
          deviceCodeHash,
          candidate,
          oauthState,
          codeChallenge,
          "S256",
          redirectUri,
          nowSec,
          expiresAt
        )
        .run();
      userCode = candidate;
      break;
    } catch {
      // Retry on rare user_code collision
    }
  }

  if (!userCode) {
    return jsonResponse(
      { error: "server_error", message: "Could not allocate device session" },
      500
    );
  }

  const verificationUri = `${origin}/api/agent/auth/device/verify`;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(
    userCode
  )}`;

  return jsonResponse({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: DEVICE_CODE_TTL_S,
    interval: DEVICE_POLL_INTERVAL_S
  });
}

function renderDevicePage(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 28px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 12px; font-size: 20px; color: #f8fafc; }
    p { margin: 0 0 16px; line-height: 1.5; color: #cbd5e1; font-size: 14px; }
    label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
    input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 14px;
      font-size: 20px;
      letter-spacing: 2px;
      text-align: center;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      border-radius: 8px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f8fafc;
      margin-bottom: 18px;
    }
    .actions { display: flex; gap: 10px; }
    button {
      flex: 1;
      padding: 11px 16px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .primary { background: #3b82f6; color: white; }
    .primary:hover { background: #2563eb; }
    .secondary { background: #334155; color: #e2e8f0; }
    .secondary:hover { background: #475569; }
    .ok { color: #4ade80; }
    .err { color: #f87171; }
    code {
      background: #0f172a;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  </style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`;
  return htmlResponse(html, status);
}

async function handleDeviceVerifyGet(url: URL): Promise<Response> {
  const rawCode = url.searchParams.get("user_code") ?? "";
  const escapedCode = escapeHtml(rawCode.trim().toUpperCase());
  return renderDevicePage(
    "Authorize Traceveil CLI",
    `<h1>Authorize Traceveil CLI</h1>
     <p>Confirm that the verification code below matches the code shown in your terminal before continuing to Cloudflare Access login.</p>
     <form method="POST" action="/api/agent/auth/device/verify">
       <label for="user_code">Device Verification Code</label>
       <input id="user_code" name="user_code" type="text" value="${escapedCode}" placeholder="XXXX-XXXX" required autocomplete="off" />
       <div class="actions">
         <button class="secondary" type="submit" name="action" value="deny">Deny</button>
         <button class="primary" type="submit" name="action" value="approve">Continue to Login</button>
       </div>
     </form>`
  );
}

async function handleDeviceVerifyPost(
  request: Request,
  env: OidcEnv
): Promise<Response> {
  const cfg = isOidcConfigured(env);
  if (!cfg.configured) {
    return renderDevicePage(
      "OIDC Not Configured",
      `<h1 class="err">OIDC Not Configured</h1><p>Worker OIDC settings are incomplete.</p>`,
      503
    );
  }

  let formText = "";
  try {
    formText = await request.text();
  } catch {
    return renderDevicePage(
      "Invalid Request",
      `<h1 class="err">Invalid Request</h1><p>Failed to read form data.</p>`,
      400
    );
  }

  const params = new URLSearchParams(formText);
  const userCode = normalizeUserCodeInput(params.get("user_code") ?? "");
  const action = params.get("action") === "deny" ? "deny" : "approve";

  if (!userCode) {
    return renderDevicePage(
      "Invalid Code",
      `<h1 class="err">Invalid Verification Code</h1><p>Please check the 8-character code and try again.</p>`,
      400
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.TRACKS_DB.prepare(
    `SELECT device_code_hash, user_code, oauth_state, code_challenge,
            code_challenge_method, redirect_uri, status, expires_at
     FROM agent_device_sessions
     WHERE user_code = ?`
  )
    .bind(userCode)
    .first<DeviceSessionRow>();

  if (!row || row.expires_at <= nowSec) {
    return renderDevicePage(
      "Code Expired",
      `<h1 class="err">Code Not Found or Expired</h1><p>Start a new login in your terminal with <code>traceveil auth login --device</code>.</p>`,
      400
    );
  }

  if (row.status !== "pending") {
    return renderDevicePage(
      "Already Processed",
      `<h1>Session Already Used</h1><p>This device code is no longer pending (status: <code>${escapeHtml(row.status)}</code>).</p>`,
      400
    );
  }

  if (action === "deny") {
    await env.TRACKS_DB.prepare(
      `UPDATE agent_device_sessions
       SET status = 'denied', error = 'access_denied'
       WHERE device_code_hash = ? AND status = 'pending'`
    )
      .bind(row.device_code_hash)
      .run();
    return renderDevicePage(
      "Authorization Denied",
      `<h1 class="err">Authorization Denied</h1><p>You denied the CLI login request. You can close this tab.</p>`
    );
  }

  const discovery = await discoverOidc(cfg.issuer);
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", row.redirect_uri);
  authUrl.searchParams.set("scope", cfg.scopes);
  authUrl.searchParams.set("state", row.oauth_state);
  authUrl.searchParams.set("code_challenge", row.code_challenge);
  authUrl.searchParams.set("code_challenge_method", row.code_challenge_method);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleDeviceCallback(
  url: URL,
  env: OidcEnv
): Promise<Response> {
  const state = (url.searchParams.get("state") ?? "").trim();
  const code = (url.searchParams.get("code") ?? "").trim();
  const oidcError = (url.searchParams.get("error") ?? "").trim();
  const oidcDesc = (url.searchParams.get("error_description") ?? "").trim();

  if (!state) {
    return renderDevicePage(
      "Missing State",
      `<h1 class="err">Missing OAuth State</h1><p>Invalid OIDC callback request.</p>`,
      400
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.TRACKS_DB.prepare(
    `SELECT device_code_hash, status, expires_at
     FROM agent_device_sessions
     WHERE oauth_state = ?`
  )
    .bind(state)
    .first<DeviceSessionRow>();

  if (!row || row.expires_at <= nowSec || row.status !== "pending") {
    return renderDevicePage(
      "Session Expired",
      `<h1 class="err">Session Expired or Already Completed</h1><p>Please restart <code>traceveil auth login --device</code> in your terminal.</p>`,
      400
    );
  }

  if (oidcError || !code) {
    const errMsg = oidcError || "missing_code";
    await env.TRACKS_DB.prepare(
      `UPDATE agent_device_sessions
       SET status = 'denied', error = ?
       WHERE device_code_hash = ? AND status = 'pending'`
    )
      .bind(errMsg, row.device_code_hash)
      .run();

    return renderDevicePage(
      "Login Failed",
      `<h1 class="err">Login Failed</h1><p>${escapeHtml(oidcDesc || errMsg)}</p>`,
      400
    );
  }

  await env.TRACKS_DB.prepare(
    `UPDATE agent_device_sessions
     SET status = 'approved', auth_code = ?
     WHERE device_code_hash = ? AND status = 'pending'`
  )
    .bind(code, row.device_code_hash)
    .run();

  return renderDevicePage(
    "CLI Authorized",
    `<h1 class="ok">Authorization Complete</h1><p>Your Traceveil CLI session is authorized. Return to your terminal — it will finish logging in automatically.</p>`
  );
}

async function handleDevicePoll(
  request: Request,
  env: OidcEnv
): Promise<Response> {
  let body: { device_code?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_request", message: "Invalid JSON body" }, 400);
  }

  const deviceCode =
    typeof body.device_code === "string" ? body.device_code.trim() : "";
  if (!deviceCode) {
    return jsonResponse(
      { error: "invalid_request", message: "device_code is required" },
      400
    );
  }

  const deviceCodeHash = await sha256Hex(deviceCode);
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.TRACKS_DB.prepare(
    `SELECT device_code_hash, redirect_uri, status, auth_code, error, expires_at
     FROM agent_device_sessions
     WHERE device_code_hash = ?`
  )
    .bind(deviceCodeHash)
    .first<DeviceSessionRow>();

  if (!row || row.expires_at <= nowSec) {
    return jsonResponse(
      { error: "expired_token", message: "Device code expired or unknown" },
      400
    );
  }

  if (row.status === "pending") {
    return jsonResponse({ status: "authorization_pending" }, 200);
  }

  if (row.status === "denied") {
    return jsonResponse(
      { error: row.error || "access_denied", message: "Authorization was denied" },
      400
    );
  }

  if (row.status === "consumed" || !row.auth_code) {
    return jsonResponse(
      { error: "expired_token", message: "Device code already consumed" },
      400
    );
  }

  const consumeRes = await env.TRACKS_DB.prepare(
    `UPDATE agent_device_sessions
     SET status = 'consumed', auth_code = NULL
     WHERE device_code_hash = ? AND status = 'approved' AND auth_code IS NOT NULL`
  )
    .bind(deviceCodeHash)
    .run();

  if (consumeRes.meta && typeof consumeRes.meta.changes === "number" && consumeRes.meta.changes === 0) {
    return jsonResponse(
      { error: "expired_token", message: "Device code already consumed" },
      400
    );
  }

  return jsonResponse({
    status: "approved",
    code: row.auth_code,
    redirect_uri: row.redirect_uri
  });
}

export async function handleAgentAuthRequest(
  request: Request,
  env: OidcEnv,
  url: URL
): Promise<Response | null> {
  const pathname = url.pathname;
  if (pathname === "/api/agent/auth/config" && request.method === "GET") {
    return handleGetAuthConfig(request, env);
  }
  if (pathname === "/api/agent/auth/device/start" && request.method === "POST") {
    return handleDeviceStart(request, env);
  }
  if (pathname === "/api/agent/auth/device/verify" && request.method === "GET") {
    return handleDeviceVerifyGet(url);
  }
  if (pathname === "/api/agent/auth/device/verify" && request.method === "POST") {
    return handleDeviceVerifyPost(request, env);
  }
  if (pathname === "/api/agent/auth/device/callback" && request.method === "GET") {
    return handleDeviceCallback(url, env);
  }
  if (pathname === "/api/agent/auth/device/poll" && request.method === "POST") {
    return handleDevicePoll(request, env);
  }
  return null;
}
