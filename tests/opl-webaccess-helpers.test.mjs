import assert from "node:assert/strict";
import { test } from "bun:test";
import { errorMessage, isAbortError, truncate, isPdfUrl, isPdfContentType } from "../extensions/opl-webaccess/utils.ts";
import { generateId, storeResult, getResult, clearStore } from "../extensions/opl-webaccess/storage.ts";

test("classifies web errors and truncates retrieval content", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(42), "42");
  assert.equal(isAbortError(new Error("The operation was aborted")), true);
  assert.equal(isAbortError(new Error("Request cancelled")), true);
  assert.equal(isAbortError(new Error("timeout")), false);
  assert.equal(truncate("hello", 10), "hello", "under limit is unchanged");
  assert.equal(truncate("hello", 5), "hello", "exactly at limit is unchanged");
  const truncated = truncate("hello world", 5);
  assert.ok(truncated.startsWith("hello"), "keeps the first maxChars");
  assert.ok(truncated.includes("Content truncated"), "adds truncation notice");
  assert.ok(truncated.includes("get_search_content"), "notice mentions retrieval tool");
});

test("recognizes PDF URLs and content types", () => {
  assert.equal(isPdfUrl("https://example.com/paper.pdf"), true);
  assert.equal(isPdfUrl("https://example.com/paper.PDF"), true, "case-insensitive");
  assert.equal(isPdfUrl("https://example.com/paper.pdf?x=1"), true, "query string is excluded from pathname");
  assert.equal(isPdfUrl("https://example.com/page.html"), false);
  assert.equal(isPdfUrl("not a url paper.pdf"), true, "fallback path for unparseable input");
  assert.equal(isPdfUrl("not a url page.html"), false);
  assert.equal(isPdfContentType("application/pdf"), true);
  assert.equal(isPdfContentType("Application/PDF; charset=binary"), true, "case-insensitive + params");
  assert.equal(isPdfContentType("text/html"), false);
});

test("generates and expires stored web results", () => {
  const first = generateId();
  const second = generateId();
  assert.notEqual(first, second, "ids are unique");
  assert.match(first, /^[0-9a-z]+$/, "base36 characters only");
  clearStore();
  const now = Date.now();
  storeResult("fresh", { id: "fresh", type: "search", timestamp: now });
  assert.ok(getResult("fresh"), "fresh entry retained");
  storeResult("stale", { id: "stale", type: "search", timestamp: now - 61 * 60 * 1000 });
  assert.equal(getResult("stale"), null, "expired entry evicted on next store");
  assert.ok(getResult("fresh"), "fresh entry still present after eviction");
  assert.equal(getResult("missing"), null, "unknown id returns null");
  clearStore();
  assert.equal(getResult("fresh"), null, "clearStore empties the store");
});
