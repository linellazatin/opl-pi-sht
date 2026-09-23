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
}

export const DEFAULT_MAX_CONTENT_CHARS = 30_000;
export const DEFAULT_MAX_RETRIEVAL_CHARS = 30_000;

/** Resolve configurable content caps, falling back to defaults. */
export function resolveCaps(cfg: Pick<WebAccessConfig, "maxContentChars" | "maxRetrievalChars">) {
  return {
    maxContentChars: cfg.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS,
    maxRetrievalChars: cfg.maxRetrievalChars ?? DEFAULT_MAX_RETRIEVAL_CHARS,
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
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WebAccessConfig;
  } catch {
    console.error(`[opl-webaccess] failed to parse ${CONFIG_PATH}, using defaults`);
    return DEFAULT_CONFIG;
  }
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
