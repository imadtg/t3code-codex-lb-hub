import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { createHubHandler } from "./server.ts";

const accounts = [{ accountId: "account-a", planType: "plus", status: "active" }];
const seen: Array<{ path: string; peer: string | undefined; identity: string | undefined; bearer: string | undefined; body: string }> = [];
let status = 200;
let reply: unknown = null;
const upstream = createServer(async (request: IncomingMessage, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  seen.push({
    path: request.url!, peer: request.socket.remoteAddress,
    identity: request.headers["x-t3-hub-user"] as string | undefined,
    bearer: request.headers.authorization, body: Buffer.concat(chunks).toString(),
  });
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/proxy-management/accounts") {
    response.end(JSON.stringify({ accounts }));
    return;
  }
  if (request.url === "/backend-api/codex/models") {
    response.end(JSON.stringify({ models: [] }));
    return;
  }
  response.statusCode = status;
  response.end(JSON.stringify(reply ?? (request.url?.endsWith("/consume")
    ? { code: "reset", windowsReset: 2 }
    : { credits: [{ id: "credit-a", resetType: "codex_rate_limits", status: "available", expiresAt: "2030-01-01T00:00:00Z" }] })));
});
let baseUrl: string;
beforeAll(async () => {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
afterAll(() => { upstream.closeAllConnections(); upstream.close(); });

function handler(identity: string | undefined = "t3-hub") {
  return createHubHandler({ upstreamBaseUrl: baseUrl, upstreamApiKey: "api-key", managementKey: "hub-key", dashboardIdentity: identity });
}

function request(account = "account-a", consume = false) {
  return new Request("http://hub.test/v0/management/api-call", {
    method: "POST",
    headers: { authorization: "Bearer hub-key", "X-T3-Hub-User": "admin" },
    body: JSON.stringify({
      auth_index: account, method: consume ? "POST" : "GET",
      url: `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits${consume ? "/consume" : ""}`,
      header: { "X-T3-Hub-User": "admin", Cookie: "admin-session" },
      ...(consume ? { data: JSON.stringify({ redeem_request_id: "request-a", credit_id: "credit-a" }) } : {}),
    }),
  });
}

describe("trusted dashboard requests through the hub", () => {
  test("uses a fixed identity and dedicated peer only for reset-credit requests", async () => {
    const run = handler();
    const result = await (await run(request())).json();
    expect(result.status_code).toBe(200);
    expect(JSON.parse(result.body).credits[0].id).toBe("credit-a");
    expect(seen.at(-1)).toMatchObject({ peer: "127.0.0.2", identity: "t3-hub", bearer: undefined });
    expect(seen.at(-2)).toMatchObject({ path: "/api/proxy-management/accounts", peer: "127.0.0.1", identity: undefined, bearer: "Bearer api-key" });
    await run(new Request("http://hub.test/v0/management/auth-files/models", { headers: { authorization: "Bearer hub-key" } }));
    expect(seen.at(-1)).toMatchObject({ path: "/backend-api/codex/models", identity: undefined, bearer: "Bearer api-key" });
  });

  test("redeems through the same identity and preserves the deduplication id", async () => {
    const result = await (await handler()(request("account-a", true))).json();
    expect(JSON.parse(result.body).code).toBe("reset");
    expect(seen.at(-1)).toMatchObject({ peer: "127.0.0.2", identity: "t3-hub", body: JSON.stringify({ redeemRequestId: "request-a" }) });
  });

  test("keeps account-assignment restrictions before elevated requests", async () => {
    const before = seen.filter((r) => r.identity).length;
    expect((await handler()(request("unassigned-account"))).status).toBe(400);
    expect(seen.filter((r) => r.identity).length).toBe(before);
  });

  test("management authentication cannot be replaced by an identity header", async () => {
    const incoming = request();
    incoming.headers.delete("authorization");
    const before = seen.length;
    expect((await handler()(incoming)).status).toBe(401);
    expect(seen.length).toBe(before);
  });

  test("preserves dashboard permission failures instead of reporting an empty list", async () => {
    status = 403;
    reply = { error: { code: "permission_required", message: "Missing permission" } };
    try {
      const result = await (await handler()(request())).json();
      expect(result.status_code).toBe(403);
      expect(JSON.parse(result.body)).toEqual(reply);
    } finally { status = 200; reply = null; }
  });

  test("preserves the previous API-key transport when identity mode is disabled", async () => {
    await handler("")(request());
    expect(seen.at(-1)).toMatchObject({ peer: "127.0.0.1", identity: undefined, bearer: "Bearer api-key" });
  });

  test("rejects unsafe identity destinations and source addresses at configuration time", () => {
    expect(() => createHubHandler({ upstreamBaseUrl: "https://example.test", dashboardIdentity: "t3-hub" })).toThrow("loopback");
    expect(() => createHubHandler({ upstreamBaseUrl: baseUrl, dashboardIdentity: "t3-hub", dashboardLocalAddress: "127.0.0.1" })).toThrow("dedicated");
    expect(() => createHubHandler({ upstreamBaseUrl: baseUrl, dashboardIdentity: "t3-hub\r\nX-Injected: admin" })).toThrow("ASCII");
  });
});
