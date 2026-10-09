import { loadConfig, getApiKey, resolveTimeoutMs, type WebAccessConfig } from "./config.js";
import { searchGemini } from "./providers/gemini.js";
import { searchTavily } from "./providers/tavily.js";
import { searchDdgs } from "./providers/ddgs.js";
import { searchSearxng } from "./providers/searxng.js";
import { searchExa } from "./providers/exa.js";
import type { SearchQueryResult } from "./types.js";

/**
 * Run one search with the configured provider.
 *
 * `config` is passed in by callers that fan out over queries, so a multi-query
 * call reads and parses the config file once instead of once per query. Every
 * provider request gets a deadline: the agent signal alone can stay pending
 * forever if a provider accepts the connection and never answers.
 */
export async function searchWeb(
  query: string,
  signal?: AbortSignal,
  config: WebAccessConfig = loadConfig(),
): Promise<SearchQueryResult> {
  const providerName = config.provider;
  const providerCfg = config.providers?.[providerName] ?? {};
  const timeoutMs = resolveTimeoutMs(config);
  const deadline = AbortSignal.timeout(timeoutMs);
  const tied = signal ? AbortSignal.any([signal, deadline]) : deadline;

  switch (providerName) {
    case "gemini":
      return searchGemini(query, providerCfg, getApiKey(providerCfg), tied);
    case "tavily":
      return searchTavily(query, providerCfg, getApiKey(providerCfg), tied);
    case "ddgs":
      return searchDdgs(query, providerCfg, tied);
    case "searxng":
      return searchSearxng(query, providerCfg, tied);
    case "exa":
      return searchExa(query, providerCfg, getApiKey(providerCfg), tied);
    default:
      return {
        query,
        answer: "",
        results: [],
        error: `Unknown search provider: "${providerName}". Valid options: gemini, tavily, ddgs, searxng, exa`,
      };
  }
}
