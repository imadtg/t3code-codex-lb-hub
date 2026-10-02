import { request } from "node:http";
import { isIP } from "node:net";

export const DASHBOARD_IDENTITY_HEADER = "X-T3-Hub-User";

type DashboardOptions = {
  baseUrl: string;
  identity: string;
  localAddress?: string;
  timeoutMs: number;
};

function isLoopback(value: string): boolean {
  return isIP(value) === 4 && value.startsWith("127.");
}

/** Bind dashboard requests to the loopback peer codex-lb explicitly trusts. */
export function createDashboardClient(options: DashboardOptions) {
  const base = new URL(options.baseUrl);
  const localAddress = options.localAddress ?? "127.0.0.2";
  const identity = options.identity.trim();
  if (base.protocol !== "http:" || !isLoopback(base.hostname) || base.username || base.password) {
    throw new Error("Dashboard identity authentication requires an HTTP IPv4 loopback upstream");
  }
  if (!isLoopback(localAddress) || localAddress === "127.0.0.1") {
    throw new Error("Dashboard local address must be a dedicated IPv4 loopback address, not 127.0.0.1");
  }
  if (!identity || identity.length > 512 || /[^\x20-\x7e]/.test(identity)) {
    throw new Error("Dashboard identity must contain 1–512 printable ASCII characters");
  }

  return (path: string, init?: RequestInit): Promise<Response> => {
    // Keep this privileged transport confined to the two reset-credit operations.
    if (!/^\/api\/accounts\/(?!\.{1,2}\/)[^/?#]+\/rate-limit-reset-credits(?:\/consume)?$/.test(path)) {
      throw new Error("Unsupported dashboard request path");
    }
    const method = init?.method ?? "GET";
    if ((method === "GET" && path.endsWith("/consume")) ||
        (method === "POST" && !path.endsWith("/consume")) ||
        (method !== "GET" && method !== "POST")) {
      throw new Error("Unsupported dashboard request method");
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    return new Promise((resolve, reject) => {
      const upstreamRequest = request(new URL(path, base), {
        method,
        localAddress,
        agent: false,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          accept: "application/json",
          [DASHBOARD_IDENTITY_HEADER]: identity,
          ...(body === undefined ? {} : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            response.destroy(new Error("Dashboard response exceeded 1 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          try {
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              headers: { "content-type": "application/json" },
            }));
          } catch (cause) { reject(cause); }
        });
      });
      upstreamRequest.on("error", reject);
      upstreamRequest.end(body);
    });
  };
}
