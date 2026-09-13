import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractPdfBuffer } from "./pdf.js";
import { errorMessage, isAbortError, isPdfUrl, isPdfContentType, assertHttpUrl } from "./utils.js";
import type { ExtractedContent } from "./types.js";

const CONCURRENT_LIMIT = 3;
const MAX_FETCH_BYTES = 10 * 1024 * 1024; // 10 MB response cap
const FETCH_TIMEOUT_MS = 30_000;

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
  signal?: AbortSignal
): Promise<ExtractedContent[]> {
  const results: ExtractedContent[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENT_LIMIT) {
    if (signal?.aborted) break;
    const batch = urls.slice(i, i + CONCURRENT_LIMIT);
    const batchResults = await Promise.all(batch.map((url) => fetchOne(url, signal)));
    results.push(...batchResults);
  }
  return results;
}

async function fetchOne(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
  try {
    const target = assertHttpUrl(url);
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(target, {
      signal: fetchSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-access/1.0)",
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      },
    });

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
