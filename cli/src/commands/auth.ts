import {
  getCredentialsPath,
  loadCredentials,
  normalizeBaseUrl,
  removeCredentials
} from "../config.ts";
import {
  decodeJwtPayload,
  fetchAuthConfig,
  loginWithDeviceFlow,
  loginWithPkce,
  refreshCredentials,
  selectBearerToken
} from "../oidc.ts";
import { writeJson } from "../output.ts";

export interface AuthCmdFlags {
  url?: string;
  device?: boolean;
  port?: number;
  redirectUri?: string;
  manual?: boolean;
  noBrowser?: boolean;
  scope?: string;
  issuer?: string;
  clientId?: string;
  jsonMode: boolean;
  pretty?: boolean;
}

export async function runAuthCommand(
  subcmd: string,
  flags: AuthCmdFlags
): Promise<number> {
  if (subcmd === "login") {
    const targetUrl =
      flags.url?.trim() ||
      process.env.TRACEVEIL_URL?.trim() ||
      loadCredentials()?.url ||
      "";
    if (!targetUrl) {
      throw new Error(
        "Missing target URL. Pass `--url https://<your-traceveil-host>` or set TRACEVEIL_URL."
      );
    }

    const creds = flags.device
      ? await loginWithDeviceFlow({
          url: targetUrl,
          scopes: flags.scope,
          noBrowser: flags.noBrowser,
          onPrompt: flags.jsonMode
            ? undefined
            : (info) => {
                process.stderr.write(
                  `\nTraceveil Device Login\n` +
                    `  Verification URL : ${info.verification_uri_complete}\n` +
                    `  Manual URL       : ${info.verification_uri}\n` +
                    `  Code             : ${info.user_code}\n` +
                    `  Expires in       : ${info.expires_in}s\n\nWaiting for browser approval...\n`
                );
              }
        })
      : await loginWithPkce({
          url: targetUrl,
          port: flags.port,
          redirectUri: flags.redirectUri,
          scopes: flags.scope,
          manual: flags.manual,
          noBrowser: flags.noBrowser,
          issuer: flags.issuer,
          clientId: flags.clientId
        });

    const summary = {
      authenticated: true,
      url: creds.url,
      email: creds.email,
      sub: creds.sub,
      expires_at: creds.expires_at,
      expires_iso: new Date(creds.expires_at * 1000).toISOString(),
      has_refresh_token: Boolean(creds.refresh_token),
      credentials_path: getCredentialsPath()
    };

    if (flags.jsonMode) {
      writeJson(summary, Boolean(flags.pretty));
    } else {
      process.stdout.write(
        `Logged in to ${summary.url}${summary.email ? ` as ${summary.email}` : ""}\n` +
          `Token expires: ${summary.expires_iso} (refresh_token: ${summary.has_refresh_token ? "yes" : "no"})\n` +
          `Credentials saved: ${summary.credentials_path}\n`
      );
    }
    return 0;
  }

  if (subcmd === "status") {
    const urlFlag = flags.url?.trim() || process.env.TRACEVEIL_URL?.trim();
    const envToken = process.env.TRACEVEIL_TOKEN?.trim();

    if (envToken) {
      const payload = decodeJwtPayload(envToken);
      const exp = payload && typeof payload.exp === "number" ? payload.exp : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const statusObj = {
        authenticated: exp === null || nowSec < exp,
        source: "env:TRACEVEIL_TOKEN",
        url: urlFlag ? normalizeBaseUrl(urlFlag) : null,
        email: payload && typeof payload.email === "string" ? payload.email : null,
        sub: payload && typeof payload.sub === "string" ? payload.sub : null,
        expires_at: exp,
        expires_iso: exp ? new Date(exp * 1000).toISOString() : null
      };
      if (flags.jsonMode) writeJson(statusObj, Boolean(flags.pretty));
      else {
        process.stdout.write(
          `Authenticated via TRACEVEIL_TOKEN (${statusObj.email ?? statusObj.sub ?? "token"})\n`
        );
      }
      return statusObj.authenticated ? 0 : 2;
    }

    let creds = loadCredentials();
    if (!creds) {
      if (urlFlag) {
        try {
          const cfg = await fetchAuthConfig(urlFlag);
          if (cfg.local_dev && !cfg.configured) {
            const devStatus = {
              authenticated: true,
              source: "local_dev",
              url: normalizeBaseUrl(urlFlag),
              email: "local@dev",
              local_dev: true
            };
            if (flags.jsonMode) writeJson(devStatus, Boolean(flags.pretty));
            else {
              process.stdout.write(
                `Target ${devStatus.url} is running in local Vite dev mode (no OIDC required).\n`
              );
            }
            return 0;
          }
        } catch {
          // Ignore unreachable URL when reporting logged-out status
        }
      }

      const loggedOut = {
        authenticated: false,
        error: "auth_required",
        message: "Not logged in. Run `traceveil auth login --url https://<your-host>`.",
        credentials_path: getCredentialsPath()
      };
      if (flags.jsonMode) writeJson(loggedOut, Boolean(flags.pretty));
      else process.stdout.write(`${loggedOut.message}\n`);
      return 2;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let refreshed = false;
    if (nowSec >= creds.expires_at - 60 && creds.refresh_token) {
      try {
        creds = await refreshCredentials(creds);
        refreshed = true;
      } catch {
        // Leave expired credentials intact so status reports expired
      }
    }

    const bearer = selectBearerToken(creds);
    const payload = decodeJwtPayload(bearer);
    const exp =
      (payload && typeof payload.exp === "number" ? payload.exp : creds.expires_at) ||
      0;
    const valid = nowSec < exp;

    const statusObj = {
      authenticated: valid,
      source: "credentials_file",
      url: creds.url,
      email: creds.email,
      sub: creds.sub,
      expires_at: exp,
      expires_iso: exp ? new Date(exp * 1000).toISOString() : null,
      seconds_remaining: Math.max(0, exp - nowSec),
      has_refresh_token: Boolean(creds.refresh_token),
      refreshed,
      credentials_path: getCredentialsPath()
    };

    if (flags.jsonMode) {
      writeJson(statusObj, Boolean(flags.pretty));
    } else {
      process.stdout.write(
        `Status   : ${valid ? "authenticated" : "expired"}\n` +
          `Server   : ${creds.url}\n` +
          `Account  : ${creds.email ?? creds.sub ?? "(unknown)"}\n` +
          `Expires  : ${statusObj.expires_iso} (${statusObj.seconds_remaining}s remaining)\n` +
          `Refresh  : ${statusObj.has_refresh_token ? "available" : "none"}\n`
      );
    }
    return valid ? 0 : 2;
  }

  if (subcmd === "logout") {
    const removed = removeCredentials();
    const outObj = {
      logged_out: true,
      removed_credentials: removed,
      credentials_path: getCredentialsPath()
    };
    if (flags.jsonMode) writeJson(outObj, Boolean(flags.pretty));
    else {
      process.stdout.write(
        removed
          ? `Logged out (removed ${getCredentialsPath()}).\n`
          : "Already logged out (no credentials file found).\n"
      );
    }
    return 0;
  }

  throw new Error(`Unknown auth subcommand: ${subcmd}. Expected login | status | logout.`);
}
