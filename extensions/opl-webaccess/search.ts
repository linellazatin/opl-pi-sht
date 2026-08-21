import { loadConfig, getApiKey } from "./config.js";
import { searchGemini } from "./providers/gemini.js";
import { searchTavily } from "./providers/tavily.js";
import { searchDdgs } from "./providers/ddgs.js";
import { searchSearxng } from "./providers/searxng.js";
import { searchExa } from "./providers/exa.js";
import type { SearchQueryResult } from "./types.js";

export async function searchWeb(
  query: string,
  signal?: AbortSignal
): Promise<SearchQueryResult> {
  const config = loadConfig();
  const providerName = config.provider;
  const providerCfg = config.providers?.[providerName] ?? {};

  switch (providerName) {
    case "gemini":
      return searchGemini(query, providerCfg, getApiKey(providerCfg), signal);
    case "tavily":
      return searchTavily(query, providerCfg, getApiKey(providerCfg), signal);
    case "ddgs":
      return searchDdgs(query, providerCfg, signal);
    case "searxng":
      return searchSearxng(query, providerCfg, signal);
    case "exa":
      return searchExa(query, providerCfg, getApiKey(providerCfg), signal);
    default:
      return {
        query,
        answer: "",
        results: [],
        error: `Unknown search provider: "${providerName}". Valid options: gemini, tavily, ddgs, searxng, exa`,
      };
  }
}
