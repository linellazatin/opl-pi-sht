import { errorMessage, isAbortError } from "../utils.js";
import type { ProviderConfig } from "../config.js";
import type { SearchQueryResult, SearchResult } from "../types.js";

interface SearxngResult {
  title: string;
  url: string;
  content?: string;
}

interface SearxngResponse {
  results: SearxngResult[];
  error?: string;
}

export async function searchSearxng(
  query: string,
  cfg: ProviderConfig,
  signal?: AbortSignal
): Promise<SearchQueryResult> {
  const instanceUrl = cfg.instanceUrl?.replace(/\/$/, "");
  if (!instanceUrl) {
    return {
      query,
      answer: "",
      results: [],
      error: 'SearXNG: instanceUrl not set in opl-webaccess.json. Set "instanceUrl": "https://your-searxng-instance.org" under the searxng provider.',
    };
  }

  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: cfg.categories ?? "general",
    safesearch: String(cfg.safeSearch ?? 0),
  });

  let response: Response;
  try {
    response = await fetch(`${instanceUrl}/search?${params.toString()}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-access/1.0)",
      },
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return { query, answer: "", results: [], error: "Aborted" };
    return { query, answer: "", results: [], error: errorMessage(err) };
  }

  if (response.status === 403) {
    return {
      query,
      answer: "",
      results: [],
      error: `SearXNG: instance at ${instanceUrl} has JSON format disabled. Try a different instance or self-host one. See: https://searx.space`,
    };
  }

  if (!response.ok) {
    return { query, answer: "", results: [], error: `SearXNG error: HTTP ${response.status}` };
  }

  const data = (await response.json()) as SearxngResponse;

  if (data.error) {
    return { query, answer: "", results: [], error: `SearXNG error: ${data.error}` };
  }

  const capped = (data.results ?? []).slice(0, cfg.maxResults ?? 5);

  const results: SearchResult[] = capped.map((r) => ({
    title: r.title,
    url: r.url,
  }));

  // No native answer synthesis — join top snippets
  const answer = capped
    .slice(0, 3)
    .map((r) => r.content)
    .filter(Boolean)
    .join(" ");

  return { query, answer, results, error: null };
}
