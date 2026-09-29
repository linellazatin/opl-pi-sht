import assert from "node:assert/strict";
import { test } from "bun:test";
import { errorMessage, isAbortError, truncate, isPdfUrl, isPdfContentType, assertHttpUrl, paginateContent, continuationNotice } from "../extensions/opl-webaccess/utils.ts";
import { generateId, storeResult, getResult, clearStore } from "../extensions/opl-webaccess/storage.ts";
import { resolveCaps, DEFAULT_MAX_CONTENT_CHARS, DEFAULT_MAX_RETRIEVAL_CHARS, DEFAULT_MAX_SEARCH_QUERIES, DEFAULT_MAX_FETCH_URLS } from "../extensions/opl-webaccess/config.ts";
import { fetchAllContent, MAX_FETCH_URLS } from "../extensions/opl-webaccess/extract.ts";

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

test("paginates retrieval content with continuation offsets", () => {
  const page = paginateContent("abcdefghij", 3, 4);
  assert.equal(page.text, "defg", "starts at offset");
  assert.equal(page.offset, 3);
  assert.equal(page.totalChars, 10);
  assert.equal(page.nextOffset, 7, "points past the returned slice");
  assert.ok(continuationNotice(page).includes("offset=7"), "notice tells the model how to continue");

  const last = paginateContent("abcdefghij", 8, 4);
  assert.equal(last.text, "ij", "final slice is short");
  assert.equal(last.nextOffset, null, "no continuation past the end");
  assert.equal(continuationNotice(last), "", "no notice when complete");

  const clamped = paginateContent("abc", 99, 4);
  assert.equal(clamped.text, "", "offset past the end yields empty text");
  assert.equal(clamped.nextOffset, null);
});

test("resolves configurable content limits with defaults", () => {
  assert.equal(DEFAULT_MAX_CONTENT_CHARS, 30000);
  assert.equal(DEFAULT_MAX_RETRIEVAL_CHARS, 30000);
  assert.equal(DEFAULT_MAX_SEARCH_QUERIES, 10);
  assert.equal(DEFAULT_MAX_FETCH_URLS, 20);
  const defaults = resolveCaps({});
  assert.equal(defaults.maxContentChars, 30000);
  assert.equal(defaults.maxRetrievalChars, 30000);
  assert.equal(defaults.maxSearchQueries, 10);
  assert.equal(defaults.maxFetchUrls, 20);
  const custom = resolveCaps({ maxContentChars: 1234, maxRetrievalChars: 42, maxSearchQueries: 5, maxFetchUrls: 8 });
  assert.equal(custom.maxContentChars, 1234);
  assert.equal(custom.maxRetrievalChars, 42);
  assert.equal(custom.maxSearchQueries, 5);
  assert.equal(custom.maxFetchUrls, 8);
  // Malformed caps (non-number, infinite, non-positive) fall back to defaults.
  assert.equal(resolveCaps({ maxContentChars: "abc" }).maxContentChars, 30000);
  assert.equal(resolveCaps({ maxRetrievalChars: NaN }).maxRetrievalChars, 30000);
  assert.equal(resolveCaps({ maxContentChars: 0, maxRetrievalChars: -5 }).maxContentChars, 30000);
  assert.equal(resolveCaps({ maxContentChars: 0, maxRetrievalChars: -5 }).maxRetrievalChars, 30000);
  assert.equal(resolveCaps({ maxContentChars: Infinity }).maxContentChars, 30000);
  assert.equal(resolveCaps({ maxSearchQueries: "many", maxFetchUrls: -1 }).maxSearchQueries, 10);
  assert.equal(resolveCaps({ maxSearchQueries: "many", maxFetchUrls: -1 }).maxFetchUrls, 20);
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
  // TTL is also enforced on read even without a later store.
  storeResult("idle", { id: "idle", type: "search", timestamp: now });
  assert.ok(getResult("idle"), "fresh entry retained");
  assert.equal(getResult("idle", now + 61 * 60 * 1000), null, "expired on read without a later store");
  assert.equal(getResult("idle"), null, "expired entry stayed evicted");
  assert.equal(getResult("missing"), null, "unknown id returns null");
  clearStore();
  assert.equal(getResult("fresh"), null, "clearStore empties the store");
});

test("assertHttpUrl allows only http/https", () => {
  assert.equal(assertHttpUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(assertHttpUrl("http://example.com"), "http://example.com/");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => assertHttpUrl("ftp://example.com"), /http\/https/);
  assert.throws(() => assertHttpUrl("not a url"), /Invalid URL/);
});

test("assertHttpUrl allows loopback by default and blocks private/link-local ranges", () => {
  // Loopback is allowed out of the box for local dev servers.
  for (const url of [
    "http://localhost",
    "http://localhost:3000/app",
    "http://foo.localhost/x",
    "http://127.0.0.1/api",
    "http://2130706433/", // integer form of 127.0.0.1
    "http://[::1]/",
  ]) {
    assert.equal(assertHttpUrl(url), new URL(url).href, `should allow loopback: ${url}`);
  }

  for (const url of [
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.100/",
    "http://100.64.0.1/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:192.168.0.5]/",
  ]) {
    assert.throws(() => assertHttpUrl(url), /Blocked network host/, `should block: ${url}`);
  }
});

test("assertHttpUrl hard-blocks cloud metadata even with private opt-in", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/",
    "http://metadata.google.internal/",
    "http://instance-data/",
    "http://[fd00:ec2::254]/",
    "http://[::ffff:169.254.169.254]/",
  ]) {
    assert.throws(() => assertHttpUrl(url), /Blocked network host/, `should block: ${url}`);
    assert.throws(() => assertHttpUrl(url, { allowPrivateNetwork: true }), /Blocked network host/, `should still block with opt-in: ${url}`);
  }
});

test("assertHttpUrl opt-in allows private hosts", () => {
  assert.equal(assertHttpUrl("http://192.168.1.100:8000", { allowPrivateNetwork: true }), "http://192.168.1.100:8000/");
  assert.equal(assertHttpUrl("http://localhost:3000", { allowPrivateNetwork: true }), "http://localhost:3000/");
});

test("fetchAllContent caps the number of URLs per call", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const urls = Array.from({ length: MAX_FETCH_URLS + 5 }, (_, i) => `https://example.com/${i}`);
    const results = await fetchAllContent(urls);
    assert.equal(results.length, MAX_FETCH_URLS);
    assert.equal(calls, MAX_FETCH_URLS);
  } finally {
    globalThis.fetch = realFetch;
  }
});
