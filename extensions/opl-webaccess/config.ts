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
  /** Allow fetch_content to reach private/link-local ranges (loopback is always
   *  allowed; cloud metadata is always blocked). Default false. */
  allowPrivateNetwork?: boolean;
}

export const DEFAULT_MAX_CONTENT_CHARS = 30_000;
export const DEFAULT_MAX_RETRIEVAL_CHARS = 30_000;

/** Coerce an unknown value into a positive integer, else the fallback. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve configurable content caps, falling back to defaults when a cap is
 *  missing or not a positive finite number (a string/negative/zero cap would
 *  otherwise make truncate/slice produce empty or inverted output). */
export function resolveCaps(cfg: Pick<WebAccessConfig, "maxContentChars" | "maxRetrievalChars">) {
  return {
    maxContentChars: positiveInt(cfg.maxContentChars, DEFAULT_MAX_CONTENT_CHARS),
    maxRetrievalChars: positiveInt(cfg.maxRetrievalChars, DEFAULT_MAX_RETRIEVAL_CHARS),
  };
}

const CONFIG_PATH = join(getAgentDir(), "configs", "opl-webaccess.json");

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

export function loadConfig(): WebAccessConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    console.error(`[opl-webaccess] failed to parse ${CONFIG_PATH}, using defaults`);
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
    allowPrivateNetwork: record.allowPrivateNetwork === true,
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
