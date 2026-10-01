import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_TOLERANCE_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 15_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexUsageWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAt?: number;
}

export interface CodexUsageSnapshot {
  fiveHour?: CodexUsageWindow;
  weekly?: CodexUsageWindow;
  fetchedAt: number;
  stale: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type UsageRecord = Record<string, unknown>;

function asRecord(value: unknown): UsageRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UsageRecord
    : null;
}

function normalizeWindow(value: unknown): CodexUsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;

  const usedPercent = record.used_percent;
  const windowSeconds = record.limit_window_seconds;
  const resetAt = record.reset_at;
  if (
    typeof usedPercent !== "number" || !Number.isFinite(usedPercent) ||
    typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0
  ) return null;

  return {
    usedPercent,
    windowSeconds,
    ...(typeof resetAt === "number" && Number.isFinite(resetAt) ? { resetAt } : {}),
  };
}

function matchesWindow(window: CodexUsageWindow, seconds: number): boolean {
  return Math.abs(window.windowSeconds - seconds) <= WINDOW_TOLERANCE_SECONDS;
}

export function parseCodexUsage(data: unknown, fetchedAt = Date.now()): CodexUsageSnapshot | null {
  const root = asRecord(data);
  const rateLimit = asRecord(root?.rate_limit);
  const windows = [
    normalizeWindow(rateLimit?.primary_window),
    normalizeWindow(rateLimit?.secondary_window),
  ].filter((window): window is CodexUsageWindow => window !== null);

  const fiveHour = windows.find((window) => matchesWindow(window, FIVE_HOURS_SECONDS));
  const weekly = windows.find((window) => matchesWindow(window, WEEK_SECONDS));
  if (!fiveHour && !weekly) return null;

  return { fiveHour, weekly, fetchedAt, stale: false };
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims = asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const auth = asRecord(claims?.[OPENAI_AUTH_CLAIM]);
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexUsage(
  ctx: ExtensionContext,
  fetchFn: FetchLike = globalThis.fetch,
  fetchedAt = Date.now(),
): Promise<CodexUsageSnapshot> {
  const model = ctx.model;
  if (!model || model.provider !== "openai-codex" || !ctx.modelRegistry.isUsingOAuth(model)) {
    throw new Error("Codex usage requires an openai-codex OAuth subscription model");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("OpenAI Codex OAuth authentication is unavailable");

  const accountId = accountIdFromToken(auth.apiKey);
  const response = await fetchFn(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
      Accept: "application/json",
      "User-Agent": "opl-footer-codex-usage",
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);

  const snapshot = parseCodexUsage(await response.json(), fetchedAt);
  if (!snapshot) throw new Error("Codex usage response contained no supported windows");
  return snapshot;
}

export async function refreshCodexUsageSnapshot(
  previous: CodexUsageSnapshot | null,
  load: () => Promise<CodexUsageSnapshot>,
): Promise<CodexUsageSnapshot | null> {
  try {
    return await load();
  } catch {
    return previous ? { ...previous, stale: true } : null;
  }
}
