import {
  getCredentialsPath,
  loadCredentials,
  normalizeBaseUrl,
  removeCredentials
} from "../config.ts";
import { httpRequest } from "../http.ts";
import {
  decodeJwtPayload,
  loginWithManagedOAuth,
  refreshCredentials,
  revokeCredentials
} from "../oidc.ts";
import { writeJson } from "../output.ts";

export interface AuthCmdFlags {
  url?: string;
  port?: number;
  redirectHost?: string;
  redirectUri?: string;
  resource?: string;
  manual?: boolean;
  noBrowser?: boolean;
  scope?: string;
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

    const creds = await loginWithManagedOAuth({
      url: targetUrl,
      port: flags.port,
      redirectHost: flags.redirectHost,
      redirectUri: flags.redirectUri,
      resource: flags.resource,
      scope: flags.scope,
      manual: flags.manual,
      noBrowser: flags.noBrowser,
      clientId: flags.clientId
    });

    const summary = {
      authenticated: true,
      url: creds.url,
      resource: creds.resource,
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

  if (subcmd === "token") {
    const envToken = process.env.TRACEVEIL_TOKEN?.trim();
    if (envToken) {
      if (flags.jsonMode) writeJson({ access_token: envToken, source: "env:TRACEVEIL_TOKEN" }, Boolean(flags.pretty));
      else process.stdout.write(`${envToken}\n`);
      return 0;
    }

    let creds = loadCredentials();
    if (!creds) {
      const msg = "Not logged in. Run `traceveil auth login --url https://<your-host>`.";
      if (flags.jsonMode) writeJson({ error: "auth_required", message: msg }, Boolean(flags.pretty));
      else process.stderr.write(`${msg}\n`);
      return 2;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= creds.expires_at - 60) {
      if (!creds.refresh_token) {
        const msg = `Session expired and no refresh_token is available. Run \`traceveil auth login --url ${creds.url}\`.`;
        if (flags.jsonMode) writeJson({ error: "auth_required", message: msg }, Boolean(flags.pretty));
        else process.stderr.write(`${msg}\n`);
        return 2;
      }
      creds = await refreshCredentials(creds);
    }

    if (flags.jsonMode) {
      writeJson(
        {
          access_token: creds.access_token,
          expires_at: creds.expires_at,
          expires_iso: new Date(creds.expires_at * 1000).toISOString(),
          url: creds.url
        },
        Boolean(flags.pretty)
      );
    } else {
      process.stdout.write(`${creds.access_token}\n`);
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
          const probe = await httpRequest(
            `${normalizeBaseUrl(urlFlag)}/api/agent/me`,
            { headers: { Accept: "application/json" }, redirect: "manual", attempts: 1, timeoutMs: 5000 }
          );
          if (probe.status === 200) {
            const cfg = await probe.json<{ local_dev?: boolean }>();
            if (cfg.local_dev) {
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
                  `Target ${devStatus.url} is running in local Vite dev mode (no Cloudflare Access auth required).\n`
                );
              }
              return 0;
            }
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

    const exp = creds.expires_at || 0;
    const valid = nowSec < exp;

    const statusObj = {
      authenticated: valid,
      source: "credentials_file",
      url: creds.url,
      resource: creds.resource,
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
    const existing = loadCredentials();
    let revoked = false;
    if (existing) {
      revoked = await revokeCredentials(existing);
    }
    const removed = removeCredentials();
    const outObj = {
      logged_out: true,
      revoked,
      removed_credentials: removed,
      credentials_path: getCredentialsPath()
    };
    if (flags.jsonMode) writeJson(outObj, Boolean(flags.pretty));
    else {
      process.stdout.write(
        removed
          ? `Logged out (removed ${getCredentialsPath()}${revoked ? ", revoked remote token" : ""}).\n`
          : "Already logged out (no credentials file found).\n"
      );
    }
    return 0;
  }

  throw new Error(
    `Unknown auth subcommand: ${subcmd}. Expected login | status | token | logout.`
  );
}
