import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHubHandler } from "./server.ts";

const accounts = [
  {
    accountId: "account-a",
    chatgptAccountId: "chatgpt-a",
    email: "a@example.test",
    displayName: "A",
    planType: "pro",
    status: "active",
    usage: { primaryRemainingPercent: 75, secondaryRemainingPercent: 20, monthlyRemainingPercent: null },
    resetAtPrimary: "2030-01-01T00:00:00Z",
    resetAtSecondary: "2030-01-07T00:00:00Z",
    windowMinutesPrimary: 300,
    windowMinutesSecondary: 10080,
  },
  {
    accountId: "account-free",
    chatgptAccountId: "chatgpt-free",
    email: "free@example.test",
    planType: "free",
    status: "quota_exceeded",
    usage: { primaryRemainingPercent: null, secondaryRemainingPercent: null, monthlyRemainingPercent: 40 },
    resetAtMonthly: "2030-02-01T00:00:00Z",
    windowMinutesMonthly: 43200,
  },
];

let upstream: ReturnType<typeof Bun.serve>;
let upstreamUrl: string;
const seen: Array<{ path: string; body: unknown; authorization: string | null }> = [];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      seen.push({ path: url.pathname, body, authorization: request.headers.get("authorization") });
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/proxy-management/accounts") return Response.json({ accounts });
      if (url.pathname.endsWith("/rate-limit-reset-credits")) {
        return Response.json({
          availableCount: 1,
          credits: [{ id: "credit-1", resetType: "codex_rate_limits", status: "available", expiresAt: "2030-03-01T00:00:00Z" }],
        });
      }
      if (url.pathname.endsWith("/rate-limit-reset-credits/consume")) {
        return Response.json({ code: "reset", windowsReset: 2 });
      }
      if (url.pathname === "/backend-api/codex/models") {
        return Response.json({ models: [{ slug: "gpt-test", display_name: "GPT Test" }] });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => upstream.stop(true));

function call(path: string, init: RequestInit = {}) {
  const handler = createHubHandler({
    upstreamBaseUrl: upstreamUrl,
    upstreamApiKey: "upstream-secret",
    managementKey: "secret",
  });
  return handler(new Request(`http://hub.test${path}`, {
    ...init,
    headers: { authorization: "Bearer secret", ...init.headers },
  }));
}

describe("CLIProxyAPI compatibility", () => {
  test("requires a management key", async () => {
    const handler = createHubHandler({ upstreamBaseUrl: upstreamUrl, managementKey: "secret" });
    expect((await handler(new Request("http://hub.test/v0/management/auth-files"))).status).toBe(401);
  });

  test("lists and filters synthetic auth files", async () => {
    const response = await call("/v0/management/auth-files?auth_index=account-a");
    const payload = await response.json();
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      id: "account-a",
      auth_index: "account-a",
      provider: "codex",
      email: "a@example.test",
      disabled: false,
      id_token: { chatgpt_account_id: "chatgpt-a", chatgpt_plan_type: "pro" },
    });
  });

  test("maps primary and secondary usage windows", async () => {
    const response = await call("/v0/management/api-call", {
      method: "POST",
      body: JSON.stringify({ auth_index: "account-a", method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" }),
    });
    const outer = await response.json();
    const body = JSON.parse(outer.body);
    expect(body.plan_type).toBe("pro");
    expect(body.rate_limit.primary_window).toMatchObject({ used_percent: 25, limit_window_seconds: 18000 });
    expect(body.rate_limit.secondary_window).toMatchObject({ used_percent: 80, limit_window_seconds: 604800 });
  });

  test("reconstructs a monthly-only Free quota in the upstream primary slot", async () => {
    const response = await call("/v0/management/api-call", {
      method: "POST",
      body: JSON.stringify({ authIndex: "account-free", method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" }),
    });
    const body = JSON.parse((await response.json()).body);
    expect(body.rate_limit.primary_window).toMatchObject({ used_percent: 60, limit_window_seconds: 2592000 });
    expect(body.rate_limit.secondary_window).toBeNull();
  });

  test("lists and consumes reset credits", async () => {
    const listed = await call("/v0/management/api-call", {
      method: "POST",
      body: JSON.stringify({ auth_index: "account-a", method: "GET", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" }),
    });
    expect(JSON.parse((await listed.json()).body).credits[0]).toMatchObject({
      id: "credit-1",
      reset_type: "codex_rate_limits",
      expires_at: "2030-03-01T00:00:00Z",
    });

    const consumed = await call("/v0/management/api-call", {
      method: "POST",
      body: JSON.stringify({
        auth_index: "account-a",
        method: "POST",
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        data: JSON.stringify({ redeem_request_id: "request-1", credit_id: "credit-1" }),
      }),
    });
    expect(JSON.parse((await consumed.json()).body).code).toBe("reset");
    expect(seen.at(-1)).toEqual({
      path: "/api/accounts/account-a/rate-limit-reset-credits/consume",
      body: { redeemRequestId: "request-1" },
      authorization: "Bearer upstream-secret",
    });
  });

  test("authenticates every codex-lb request with the upstream API key", async () => {
    await call("/v0/management/auth-files");
    expect(seen.at(-1)?.authorization).toBe("Bearer upstream-secret");
  });

  test("supports models, refresh, reset-quota, and X-Management-Key", async () => {
    const handler = createHubHandler({ upstreamBaseUrl: upstreamUrl, managementKey: "secret" });
    const models = await handler(new Request("http://hub.test/v0/management/auth-files/models?name=anything", {
      headers: { "x-management-key": "secret" },
    }));
    expect((await models.json()).models[0]).toEqual({ id: "gpt-test", display_name: "GPT Test", type: "model", owned_by: "openai" });
    expect((await call("/v0/management/auth-files/refresh", { method: "POST" })).status).toBe(200);
    expect((await call("/v0/management/reset-quota", { method: "POST", body: JSON.stringify({ auth_index: "account-a" }) })).status).toBe(200);
  });
});
