import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ProviderConfig {
  apiKeyEnv?: string;
  apiUrl?: string;
  baseUrl?: string;
  model?: string;
  maxResults?: number;
  instanceUrl?: string;
  categories?: string;
  safeSearch?: number;
  searchType?: string;
  includeSummary?: boolean;
}

export interface WebAccessConfig {
  provider: string;
  providers: Record<string, ProviderConfig>;
  /** Cap on the initial web_search/fetch_content body (chars). */
  maxContentChars?: number;
  /** Cap on one get_search_content retrieval page (chars). */
  maxRetrievalChars?: number;
  /** Cap on the number of queries a single web_search call may run. */
  maxSearchQueries?: number;
  /** Cap on the number of URLs a single fetch_content call may fetch. */
  maxFetchUrls?: number;
  /** Allow fetch_content to reach private/link-local ranges (default false). Cloud
   *  metadata is always blocked. */
  allowPrivateNetwork?: boolean;
  /** Allow fetch_content to reach loopback hosts — localhost, 127.0.0.0/8, ::1
   *  (default false: opt in). Cloud metadata is unaffected. */
  allowLoopback?: boolean;
  /** Deadline applied to one provider search request or one fetched URL (ms,
   *  default 30000). The agent's own abort signal is combined with it, so the
   *  shorter of the two wins. */
  timeoutMs?: number;
}

export const DEFAULT_MAX_CONTENT_CHARS = 30_000;
export const DEFAULT_MAX_RETRIEVAL_CHARS = 30_000;
export const DEFAULT_MAX_SEARCH_QUERIES = 10;
export const DEFAULT_MAX_FETCH_URLS = 20;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Coerce an unknown value into a positive integer, else the fallback. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve configurable caps, falling back to defaults when a cap is missing or not
 *  a positive finite number (a string/negative/zero cap would otherwise make
 *  truncate/slice produce empty, inverted, or unbounded output). */
export function resolveCaps(
  cfg: Pick<WebAccessConfig, "maxContentChars" | "maxRetrievalChars" | "maxSearchQueries" | "maxFetchUrls">,
) {
  return {
    maxContentChars: positiveInt(cfg.maxContentChars, DEFAULT_MAX_CONTENT_CHARS),
    maxRetrievalChars: positiveInt(cfg.maxRetrievalChars, DEFAULT_MAX_RETRIEVAL_CHARS),
    maxSearchQueries: positiveInt(cfg.maxSearchQueries, DEFAULT_MAX_SEARCH_QUERIES),
    maxFetchUrls: positiveInt(cfg.maxFetchUrls, DEFAULT_MAX_FETCH_URLS),
  };
}

/** Per-request deadline for provider calls and URL fetches (ms). */
export function resolveTimeoutMs(cfg: Pick<WebAccessConfig, "timeoutMs">): number {
  return positiveInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
}

/** Resolved per call so a custom `PI_CODING_AGENT_DIR` (pi's own agent dir) is honoured. */
export function configPath(): string {
  return join(getAgentDir(), "configs", "opl-webaccess.json");
}

const DEFAULT_CONFIG: WebAccessConfig = {
  provider: "gemini",
  providers: {
    gemini: {
      apiKeyEnv: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-lite",
    },
  },
};

export function loadConfig(file = configPath()): WebAccessConfig {
  if (!existsSync(file)) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    console.error(`[opl-webaccess] failed to parse ${file}, using defaults`);
    return DEFAULT_CONFIG;
  }
  return normalizeConfig(parsed);
}

/** Validate a parsed config so malformed fields fall back to defaults instead of
 *  silently misbehaving downstream (a non-object config, a non-string provider, or
 *  a non-object providers map are all treated as unset). Cap values are validated
 *  in resolveCaps. */
function normalizeConfig(parsed: unknown): WebAccessConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[opl-webaccess] config is not a JSON object, using defaults");
    return DEFAULT_CONFIG;
  }
  const record = parsed as Record<string, unknown>;
  const provider =
    typeof record.provider === "string" && record.provider.trim() !== ""
      ? record.provider
      : DEFAULT_CONFIG.provider;
  const providers =
    typeof record.providers === "object" && record.providers !== null && !Array.isArray(record.providers)
      ? (record.providers as Record<string, ProviderConfig>)
      : DEFAULT_CONFIG.providers;
  return {
    provider,
    providers,
    maxContentChars: record.maxContentChars as number | undefined,
    maxRetrievalChars: record.maxRetrievalChars as number | undefined,
    maxSearchQueries: record.maxSearchQueries as number | undefined,
    maxFetchUrls: record.maxFetchUrls as number | undefined,
    allowPrivateNetwork: record.allowPrivateNetwork === true,
    allowLoopback: record.allowLoopback === true,
    timeoutMs: record.timeoutMs as number | undefined,
  };
}

export function getApiKey(cfg: ProviderConfig): string {
  if (!cfg.apiKeyEnv) return "";
  const key = process.env[cfg.apiKeyEnv]?.trim();
  if (!key) {
    throw new Error(
      `${cfg.apiKeyEnv} is not set. Add it to your shell profile:\n\n  export ${cfg.apiKeyEnv}="your-key-here"\n\nNote: avoid running commands that print the full environment (like env, set, printenv) when a model is watching — keys in the shell environment are visible to the bash tool.`
    );
  }
  return key;
}
