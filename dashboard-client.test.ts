import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { createDashboardClient } from "./dashboard-client.ts";

const path = "/api/accounts/account-a/rate-limit-reset-credits";

async function withUpstream(listener: RequestListener, check: (baseUrl: string) => Promise<void>) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await check(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function client(baseUrl: string, timeoutMs = 1_000) {
  return createDashboardClient({ baseUrl, identity: "t3-hub", timeoutMs });
}

test("dashboard transport rejects arbitrary paths and methods before connecting", () => {
  const run = client("http://127.0.0.1:1");
  for (const destination of ["/api/dashboard-users", "/api/accounts/../rate-limit-reset-credits", "/api/accounts/a?b/rate-limit-reset-credits"]) {
    expect(() => run(destination)).toThrow("path");
  }
  expect(() => run(path, { method: "DELETE" })).toThrow("method");
  expect(() => run(path, { method: "POST" })).toThrow("method");
  expect(() => run(`${path}/consume`)).toThrow("method");
});

test("dashboard transport returns redirects without sending identity to their destination", async () => {
  let redirectedRequests = 0;
  await withUpstream((_, response) => { redirectedRequests++; response.end("{}"); }, async (destination) => {
    await withUpstream((_, response) => {
      response.writeHead(302, { location: `${destination}${path}` });
      response.end();
    }, async (base) => {
      expect((await client(base)(path)).status).toBe(302);
      expect(redirectedRequests).toBe(0);
    });
  });
});

test("dashboard transport times out when upstream sends no response", async () => {
  await withUpstream(() => {}, async (base) => {
    await expect(client(base, 50)(path)).rejects.toThrow();
  });
});

test("dashboard transport times out when upstream stalls its response body", async () => {
  await withUpstream((_, response) => {
    response.writeHead(200);
    response.write("{");
  }, async (base) => {
    await expect(client(base, 50)(path)).rejects.toThrow();
  });
});

test("dashboard transport rejects oversized and truncated responses", async () => {
  await withUpstream((_, response) => response.end(Buffer.alloc(1024 * 1024 + 1)), async (base) => {
    await expect(client(base)(path)).rejects.toThrow("exceeded");
  });
  await withUpstream((_, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.end("{}");
  }, async (base) => {
    await expect(client(base)(path)).rejects.toThrow();
  });
});
