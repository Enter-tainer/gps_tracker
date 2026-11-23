import fs from "node:fs";
import path from "node:path";

import {
  getBlobCacheDir,
  loadCredentials,
  normalizeBaseUrl,
  type StoredCredentials
} from "./config.ts";
import { httpRequest, type HttpRequestInit, type HttpResponse } from "./http.ts";
import { refreshCredentials } from "./oidc.ts";

export class AuthRequiredError extends Error {
  readonly code: string;

  constructor(message: string, code = "auth_required") {
    super(message);
    this.name = "AuthRequiredError";
    this.code = code;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AgentTrackItem {
  id: string;
  date: string;
  title: string;
  source_file: string;
  point_count: number;
  distance_m: number;
  distance_km: number;
  duration_s: number;
  elev_gain_m: number;
  min_ele: number;
  max_ele: number;
  start_time: number;
  end_time: number;
  start_iso: string | null;
  end_iso: string | null;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
  r2_key: string;
  created_at: number;
}

export interface AgentTrackRegionRef {
  rid: number;
  level: number;
  parentRid: number | null;
  country: string;
  nameZh: string;
  nameEn: string;
  cellCount: number;
  firstTs: number;
  lastTs: number;
  first_iso: string | null;
  last_iso: string | null;
}

export interface AgentRegionItem {
  rid: number;
  level: number;
  parentRid: number | null;
  country: string;
  nameZh: string;
  nameEn: string;
  directChildCount: number;
  leafChildCount: number;
  litDirectChildren: number;
  litLeafChildren: number;
  areaKm2: number;
  exploredCells: number;
  exploredAreaKm2: number;
  visitDays: number;
  trackCount: number;
  heat: number;
  firstTs: number;
  lastTs: number;
  bbox: [number, number, number, number];
  coverage_ratio: number;
  first_iso: string | null;
  last_iso: string | null;
}

export interface SpatialMatchItem {
  trackId: string;
  matchedPoints: number;
  firstTs: number;
  lastTs: number;
  first_iso: string | null;
  last_iso: string | null;
  track: AgentTrackItem;
}

export class TraceveilClient {
  private readonly baseUrl: string;
  private readonly explicitToken: string | null;
  private creds: StoredCredentials | null;
  private localDevChecked = false;
  private isLocalDev = false;

  constructor(opts?: { url?: string; token?: string }) {
    this.explicitToken =
      opts?.token?.trim() || process.env.TRACEVEIL_TOKEN?.trim() || null;
    this.creds = loadCredentials();

    const rawUrl =
      opts?.url?.trim() ||
      process.env.TRACEVEIL_URL?.trim() ||
      this.creds?.url ||
      "";
    if (!rawUrl) {
      throw new AuthRequiredError(
        "Not logged in and no --url / TRACEVEIL_URL specified. Run `traceveil auth login --url https://<your-host>` first."
      );
    }
    this.baseUrl = normalizeBaseUrl(rawUrl);
  }

  private async ensureAuthHeaders(): Promise<Record<string, string>> {
    if (this.explicitToken) {
      return { Authorization: `Bearer ${this.explicitToken}` };
    }

    if (this.creds && this.creds.url === this.baseUrl) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= this.creds.expires_at - 60 && this.creds.refresh_token) {
        try {
          this.creds = await refreshCredentials(this.creds);
        } catch (err) {
          if (nowSec >= this.creds.expires_at) {
            throw new AuthRequiredError(
              `Session expired and token refresh failed: ${err instanceof Error ? err.message : String(err)}. Run \`traceveil auth login --url ${this.baseUrl}\`.`
            );
          }
        }
      } else if (nowSec >= this.creds.expires_at) {
        throw new AuthRequiredError(
          `Session expired. Run \`traceveil auth login --url ${this.baseUrl}\`.`
        );
      }

      return { Authorization: `Bearer ${this.creds.access_token}` };
    }

    // Check if target is local Vite dev server (no Cloudflare Access auth)
    if (!this.localDevChecked) {
      this.localDevChecked = true;
      try {
        const probe = await httpRequest(`${this.baseUrl}/api/agent/me`, {
          headers: { Accept: "application/json" },
          redirect: "manual",
          attempts: 1,
          timeoutMs: 5000
        });
        if (probe.status === 200) {
          const data = await probe.json<{ local_dev?: boolean }>();
          this.isLocalDev = Boolean(data?.local_dev);
        }
      } catch {
        this.isLocalDev = false;
      }
    }
    if (this.isLocalDev) {
      return {};
    }

    throw new AuthRequiredError(
      `No saved session for ${this.baseUrl}. Run \`traceveil auth login --url ${this.baseUrl}\` (or add \`--manual\` for cross-device login).`
    );
  }

  private async fetchAuthed(
    apiPath: string,
    init?: HttpRequestInit
  ): Promise<HttpResponse> {
    const authHeaders = await this.ensureAuthHeaders();
    const url = `${this.baseUrl}${apiPath}`;
    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      ...(init?.headers ?? {})
    };

    const resp = await httpRequest(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...baseHeaders,
        ...authHeaders
      }
    });

    const needsRefresh = resp.status === 401 || resp.status === 302;
    if (
      needsRefresh &&
      !this.explicitToken &&
      this.creds &&
      this.creds.url === this.baseUrl &&
      this.creds.refresh_token
    ) {
      try {
        this.creds = await refreshCredentials(this.creds);
        const retryResp = await httpRequest(url, {
          ...init,
          redirect: "manual",
          headers: {
            ...baseHeaders,
            Authorization: `Bearer ${this.creds.access_token}`
          }
        });
        if (retryResp.status === 401 || retryResp.status === 302) {
          throw new AuthRequiredError(
            `Access token rejected (${retryResp.status}). Run \`traceveil auth login --url ${this.baseUrl}\`.`
          );
        }
        return retryResp;
      } catch (err) {
        if (err instanceof AuthRequiredError) throw err;
        throw new AuthRequiredError(
          `Token rejected (${resp.status}) and refresh failed. Run \`traceveil auth login --url ${this.baseUrl}\`.`
        );
      }
    }

    if (resp.status === 302) {
      throw new AuthRequiredError(
        "Redirected to Cloudflare Access login. Run `traceveil auth login` (and ensure Managed OAuth is enabled on the Access application)."
      );
    }

    return resp;
  }

  async getJson<T>(apiPath: string): Promise<T> {
    const resp = await this.fetchAuthed(apiPath, {
      headers: { Accept: "application/json" }
    });
    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        resp.status,
        "invalid_response",
        `Expected JSON from ${apiPath} (HTTP ${resp.status})`
      );
    }

    if (!resp.ok) {
      const errObj = data as { error?: string; message?: string };
      if (resp.status === 401) {
        throw new AuthRequiredError(
          errObj.message || errObj.error || "Unauthorized (401)"
        );
      }
      throw new ApiError(
        resp.status,
        errObj.error || "api_error",
        errObj.message || errObj.error || `API request failed (${resp.status})`
      );
    }
    return data as T;
  }

  async postJson<T>(apiPath: string, body: unknown): Promise<T> {
    const resp = await this.fetchAuthed(apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        resp.status,
        "invalid_response",
        `Expected JSON from ${apiPath} (HTTP ${resp.status})`
      );
    }
    if (!resp.ok) {
      const errObj = data as { error?: string; message?: string };
      if (resp.status === 401) {
        throw new AuthRequiredError(
          errObj.message || errObj.error || "Unauthorized (401)"
        );
      }
      throw new ApiError(
        resp.status,
        errObj.error || "api_error",
        errObj.message || errObj.error || `API request failed (${resp.status})`
      );
    }
    return data as T;
  }

  async getTrackGpsl0(
    trackId: string,
    opts?: { noCache?: boolean }
  ): Promise<Uint8Array> {
    const safeId = trackId.replace(/[^a-zA-Z0-9_.-]/g, "");
    const cacheFile = path.join(getBlobCacheDir(), `${safeId}.gpsl0`);
    if (!opts?.noCache && fs.existsSync(cacheFile)) {
      const buf = fs.readFileSync(cacheFile);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    const resp = await this.fetchAuthed(
      `/api/agent/tracks/${encodeURIComponent(safeId)}/gpsl0`,
      { headers: { Accept: "application/octet-stream, application/json" } }
    );
    if (!resp.ok) {
      let msg = `Failed to download GPSL0 for ${safeId} (${resp.status})`;
      try {
        const err = await resp.json<{ error?: string; message?: string }>();
        msg = err.message || err.error || msg;
      } catch {
        // Ignore non-JSON body
      }
      if (resp.status === 401) throw new AuthRequiredError(msg);
      throw new ApiError(resp.status, "blob_fetch_failed", msg);
    }

    const ab = await resp.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (!opts?.noCache) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, bytes);
    }
    return bytes;
  }
}
