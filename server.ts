#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createDashboardClient } from "./dashboard-client.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type CodexLbWindow = {
  primaryRemainingPercent?: number | null;
  secondaryRemainingPercent?: number | null;
  monthlyRemainingPercent?: number | null;
};

type CodexLbAccount = {
  accountId: string;
  chatgptAccountId?: string | null;
  email?: string | null;
  displayName?: string | null;
  planType?: string | null;
  status?: string | null;
  usage?: CodexLbWindow | null;
  resetAtPrimary?: string | null;
  resetAtSecondary?: string | null;
  resetAtMonthly?: string | null;
  windowMinutesPrimary?: number | null;
  windowMinutesSecondary?: number | null;
  windowMinutesMonthly?: number | null;
  lastRefreshAt?: string | null;
};

type AccountsResponse = { accounts: CodexLbAccount[] };

type ApiCallRequest = {
  auth_index?: string;
  authIndex?: string;
  AuthIndex?: string;
  method?: string;
  url?: string;
  header?: Record<string, string>;
  data?: string;
};

type HubOptions = {
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  dashboardIdentity?: string;
  dashboardLocalAddress?: string;
  managementKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DISABLED_STATUSES = new Set(["paused", "reauth_required", "deactivated"]);
const CODEX_USAGE_PATH = "/backend-api/wham/usage";
const CREDIT_LIST_PATH = "/backend-api/wham/rate-limit-reset-credits";
const CREDIT_CONSUME_PATH = `${CREDIT_LIST_PATH}/consume`;

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

function managementToken(request: Request): string {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-management-key")?.trim() ?? "";
}

function parseJsonBody<T>(request: Request): Promise<T | null> {
  return request.json().then((value) => value as T).catch(() => null);
}

function upstreamPath(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname.replace(/^\/codex/, "");
  } catch {
    return null;
  }
}

function epochSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function usageWindow(
  remaining: number | null | undefined,
  resetAt: string | null | undefined,
  windowMinutes: number | null | undefined,
): Json {
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, 100 - remaining)),
    reset_at: epochSeconds(resetAt),
    ...(typeof windowMinutes === "number" && Number.isFinite(windowMinutes)
      ? { limit_window_seconds: windowMinutes * 60 }
      : {}),
  };
}

function toUsage(account: CodexLbAccount): Json {
  const usage = account.usage ?? {};
  const primary = usageWindow(
    usage.primaryRemainingPercent,
    account.resetAtPrimary,
    account.windowMinutesPrimary,
  ) ?? usageWindow(
    usage.monthlyRemainingPercent,
    account.resetAtMonthly,
    account.windowMinutesMonthly,
  );
  const secondary = usageWindow(
    usage.secondaryRemainingPercent,
    account.resetAtSecondary,
    account.windowMinutesSecondary,
  );
  return {
    plan_type: account.planType ?? undefined,
    rate_limit: primary === null && secondary === null
      ? null
      : { primary_window: primary, secondary_window: secondary },
  };
}

function toAuthFile(account: CodexLbAccount): Json {
  const status = account.status ?? "unknown";
  const disabled = DISABLED_STATUSES.has(status);
  return {
    id: account.accountId,
    auth_index: account.accountId,
    name: `codex-lb-${account.accountId}.json`,
    type: "codex",
    provider: "codex",
    label: account.displayName ?? account.email ?? account.accountId,
    email: account.email ?? undefined,
    status,
    status_message: "",
    disabled,
    unavailable: disabled || status === "quota_exceeded",
    runtime_only: true,
    source: "memory",
    size: 0,
    last_refresh: account.lastRefreshAt ?? undefined,
    id_token: {
      chatgpt_account_id: account.chatgptAccountId ?? account.accountId,
      chatgpt_plan_type: account.planType ?? undefined,
    },
  };
}

function normalizeCreditSnapshot(snapshot: unknown): Json {
  if (!snapshot || typeof snapshot !== "object") return { credits: [] };
  const raw = snapshot as Record<string, unknown>;
  const credits = Array.isArray(raw.credits) ? raw.credits : [];
  return {
    credits: credits.map((credit) => {
      const item = credit as Record<string, unknown>;
      return {
        id: String(item.id ?? ""),
        reset_type: String(item.resetType ?? item.reset_type ?? "codex_rate_limits"),
        status: String(item.status ?? "available"),
        expires_at: String(item.expiresAt ?? item.expires_at ?? ""),
        ...(item.grantedAt || item.granted_at
          ? { granted_at: String(item.grantedAt ?? item.granted_at) }
          : {}),
      };
    }),
  };
}

export function createHubHandler(options: HubOptions = {}): (request: Request) => Promise<Response> {
  const upstreamBaseUrl = (options.upstreamBaseUrl ?? "http://127.0.0.1:2455").replace(/\/$/, "");
  const upstreamApiKey = options.upstreamApiKey?.trim() ?? "";
  const expectedKey = options.managementKey ?? "";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let accountCache: { expiresAt: number; value: AccountsResponse } | null = null;
  let accountRequest: Promise<AccountsResponse> | null = null;

  const upstream = async (path: string, init?: RequestInit): Promise<Response> =>
    fetchImpl(`${upstreamBaseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        ...(upstreamApiKey ? { authorization: `Bearer ${upstreamApiKey}` } : {}),
        ...init?.headers,
      },
    });

  const dashboard = options.dashboardIdentity
    ? createDashboardClient({
      baseUrl: upstreamBaseUrl,
      identity: options.dashboardIdentity,
      localAddress: options.dashboardLocalAddress,
      timeoutMs,
    })
    : upstream;

  const accounts = async (fresh = false): Promise<AccountsResponse> => {
    if (!fresh && accountCache && accountCache.expiresAt > Date.now()) return accountCache.value;
    if (!fresh && accountRequest) return accountRequest;
    const pending = (async () => {
      const response = await upstream("/api/proxy-management/accounts");
      if (!response.ok) throw new Error(`codex-lb accounts returned HTTP ${response.status}`);
      const value = (await response.json()) as AccountsResponse;
      if (!Array.isArray(value.accounts)) throw new Error("codex-lb returned an invalid accounts response");
      accountCache = { expiresAt: Date.now() + 1_000, value };
      return value;
    })();
    accountRequest = pending;
    try {
      return await pending;
    } finally {
      if (accountRequest === pending) accountRequest = null;
    }
  };

  const findAccount = async (authIndex: string): Promise<CodexLbAccount | null> =>
    (await accounts()).accounts.find((account) => account.accountId === authIndex) ?? null;

  const apiCall = async (body: ApiCallRequest): Promise<Response> => {
    const authIndex = (body.auth_index ?? body.authIndex ?? body.AuthIndex ?? "").trim();
    const method = (body.method ?? "").trim().toUpperCase();
    const path = body.url ? upstreamPath(body.url) : null;
    if (!method) return error("missing method", 400);
    if (!path) return error("invalid url", 400);
    if (!authIndex) return error("auth token not found", 400);
    const account = await findAccount(authIndex);
    if (!account) return error("auth token not found", 400);

    if (method === "GET" && path === CODEX_USAGE_PATH) {
      return json({ status_code: 200, header: {}, body: JSON.stringify(toUsage(account)) });
    }

    if (method === "GET" && path === CREDIT_LIST_PATH) {
      const response = await dashboard(
        `/api/accounts/${encodeURIComponent(account.accountId)}/rate-limit-reset-credits`,
      );
      const rawBody = await response.text();
      const body = response.ok
        ? JSON.stringify(normalizeCreditSnapshot(rawBody ? JSON.parse(rawBody) : null))
        : rawBody;
      return json({ status_code: response.status, header: {}, body });
    }

    if (method === "POST" && path === CREDIT_CONSUME_PATH) {
      const data = body.data ? JSON.parse(body.data) as Record<string, unknown> : {};
      const response = await dashboard(
        `/api/accounts/${encodeURIComponent(account.accountId)}/rate-limit-reset-credits/consume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redeemRequestId: data.redeem_request_id }),
        },
      );
      const rawBody = await response.text();
      accountCache = null;
      return json({ status_code: response.status, header: {}, body: rawBody });
    }

    return json({
      status_code: 501,
      header: {},
      body: JSON.stringify({ error: "This CLIProxyAPI api-call target is not available through codex-lb." }),
    });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      try {
        const response = await upstream("/health");
        return json({ status: response.ok ? "ok" : "degraded", upstream_status: response.status }, response.ok ? 200 : 503);
      } catch {
        return json({ status: "degraded", upstream_status: null }, 503);
      }
    }
    if (url.pathname === "/") {
      return json({ service: "t3code-codex-lb-hub", compatibility: "CLIProxyAPI management API" });
    }
    if (!url.pathname.startsWith("/v0/management/")) return error("not found", 404);
    if (!expectedKey || managementToken(request) !== expectedKey) return error("unauthorized", 401);

    try {
      if (request.method === "GET" && url.pathname === "/v0/management/auth-files") {
        const name = url.searchParams.get("name")?.trim();
        const authIndex = url.searchParams.get("auth_index")?.trim();
        const files = (await accounts()).accounts
          .map(toAuthFile)
          .filter((file) => {
            const item = file as Record<string, Json>;
            return (!name || item.name === name || item.id === name) &&
              (!authIndex || item.auth_index === authIndex);
          });
        return json({ observed_at: new Date().toISOString(), files });
      }

      if (request.method === "GET" && url.pathname === "/v0/management/auth-files/models") {
        const response = await upstream("/backend-api/codex/models");
        const payload = response.ok ? await response.json() as Record<string, unknown> : {};
        const source = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
        const models = source.map((raw) => {
          const model = raw as Record<string, unknown>;
          return {
            id: String(model.slug ?? model.id ?? ""),
            ...(model.display_name || model.displayName
              ? { display_name: String(model.display_name ?? model.displayName) }
              : {}),
            type: "model",
            owned_by: "openai",
          };
        }).filter((model) => model.id);
        return json({ models });
      }

      if (request.method === "POST" && url.pathname === "/v0/management/auth-files/refresh") {
        accountCache = null;
        const value = await accounts(true);
        return json({ status: "ok", refreshed: value.accounts.length });
      }

      if (request.method === "POST" && url.pathname === "/v0/management/api-call") {
        const body = await parseJsonBody<ApiCallRequest>(request);
        return body ? await apiCall(body) : error("invalid body", 400);
      }

      if (request.method === "POST" && url.pathname === "/v0/management/reset-quota") {
        const body = await parseJsonBody<{ auth_index?: string }>(request);
        const authIndex = body?.auth_index?.trim() ?? "";
        if (!authIndex) return error("auth_index is required", 400);
        if (!await findAccount(authIndex)) return error("auth not found", 404);
        accountCache = null;
        return json({ status: "ok", auth_index: authIndex, models: [] });
      }

      return error("not found", 404);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "unknown upstream error";
      console.error(`[t3code-codex-lb-hub] ${request.method} ${url.pathname}: ${message}`);
      return error("codex-lb request failed", 502);
    }
  };
}

async function readManagementKeyFile(path: string): Promise<string> {
  const key = (await readFile(path, "utf8")).trim();
  if (!key) throw new Error(`management key file is empty: ${path}`);
  return key;
}

export async function resolveManagementKey(environmentKey: string | undefined, path: string): Promise<string> {
  const configured = environmentKey?.trim();
  if (configured) return configured;
  if (!path) throw new Error("set T3_CLB_HUB_MANAGEMENT_KEY or T3_CLB_HUB_MANAGEMENT_KEY_FILE");

  try {
    return await readManagementKeyFile(path);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64url");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${generated}\n`, "utf8");
    } finally {
      await file.close();
    }
    console.log(`[t3code-codex-lb-hub] generated management key at ${path}`);
    return generated;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      return await readManagementKeyFile(path);
    }
    throw cause;
  }
}

if (import.meta.main) {
  const hostname = process.env.T3_CLB_HUB_HOST ?? "127.0.0.1";
  const port = Number(process.env.T3_CLB_HUB_PORT ?? "8317");
  const upstreamBaseUrl = process.env.T3_CLB_HUB_UPSTREAM ?? "http://127.0.0.1:2455";
  const configuredUpstreamApiKeyFile = process.env.T3_CLB_HUB_UPSTREAM_API_KEY_FILE?.trim();
  const defaultUpstreamApiKeyFile = process.env.HOME
    ? `${process.env.HOME}/.config/codex-lb/client-api-key`
    : "";
  const upstreamApiKeyFile = configuredUpstreamApiKeyFile || defaultUpstreamApiKeyFile;
  const upstreamApiKey = process.env.T3_CLB_HUB_UPSTREAM_API_KEY?.trim() ||
    (upstreamApiKeyFile && await Bun.file(upstreamApiKeyFile).exists()
      ? (await Bun.file(upstreamApiKeyFile).text()).trim()
      : "");
  const configuredKeyFile = process.env.T3_CLB_HUB_MANAGEMENT_KEY_FILE?.trim();
  const defaultKeyFile = process.env.HOME
    ? `${process.env.HOME}/.config/t3code-codex-lb-hub/management-key`
    : "";
  const managementKeyFile = configuredKeyFile || defaultKeyFile;
  const managementKey = await resolveManagementKey(process.env.T3_CLB_HUB_MANAGEMENT_KEY, managementKeyFile);
  const dashboardIdentity = process.env.T3_CLB_HUB_DASHBOARD_IDENTITY?.trim();
  const dashboardLocalAddress = process.env.T3_CLB_HUB_DASHBOARD_LOCAL_ADDRESS?.trim();
  Bun.serve({ hostname, port, fetch: createHubHandler({
    upstreamBaseUrl, upstreamApiKey, managementKey, dashboardIdentity, dashboardLocalAddress,
  }) });
  console.log(`[t3code-codex-lb-hub] listening on http://${hostname}:${port}, upstream ${upstreamBaseUrl}`);
}
