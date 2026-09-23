export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("abort") || msg.includes("cancelled");
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    "\n\n[Content truncated. Use get_search_content with the responseId to retrieve the full content.]"
  );
}

export interface ContentPage {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}

/** Slice stored content to one bounded page. Offsets past the end yield empty text. */
export function paginateContent(text: string, offset: number, maxChars: number): ContentPage {
  const totalChars = text.length;
  const safeOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const start = Math.min(Math.max(0, safeOffset), totalChars);
  const end = Math.min(start + maxChars, totalChars);
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars,
    nextOffset: end < totalChars ? end : null,
  };
}

/** Model-facing continuation metadata, empty when the page was complete. */
export function continuationNotice(page: ContentPage): string {
  if (page.nextOffset === null) return "";
  return `\n\n[Content truncated at ${page.offset + page.text.length} of ${page.totalChars} chars. Continue with get_search_content offset=${page.nextOffset}.]`;
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().endsWith(".pdf");
  }
}

export function isPdfContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/pdf");
}

/** Normalize a URL, allowing only http/https (file:/data:/etc. are rejected). */
export function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}//" — only http/https`);
  }
  return parsed.href;
}
