import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubHandler } from "../server.ts";

const python = process.env.CODEX_LB_PYTHON;
if (!python) throw new Error("Set CODEX_LB_PYTHON to a Python interpreter with codex-lb installed");
const directory = await mkdtemp(join(tmpdir(), "t3-hub-auth-check-"));
await writeFile(join(directory, ".isolated-hub-check"), "fixture\n");
await writeFile(join(directory, ".env"), "");
const processEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("CODEX_LB_") && key !== "FORWARDED_ALLOW_IPS"));
const fixture = Bun.spawn(["uv", "run", "--no-project", "--python", python,
  "python", join(import.meta.dir, "codex-lb-fixture.py")], {
  env: {
    ...processEnv,
    CODEX_LB_ENV_FILE: join(directory, ".env"),
    CODEX_LB_DATA_DIR: directory,
    CODEX_LB_DATABASE_URL: `sqlite+aiosqlite:///${directory}/store.db`,
    CODEX_LB_ENCRYPTION_KEY_FILE: join(directory, "encryption.key"),
    CODEX_LB_DASHBOARD_AUTH_MODE: "trusted_header",
    CODEX_LB_DASHBOARD_AUTH_PROXY_HEADER: "X-T3-Hub-User",
    CODEX_LB_FIREWALL_TRUST_PROXY_HEADERS: "true",
    CODEX_LB_FIREWALL_TRUSTED_PROXY_CIDRS: "127.0.0.2/32",
    FORWARDED_ALLOW_IPS: "",
  }, stdout: "pipe", stderr: "pipe",
});
const stderr = new Response(fixture.stderr).text();
let hub: ReturnType<typeof Bun.serve> | undefined;
try {
  const ready = async () => {
    let output = "";
    for await (const chunk of fixture.stdout) {
      output += new TextDecoder().decode(chunk);
      const match = output.match(/HUB_FIXTURE_READY (\{[^\n]+\})/);
      if (match) return JSON.parse(match[1]!) as { port: number };
    }
    throw new Error(`codex-lb fixture exited before readiness:\n${await stderr}`);
  };
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const { port } = await Promise.race([
    ready(),
    new Promise<never>((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error("codex-lb fixture startup timed out")), 60_000);
    }),
  ]).finally(() => clearTimeout(readyTimer));
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function admin(path: string, body?: unknown, method?: string) {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(payload)}`);
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return payload;
  }
  await admin("/api/dashboard-auth/password/login", { username: "admin", password: "isolated-fixture-password" });
  const roles = await admin("/api/dashboard-roles");
  const operator = roles.find((role: { slug: string }) => role.slug === "operator").id;
  const viewer = roles.find((role: { slug: string }) => role.slug === "viewer").id;
  const providers = await admin("/api/auth-providers");
  const provider = providers.find((item: { kind: string }) => item.kind === "trusted_header");
  await admin(`/api/auth-providers/${provider.id}`, { unknownIdentityRoleId: null, linkByEmail: false }, "PATCH");
  const user = await admin("/api/dashboard-users", {
    username: "t3-hub", roleId: operator, ssoOnly: true,
    expectedIdentity: { provider: "trusted_header", subject: "t3-hub" },
  });
  const apiKey = (await admin("/api/api-keys", { name: "isolated-hub" })).key;
  const restrictedKey = (await admin("/api/api-keys", { name: "isolated-scoped-hub", assignedAccountIds: ["account-a"] })).key;
  hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createHubHandler({
    upstreamBaseUrl: base, upstreamApiKey: apiKey, managementKey: "isolated-key", dashboardIdentity: "t3-hub",
  }) });
  const hubBase = `http://127.0.0.1:${hub.port}`;
  async function credits(account: string, consume = false, key = "isolated-key") {
    const response = await fetch(`${hubBase}/v0/management/api-call`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        auth_index: account, method: consume ? "POST" : "GET",
        url: `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits${consume ? "/consume" : ""}`,
        ...(consume ? { data: JSON.stringify({ redeem_request_id: "isolated-redeem" }) } : {}),
      }), signal: AbortSignal.timeout(10_000),
    });
    return { response, payload: await response.json() };
  }
  assert.equal((await credits("account-a", false, "bad-key")).response.status, 401);
  const listed = await fetch(`${hubBase}/v0/management/auth-files`, { headers: { authorization: "Bearer isolated-key" } });
  assert.equal((await listed.json()).files.length, 2);
  for (const [account, count] of [["account-a", 2], ["account-b", 3]] as const) {
    const result = await credits(account);
    assert.equal(result.payload.status_code, 200);
    assert.equal(JSON.parse(result.payload.body).credits.length, count);
  }
  const reset = await credits("account-a", true);
  assert.equal(reset.payload.status_code, 200);
  assert.equal(JSON.parse(reset.payload.body).code, "reset");
  assert.equal(JSON.parse((await credits("account-a")).payload.body).credits.filter((c: { status: string }) => c.status === "available").length, 1);
  // Ordinary gateway connections and spoofed forwarded peers cannot assert the hub identity.
  for (const extra of [{}, { "X-Forwarded-For": "127.0.0.2" }, { "X-Forwarded-For": "127.0.0.2", "X-Real-IP": "127.0.0.2", Forwarded: "for=127.0.0.2" }]) {
    const denied = await fetch(`${base}/api/accounts/account-b/rate-limit-reset-credits`, {
      headers: { "X-T3-Hub-User": "t3-hub", ...extra }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(denied.status, 401);
  }
  const limited = createHubHandler({ upstreamBaseUrl: base, upstreamApiKey: restrictedKey,
    managementKey: "isolated-key", dashboardIdentity: "t3-hub" });
  const unavailable = await limited(new Request("http://hub.test/v0/management/api-call", {
    method: "POST", headers: { authorization: "Bearer isolated-key" },
    body: JSON.stringify({ auth_index: "account-b", method: "GET", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" }),
  }));
  assert.equal(unavailable.status, 400);
  const unknown = createHubHandler({ upstreamBaseUrl: base, upstreamApiKey: apiKey,
    managementKey: "isolated-key", dashboardIdentity: "unknown-service" });
  const unknownResult = await unknown(new Request("http://hub.test/v0/management/api-call", {
    method: "POST", headers: { authorization: "Bearer isolated-key" },
    body: JSON.stringify({ auth_index: "account-a", method: "GET", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" }),
  }));
  assert.equal((await unknownResult.json()).status_code, 401);
  await admin(`/api/dashboard-users/${user.user.id}`, { roleId: viewer }, "PATCH");
  assert.equal((await credits("account-b")).payload.status_code, 200);
  const forbidden = (await credits("account-b", true)).payload;
  assert.equal(forbidden.status_code, 403);
  assert.equal(JSON.parse(forbidden.body).error.param, "accounts:write");
  await admin(`/api/dashboard-users/${user.user.id}`, { status: "disabled" }, "PATCH");
  assert.equal((await credits("account-b")).payload.status_code, 401);
  assert.equal((await admin("/api/dashboard-auth/session")).authenticated, true);
  console.log("PASS: two-account counts, simulated redemption, key scoping, identity/forwarding spoof rejection, unknown identity rejection, Viewer denial, revocation, and admin password-session fallback");
} finally {
  hub?.stop(true);
  fixture.kill("SIGTERM");
  await fixture.exited;
  const diagnostics = await stderr;
  if (diagnostics.includes("Traceback")) console.error(diagnostics);
  await rm(directory, { recursive: true, force: true });
}
