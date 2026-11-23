import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredCredentials {
  url: string;
  issuer: string;
  client_id: string;
  audience?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes: string;
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_at: number;
  email: string | null;
  sub: string | null;
  updated_at: number;
}

export function getConfigDir(): string {
  const override = process.env.TRACEVEIL_CONFIG_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "traceveil");
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "traceveil");
  }
  return path.join(os.homedir(), ".config", "traceveil");
}

export function getCacheDir(): string {
  const override = process.env.TRACEVEIL_CACHE_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, "traceveil");
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "traceveil");
  }
  return path.join(os.homedir(), ".cache", "traceveil");
}

export function getCredentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

export function getBlobCacheDir(): string {
  return path.join(getCacheDir(), "blobs");
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid URL (must start with http:// or https://): ${raw}`);
  }
  return trimmed;
}

export function loadCredentials(): StoredCredentials | null {
  const filePath = getCredentialsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredCredentials;
    if (!parsed || typeof parsed.url !== "string" || typeof parsed.access_token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  const filePath = getCredentialsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore chmod failures on filesystems that don't support POSIX modes
    }
  }
}

export function removeCredentials(): boolean {
  const filePath = getCredentialsPath();
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}
