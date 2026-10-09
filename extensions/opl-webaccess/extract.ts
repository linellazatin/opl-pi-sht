import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractPdfBuffer } from "./pdf.js";
import { errorMessage, isAbortError, isPdfUrl, isPdfContentType, resolveSafeHostUrl, type HttpUrlOptions } from "./utils.js";
import { pinnedFetch, type PinnedResponse } from "./http.js";
import type { ExtractedContent } from "./types.js";

const CONCURRENT_LIMIT = 3;
const MAX_FETCH_BYTES = 10 * 1024 * 1024; // default response cap, overridable by maxResponseBytes
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; pi-web-access/1.0)",
  Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
};
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Ceiling on the number of URLs a single fetch_content call may include. */
export const MAX_FETCH_URLS = 20;

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export async function fetchAllContent(
  urls: string[],
  signal?: AbortSignal,
  opts: HttpUrlOptions = {},
  maxUrls: number = MAX_FETCH_URLS,
): Promise<ExtractedContent[]> {
  const bounded = urls.slice(0, maxUrls);
  const results: ExtractedContent[] = [];
  for (let i = 0; i < bounded.length; i += CONCURRENT_LIMIT) {
    if (signal?.aborted) break;
    const batch = bounded.slice(i, i + CONCURRENT_LIMIT);
    const batchResults = await Promise.all(batch.map((url) => fetchOne(url, signal, opts)));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Fetch with redirects followed manually so each hop is re-validated, re-resolved **and
 * re-pinned**. The native `redirect: "follow"` would let a public URL bounce to a private or
 * link-local host past the guard; a hostname that merely reads public can answer with an
 * internal address; and a record with a short TTL can answer one address at check time and
 * another at connect time. So every hop goes through resolveSafeHostUrl and the socket is
 * pinned to the addresses that hop approved.
 */
async function fetchWithRedirectValidation(
  url: string,
  fetchSignal: AbortSignal,
  opts: HttpUrlOptions
): Promise<PinnedResponse> {
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_FETCH_BYTES;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await resolveSafeHostUrl(current, { ...opts, signal: fetchSignal });
    const request = {
      signal: fetchSignal,
      headers: FETCH_HEADERS,
      maxResponseBytes,
      timeoutMs: opts.timeoutMs,
    };
    const response = await (opts.transport ?? pinnedFetch)(target, request);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response; // 3xx without a Location: treat as final
    current = new URL(location, target.url).href;
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

async function fetchOne(url: string, signal?: AbortSignal, opts: HttpUrlOptions = {}): Promise<ExtractedContent> {
  try {
    const budget = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(budget)])
      : AbortSignal.timeout(budget);
    const response = await fetchWithRedirectValidation(url, fetchSignal, opts);

    if (!response.ok) {
      return { url, title: "", content: "", error: `HTTP ${response.status}: ${url}` };
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (isPdfUrl(url) || isPdfContentType(contentType)) {
      const content = await extractPdfBuffer(response.body);
      return { url, title: url, content, error: null };
    }

    const isHtml =
      contentType.includes("text/html") || contentType.includes("application/xhtml");

    const body = response.text();

    if (!isHtml) {
      // Plain text, markdown, JSON, etc. — return as-is
      return { url, title: "", content: body, error: null };
    }

    const { document } = parseHTML(body);
    let article = null;
    try {
      article = new Readability(document as unknown as Document).parse();
    } catch {
      // Readability failed — fall back to raw turndown
    }

    if (!article?.content) {
      return { url, title: "", content: td.turndown(body), error: null };
    }

    return {
      url,
      title: article.title ?? "",
      content: td.turndown(article.content),
      error: null,
    };
  } catch (err) {
    if (isAbortError(err)) return { url, title: "", content: "", error: "Aborted" };
    return { url, title: "", content: "", error: errorMessage(err) };
  }
}
