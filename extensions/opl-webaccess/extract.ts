import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractPdfBuffer } from "./pdf.js";
import { errorMessage, isAbortError, isPdfUrl, isPdfContentType, assertSafeHttpUrl, type HttpUrlOptions } from "./utils.js";
import type { ExtractedContent } from "./types.js";

const CONCURRENT_LIMIT = 3;
const MAX_FETCH_BYTES = 10 * 1024 * 1024; // 10 MB response cap
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Ceiling on the number of URLs a single fetch_content call may include. */
export const MAX_FETCH_URLS = 20;

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

/** Read a response body into bytes, aborting past maxBytes (guards memory against huge payloads). */
async function readBufferCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`Response too large (${declared} bytes)`);
  const reader = response.body?.getReader();
  if (!reader) return await response.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

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
 * Fetch with redirects followed manually so each hop is re-validated *and* re-resolved.
 * The native `redirect: "follow"` would let a public URL bounce to a private/link-local
 * host past the guard, and a hostname that merely *reads* public can answer with an
 * internal address, so every hop goes through assertSafeHttpUrl.
 */
async function fetchWithRedirectValidation(
  url: string,
  fetchSignal: AbortSignal,
  opts: HttpUrlOptions
): Promise<Response> {
  let current = await assertSafeHttpUrl(url, { ...opts, signal: fetchSignal });
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; pi-web-access/1.0)",
    Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
  };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { signal: fetchSignal, headers, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response; // 3xx without a Location: treat as final
    await response.body?.cancel().catch(() => {});
    current = await assertSafeHttpUrl(new URL(location, current).href, { ...opts, signal: fetchSignal });
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

async function fetchOne(url: string, signal?: AbortSignal, opts: HttpUrlOptions = {}): Promise<ExtractedContent> {
  try {
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetchWithRedirectValidation(url, fetchSignal, opts);

    if (!response.ok) {
      return { url, title: "", content: "", error: `HTTP ${response.status}: ${url}` };
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (isPdfUrl(url) || isPdfContentType(contentType)) {
      const buffer = await readBufferCapped(response, MAX_FETCH_BYTES);
      const content = await extractPdfBuffer(buffer);
      return { url, title: url, content, error: null };
    }

    const isHtml =
      contentType.includes("text/html") || contentType.includes("application/xhtml");

    const body = new TextDecoder().decode(await readBufferCapped(response, MAX_FETCH_BYTES));

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
