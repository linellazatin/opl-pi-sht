import { errorMessage, isAbortError } from "../utils.js";
import type { ProviderConfig } from "../config.js";
import type { SearchQueryResult, SearchResult } from "../types.js";

interface ExaResult {
  title: string;
  url: string;
  summary?: string;
  highlights?: string[];
  text?: string;
}

interface ExaResponse {
  results: ExaResult[];
  requestId?: string;
  costDollars?: { total: number };
}

interface ExaError {
  error?: { message: string };
  message?: string;
}

export async function searchExa(
  query: string,
  cfg: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal
): Promise<SearchQueryResult> {
  let response: Response;
  try {
    response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: cfg.maxResults ?? 5,
        type: cfg.searchType ?? "auto",
        contents: cfg.includeSummary
          ? { summary: { query } }
          : { highlights: { numSentences: 3 } },
      }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return { query, answer: "", results: [], error: "Aborted" };
    return { query, answer: "", results: [], error: errorMessage(err) };
  }

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as ExaError;
    const msg = err.error?.message ?? err.message ?? `HTTP ${response.status}`;
    return { query, answer: "", results: [], error: `Exa API error: ${msg}` };
  }

  const data = (await response.json()) as ExaResponse;

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
  }));

  // Prefer summary, fall back to highlights, then plain text snippets
  const answer = (data.results ?? [])
    .slice(0, 3)
    .map((r) => r.summary ?? r.highlights?.join(" ") ?? r.text ?? "")
    .filter(Boolean)
    .join("\n\n");

  return { query, answer, results, error: null };
}
