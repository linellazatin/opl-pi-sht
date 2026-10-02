import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 15_000;

export interface OpenRouterUsageSnapshot {
  used: number;
  limit: number;
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

export function parseOpenRouterUsage(data: unknown, fetchedAt = Date.now()): OpenRouterUsageSnapshot | null {
  const root = asRecord(data);
  const key = asRecord(root?.data);
  const limit = key?.limit;
  const remaining = key?.limit_remaining;
  if (
    typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 ||
    typeof remaining !== "number" || !Number.isFinite(remaining)
  ) return null;

  return {
    used: Math.max(0, Math.round((limit - remaining) * 1_000_000_000) / 1_000_000_000),
    limit,
    fetchedAt,
    stale: false,
  };
}

export async function refreshOpenRouterUsageSnapshot(
  previous: OpenRouterUsageSnapshot | null,
  load: () => Promise<OpenRouterUsageSnapshot>,
): Promise<OpenRouterUsageSnapshot | null> {
  try {
    return await load();
  } catch {
    return previous ? { ...previous, stale: true } : null;
  }
}

export async function fetchOpenRouterUsage(
  ctx: ExtensionContext,
  fetchFn: FetchLike = globalThis.fetch,
  fetchedAt = Date.now(),
): Promise<OpenRouterUsageSnapshot> {
  const model = ctx.model;
  if (!model || model.provider !== "openrouter") {
    throw new Error("OpenRouter usage requires an openrouter model");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("OpenRouter authentication is unavailable");

  const response = await fetchFn(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
      Accept: "application/json",
      "User-Agent": "opl-footer-openrouter-usage",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenRouter usage request failed (${response.status})`);

  const snapshot = parseOpenRouterUsage(await response.json(), fetchedAt);
  if (!snapshot) throw new Error("OpenRouter usage response contained no usable key limit");
  return snapshot;
}
