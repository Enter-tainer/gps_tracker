import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredCredentials {
  url: string;
  resource: string;
  issuer: string;
  client_id: string;
  client_secret?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  redirect_uri: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  email: string | null;
  sub: string | null;
  updated_at: number;
}

export function getDataDir(): string {
  const override = process.env.TRACEVEIL_CONFIG_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "traceveil");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "traceveil"
    );
  }
  const xdgData =
    process.env.XDG_DATA_HOME?.trim() ||
    path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "traceveil");
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
    return path.join(localAppData, "traceveil", "cache");
  }
  return path.join(os.homedir(), ".cache", "traceveil");
}

export function getCredentialsPath(): string {
  const explicitFile = process.env.TRACEVEIL_AUTH_FILE?.trim();
  if (explicitFile) return path.resolve(explicitFile);
  return path.join(getDataDir(), "oauth.json");
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
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    ) as StoredCredentials;
    if (
      !parsed ||
      typeof parsed.url !== "string" ||
      typeof parsed.access_token !== "string" ||
      typeof parsed.token_endpoint !== "string"
    ) {
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
