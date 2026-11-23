import { setDefaultResultOrder } from "node:dns";
import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";

// Prefer IPv4 to avoid Node fetch/undici hanging on broken AAAA routes to Cloudflare edge
try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Ignore on older Node versions
}

export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Buffer | null;
  redirect?: "follow" | "manual";
  timeoutMs?: number;
  attempts?: number;
}

function rawRequest(
  url: string,
  init: HttpRequestInit,
  timeoutMs: number
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? nodeHttpRequest : nodeHttpsRequest;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };

    let payload: Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      payload =
        typeof init.body === "string"
          ? Buffer.from(init.body, "utf8")
          : Buffer.from(init.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
        headers["Content-Length"] = String(payload.byteLength);
      }
    }

    const req = mod(
      u,
      {
        method: init.method ?? "GET",
        headers,
        family: 4,
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          const rawHeaders = res.headers;
          resolve({
            status,
            statusText: res.statusMessage ?? "",
            ok: status >= 200 && status < 300,
            headers: {
              get(name: string): string | null {
                const v = rawHeaders[name.toLowerCase()];
                if (Array.isArray(v)) return v.join(", ");
                return typeof v === "string" ? v : null;
              }
            },
            text: async () => buf.toString("utf8"),
            json: async <T = unknown>() => JSON.parse(buf.toString("utf8")) as T,
            arrayBuffer: async () =>
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function httpRequest(
  url: string,
  init: HttpRequestInit = {}
): Promise<HttpResponse> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const attempts = init.attempts ?? 3;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      let currentUrl = url;
      let currentMethod = (init.method ?? "GET").toUpperCase();
      let currentBody = init.body;
      let res = await rawRequest(
        currentUrl,
        { ...init, method: currentMethod, body: currentBody },
        timeoutMs
      );

      if (init.redirect !== "manual") {
        let hops = 0;
        while ([301, 302, 303, 307, 308].includes(res.status) && hops++ < 5) {
          const loc = res.headers.get("location");
          if (!loc) break;
          currentUrl = new URL(loc, currentUrl).toString();
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && currentMethod === "GET")
          ) {
            currentMethod = "GET";
            currentBody = undefined;
          }
          res = await rawRequest(
            currentUrl,
            { ...init, method: currentMethod, body: currentBody },
            timeoutMs
          );
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`HTTP request failed (${url}): ${msg}`);
}
