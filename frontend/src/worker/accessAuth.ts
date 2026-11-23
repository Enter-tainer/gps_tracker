export interface AccessAuthEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
}

export interface AccessPrincipal {
  sub: string;
  email: string | null;
  name: string | null;
  exp: number | null;
  iat: number | null;
  iss: string | null;
  aud: string | string[] | null;
  verified: boolean;
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

const JWKS_TTL_MS = 15 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const CLOCK_SKEW_S = 30;

const jwksCache = new Map<
  string,
  { keys: JwkKey[]; expiresAt: number; lastFetchAt: number }
>();

export class AccessAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "AccessAuthError";
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

function normalizeTeamOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed).origin;
  }
  return `https://${trimmed}`;
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

function decodeJwtSegment<T>(segment: string): T {
  const bytes = base64UrlDecode(segment);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
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
      throw new AccessAuthError(
        "unsupported_alg",
        `Unsupported JWT alg: ${alg}`,
        401
      );
  }
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
    throw new AccessAuthError(
      "jwks_fetch_failed",
      `Failed to fetch Cloudflare Access JWKS (${resp.status})`,
      502
    );
  }
  const body = (await resp.json()) as Partial<JwksResponse>;
  if (!Array.isArray(body.keys)) {
    throw new AccessAuthError("jwks_invalid", "Invalid Access JWKS payload", 502);
  }
  jwksCache.set(jwksUri, {
    keys: body.keys,
    expiresAt: now + JWKS_TTL_MS,
    lastFetchAt: now
  });
  return body.keys;
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
    throw new AccessAuthError(
      "forbidden_email",
      "Authenticated email is not in CF_ACCESS_ALLOWED_EMAILS allowlist",
      403
    );
  }
}

function extractJwtAndEmail(request: Request): {
  jwt: string | null;
  bearerRaw: string | null;
  headerEmail: string | null;
} {
  const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() || null;
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearerRaw = match && match[1].trim() ? match[1].trim() : null;
  const headerEmail =
    request.headers.get("Cf-Access-Authenticated-User-Email")?.trim() || null;

  const jwt =
    cfJwt && cfJwt.split(".").length === 3
      ? cfJwt
      : bearerRaw && bearerRaw.split(".").length === 3
        ? bearerRaw
        : null;

  return { jwt, bearerRaw, headerEmail };
}

async function verifyAccessJwt(
  token: string,
  teamOrigin: string,
  expectedAud: string | null,
  requestOrigin: string,
  headerEmail: string | null,
  allowedEmails: Set<string> | null
): Promise<AccessPrincipal> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessAuthError("invalid_token", "Expected JWT token", 401);
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
    throw new AccessAuthError("invalid_token", "Malformed JWT encoding", 401);
  }

  if (!header.alg || header.alg === "none" || header.alg.startsWith("HS")) {
    throw new AccessAuthError(
      "unsupported_alg",
      `Rejected JWT alg: ${header.alg ?? "missing"}`,
      401
    );
  }

  const spec = getAlgSpec(header.alg);
  const nowSec = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new AccessAuthError("invalid_token", "Token missing numeric exp", 401);
  }
  if (nowSec > payload.exp + CLOCK_SKEW_S) {
    throw new AccessAuthError("token_expired", "Access JWT has expired", 401);
  }
  if (
    typeof payload.nbf === "number" &&
    Number.isFinite(payload.nbf) &&
    nowSec + CLOCK_SKEW_S < payload.nbf
  ) {
    throw new AccessAuthError("token_not_active", "Access JWT not active yet", 401);
  }

  if (typeof payload.iss !== "string") {
    throw new AccessAuthError("invalid_token", "Token missing iss claim", 401);
  }
  const tokenIss = normalizeTeamOrigin(payload.iss);
  if (tokenIss !== teamOrigin) {
    throw new AccessAuthError(
      "invalid_issuer",
      `Unexpected Access issuer: ${tokenIss}`,
      401
    );
  }

  const audList =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud)
        ? payload.aud.filter((a): a is string => typeof a === "string")
        : [];
  if (expectedAud) {
    const accepted = new Set([expectedAud, requestOrigin]);
    if (!audList.some((a) => accepted.has(a))) {
      throw new AccessAuthError(
        "invalid_audience",
        "Token audience does not match CF_ACCESS_AUD",
        401
      );
    }
  }

  const certsUrl = `${teamOrigin}/cdn-cgi/access/certs`;
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let keys = await fetchJwks(certsUrl, false);
  let candidates = selectMatchingJwk(keys, header, spec);

  if (candidates.length === 0) {
    keys = await fetchJwks(certsUrl, true);
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
      // Try next candidate
    }
  }

  if (!verified && header.kid) {
    const refreshedKeys = await fetchJwks(certsUrl, true);
    const refreshedCandidates = selectMatchingJwk(refreshedKeys, header, spec);
    for (const jwk of refreshedCandidates) {
      try {
        if (await verifySignatureWithKey(jwk, spec, signingInput, signature)) {
          verified = true;
          break;
        }
      } catch {
        // Ignore individual key failure
      }
    }
  }

  if (!verified) {
    throw new AccessAuthError(
      "invalid_signature",
      "Cloudflare Access JWT signature verification failed",
      401
    );
  }

  const email =
    typeof payload.email === "string" ? payload.email : headerEmail;
  checkAllowedEmail(email, allowedEmails);

  const sub =
    typeof payload.sub === "string" && payload.sub
      ? payload.sub
      : email || "access-user";

  return {
    sub,
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : null,
    iss: tokenIss,
    aud:
      typeof payload.aud === "string"
        ? payload.aud
        : audList.length > 0
          ? audList
          : null,
    verified: true
  };
}

export async function authenticateAgentRequest(
  request: Request,
  env: AccessAuthEnv
): Promise<AccessPrincipal> {
  const allowedEmails = parseAllowedEmails(env.CF_ACCESS_ALLOWED_EMAILS);
  const teamOrigin = env.CF_ACCESS_TEAM_DOMAIN
    ? normalizeTeamOrigin(env.CF_ACCESS_TEAM_DOMAIN)
    : "";
  const expectedAud = env.CF_ACCESS_AUD?.trim() || null;
  const requestOrigin = new URL(request.url).origin;
  const { jwt, bearerRaw, headerEmail } = extractJwtAndEmail(request);

  if (teamOrigin) {
    if (!jwt) {
      throw new AccessAuthError(
        "missing_token",
        "Missing Cf-Access-Jwt-Assertion or Bearer JWT for Cloudflare Access verification",
        401
      );
    }
    return verifyAccessJwt(
      jwt,
      teamOrigin,
      expectedAud,
      requestOrigin,
      headerEmail,
      allowedEmails
    );
  }

  // Zero-config mode when sitting behind Cloudflare Access + Managed OAuth:
  // Cloudflare Access enforces authentication at the edge before invoking the Worker.
  if (!jwt && !headerEmail && !bearerRaw) {
    throw new AccessAuthError(
      "missing_auth",
      "Missing Cloudflare Access identity headers or Authorization Bearer token",
      401
    );
  }

  let payload: JwtPayload | null = null;
  if (jwt) {
    try {
      payload = decodeJwtSegment<JwtPayload>(jwt.split(".")[1]);
    } catch {
      payload = null;
    }
  }

  const email =
    (payload && typeof payload.email === "string" ? payload.email : null) ||
    headerEmail;
  checkAllowedEmail(email, allowedEmails);

  const sub =
    (payload && typeof payload.sub === "string" && payload.sub
      ? payload.sub
      : null) ||
    email ||
    "access-user";

  const aud = payload
    ? typeof payload.aud === "string"
      ? payload.aud
      : Array.isArray(payload.aud)
        ? payload.aud.filter((a): a is string => typeof a === "string")
        : null
    : null;

  return {
    sub,
    email,
    name: payload && typeof payload.name === "string" ? payload.name : null,
    exp: payload && typeof payload.exp === "number" ? payload.exp : null,
    iat: payload && typeof payload.iat === "number" ? payload.iat : null,
    iss: payload && typeof payload.iss === "string" ? payload.iss : null,
    aud,
    verified: false
  };
}
