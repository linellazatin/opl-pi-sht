export interface StoredPage {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}

/** Slice stored browser output to one bounded page. Offsets past the end yield empty text. */
export function paginateStored(text: string, offset: number, maxChars: number): StoredPage {
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
export function continuationNotice(page: StoredPage): string {
  if (page.nextOffset === null) return "";
  return `\n\n[Content truncated at ${page.offset + page.text.length} of ${page.totalChars} chars. Continue with action:get offset=${page.nextOffset}.]`;
}