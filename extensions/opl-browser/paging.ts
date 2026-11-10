export interface StoredPage {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}

/** A UTF-16 cap can land between the halves of a surrogate pair; these say which side. */
const isHighSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
};
const isLowSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};

/** Inline preview of stored output, cut on a codepoint boundary. */
export function previewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, isHighSurrogate(text, maxChars - 1) ? maxChars - 1 : maxChars);
}

/** Slice stored browser output to one bounded page. Offsets past the end yield empty text. */
export function paginateStored(text: string, offset: number, maxChars: number): StoredPage {
  const totalChars = text.length;
  const safeOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  // Page ends snap back off a pair, so resumed offsets stay aligned; snap a caller-supplied
  // offset that landed on the second half of a pair back onto the whole pair.
  let start = Math.min(Math.max(0, safeOffset), totalChars);
  if (start > 0 && isLowSurrogate(text, start) && isHighSurrogate(text, start - 1)) start -= 1;
  let end = Math.min(start + maxChars, totalChars);
  if (end < totalChars && isHighSurrogate(text, end - 1)) end -= 1;
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