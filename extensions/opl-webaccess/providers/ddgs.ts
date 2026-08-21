import { isAbortError } from "../utils.js";
import type { ProviderConfig } from "../config.js";
import type { SearchQueryResult, SearchResult } from "../types.js";

interface DdgsSearchResult {
  title: string;
  href: string;
  body: string;
}

interface DdgsApiResponse {
  results: DdgsSearchResult[];
}

export async function searchDdgs(
  query: string,
  cfg: ProviderConfig,
  signal?: AbortSignal
): Promise<SearchQueryResult> {
  if (signal?.aborted) return { query, answer: "", results: [], error: "Aborted" };

  const apiUrl = (cfg.apiUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const maxResults = cfg.maxResults ?? 5;

  const params = new URLSearchParams({
    query,
    max_results: String(maxResults),
  });

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/search/text?${params.toString()}`, { signal });
  } catch (err) {
    if (isAbortError(err)) return { query, answer: "", results: [], error: "Aborted" };
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
      return {
        query,
        answer: "",
        results: [],
        error: `DDGS API server not reachable at ${apiUrl}. Check that the container is running.`,
      };
    }
    return { query, answer: "", results: [], error: `DDGS API error: ${msg}` };
  }

  if (!response.ok) {
    return { query, answer: "", results: [], error: `DDGS API error: HTTP ${response.status}` };
  }

  let data: DdgsApiResponse;
  try {
    data = (await response.json()) as DdgsApiResponse;
  } catch {
    return { query, answer: "", results: [], error: "DDGS: failed to parse JSON response" };
  }

  const raw = data.results ?? [];

  const results: SearchResult[] = raw.map((r) => ({
    title: r.title,
    url: r.href,
  }));

  const answer = raw
    .slice(0, 3)
    .map((r) => r.body)
    .filter(Boolean)
    .join(" ");

  return { query, answer, results, error: null };
}
