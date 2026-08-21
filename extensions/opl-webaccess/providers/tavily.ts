import { errorMessage, isAbortError } from "../utils.js";
import type { ProviderConfig } from "../config.js";
import type { SearchQueryResult, SearchResult } from "../types.js";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
  error?: string;
}

export async function searchTavily(
  query: string,
  cfg: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal
): Promise<SearchQueryResult> {
  let response: Response;
  try {
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: cfg.maxResults ?? 5,
        include_answer: true,
      }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return { query, answer: "", results: [], error: "Aborted" };
    return { query, answer: "", results: [], error: errorMessage(err) };
  }

  const data = (await response.json()) as TavilyResponse;

  if (!response.ok) {
    return { query, answer: "", results: [], error: `Tavily API error: HTTP ${response.status}` };
  }

  if (data.error) {
    return { query, answer: "", results: [], error: `Tavily API error: ${data.error}` };
  }

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
  }));

  const answer = data.answer ?? results.map((r) => r.title).join(". ");

  return { query, answer, results, error: null };
}
