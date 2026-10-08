import assert from "node:assert/strict";
import { test } from "bun:test";
import { errorMessage, isAbortError, truncate, isPdfUrl, isPdfContentType, assertHttpUrl, assertSafeHttpUrl, paginateContent, continuationNotice } from "../extensions/opl-webaccess/utils.ts";
import { generateId, storeResult, getResult, clearStore } from "../extensions/opl-webaccess/storage.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCaps, loadConfig, DEFAULT_MAX_CONTENT_CHARS, DEFAULT_MAX_RETRIEVAL_CHARS, DEFAULT_MAX_SEARCH_QUERIES, DEFAULT_MAX_FETCH_URLS } from "../extensions/opl-webaccess/config.ts";
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

test("assertSafeHttpUrl applies the address policy to every DNS answer", async () => {
  const at = (address) => async () => [address];
  // answers in non-global space are rejected, metadata even with the private opt-in
  await assert.rejects(
    () => assertSafeHttpUrl("http://spoofed.example/late", {
      allowPrivateNetwork: true,
      resolveHost: at("169.254.169.254"),
    }),
    /Blocked network host/,
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://v6.example/", { resolveHost: at("fd00:ec2::254") }),
    /Blocked network host/,
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://corp.example/", { resolveHost: at("10.0.0.5") }),
    /Blocked network host/,
  );
  // a loopback answer follows allowLoopback, which stays default-true until Phase 3 flips it
  assert.equal(
    await assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { resolveHost: at("127.0.0.1") }),
    "http://127.0.0.1.nip.io:8080/x",
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { allowLoopback: false, resolveHost: at("127.0.0.1") }),
    /Blocked network host/,
  );
});

test("assertSafeHttpUrl blocks when only one of several answers is internal", async () => {
  await assert.rejects(
    () => assertSafeHttpUrl("https://mixed.example/", {
      resolveHost: async () => ["93.184.216.34", "10.0.0.1"],
    }),
    /Blocked network host/,
  );
});

test("assertSafeHttpUrl allows public answers and skips resolution for IP literals", async () => {
  let looked = 0;
  const resolveHost = async () => { looked++; return ["93.184.216.34"]; };
  assert.equal(await assertSafeHttpUrl("https://example.com/a?b=1", { resolveHost }), "https://example.com/a?b=1");
  assert.equal(await assertSafeHttpUrl("http://192.168.1.100:8000", { allowPrivateNetwork: true, resolveHost }), "http://192.168.1.100:8000/");
  assert.equal(looked, 1, "only the hostname case may resolve");
});

test("assertSafeHttpUrl surfaces resolver failures as network errors", async () => {
  const enotfound = Object.assign(new Error("queryA ENOTFOUND nope.example"), { code: "ENOTFOUND" });
  await assert.rejects(() => assertSafeHttpUrl("http://nope.example/", { resolveHost: async () => { throw enotfound; } }), /ENOTFOUND/);
  await assert.rejects(() => assertSafeHttpUrl("http://empty.example/", { resolveHost: async () => [] }), /Could not resolve host/);
});

test("assertHttpUrl honours allowLoopback=false", () => {
  assert.equal(assertHttpUrl("http://localhost:3000/app"), "http://localhost:3000/app");
  assert.throws(() => assertHttpUrl("http://localhost:3000/app", { allowLoopback: false }), /Blocked network host/);
  assert.throws(() => assertHttpUrl("http://127.0.0.1:7/", { allowLoopback: false }), /Blocked network host/);
  assert.throws(() => assertHttpUrl("http://[::1]/", { allowLoopback: false }), /Blocked network host/);
});

test("fetchAllContent re-resolves and rejects an internal redirect target before connecting", async () => {
  const seen = [];
  const resolveHost = async (host) => { seen.push(host); return ["169.254.169.254"]; };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
    new Response(null, { status: 302, headers: { Location: "http://internal.example/late" } }) });
  try {
    const results = await fetchAllContent([`http://127.0.0.1:${server.port}/`], undefined, { resolveHost });
    assert.match(results[0].error ?? "", /Blocked network host/);
    assert.deepEqual(seen, ["internal.example"], "hostname hop resolved once; IP literal hop skipped");
  } finally { server.stop(); }
});

test("webaccess config carries allowLoopback to the fetch guard, default true", () => {
  const dir = mkdtempSync(join(tmpdir(), "opl-webaccess-cfg-"));
  const write = (name, body) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
  assert.equal(loadConfig(write("unset.json", { provider: "searxng" })).allowLoopback, true, "absent key defaults to true");
  assert.equal(loadConfig(write("off.json", { provider: "searxng", allowLoopback: false })).allowLoopback, false);
  assert.equal(loadConfig(write("on.json", { provider: "searxng", allowLoopback: true })).allowLoopback, true);
  // the shipped sample must parse to the documented default, not merely contain the key
  assert.equal(loadConfig(fileURLToPath(new URL("../configs/opl-webaccess.json.sample", import.meta.url))).allowLoopback, true);
  // the sample file itself must carry the key and describe it; a default alone hides regressions
  const sample = JSON.parse(readFileSync(new URL("../configs/opl-webaccess.json.sample", import.meta.url), "utf-8"));
  assert.equal(sample.allowLoopback, true, "shipped sample carries the documented key and comment");
  assert.match(sample["_comment_network"], /allowLoopback/, "shipped sample carries the documented key and comment");
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

// --- unspecified addresses: never toggleable (review M1) ---

test("0.0.0.0/8 and :: are refused even with both toggles open", () => {
  for (const url of ["http://0.0.0.0/x", "http://0.1.2.3/x", "http://[::]/x"]) {
    assert.throws(() => assertHttpUrl(url, { allowPrivateNetwork: true, allowLoopback: true }), /Blocked network host/);
  }
});

test("a DNS answer of 0.0.0.0 is refused even with both toggles open", async () => {
  await assert.rejects(
    () => assertSafeHttpUrl("http://this-network.test/x", {
      allowPrivateNetwork: true,
      allowLoopback: true,
      resolveHost: async () => ["0.0.0.0"],
    }),
    /Blocked network host/,
  );
});

// --- production resolver path and IPv6 answer forms (review I2b / M6) ---

test("the guard asks the system resolver for every answer, verbatim", async () => {
  const dns = await import("node:dns");
  const orig = dns.promises.lookup;
  const seen = [];
  dns.promises.lookup = (host, opts) => {
    seen.push([host, opts]);
    return Promise.resolve([{ address: "10.0.0.1", family: 4 }]);
  };
  try {
    await assert.rejects(() => assertSafeHttpUrl("http://needs-system-resolver.test/x"), /Blocked network host/);
  } finally {
    dns.promises.lookup = orig;
  }
  assert.equal(seen.length, 1, "the guard must go through the resolver, not skip it");
  assert.equal(seen[0][0], "needs-system-resolver.test");
  assert.deepEqual({ ...seen[0][1] }, { all: true, verbatim: true }, "all answers, verbatim order");
});

test("every internal IPv6 answer form is refused, not just fd00::/8", async () => {
  for (const answer of ["::1", "fe80::1", "::ffff:169.254.169.254", "::ffff:127.0.0.1", "fd00::1", "ff02::1"]) {
    await assert.rejects(
      () => assertSafeHttpUrl("http://v6-answer.test/x", {
        allowPrivateNetwork: false,
        allowLoopback: false,
        resolveHost: async () => [answer],
      }),
      /Blocked network host/,
      `${answer} must be refused`,
    );
  }
  // mixed public + internal still refuses
  await assert.rejects(
    () => assertSafeHttpUrl("http://v6-mixed.test/x", {
      allowPrivateNetwork: false,
      allowLoopback: false,
      resolveHost: async () => ["2606:2800:220:1::1", "::1"],
    }),
    /Blocked network host/,
  );
});

// --- resolver cost and caller-abort bounds on the DNS round-trip (review M5 / M4) ---

test("concurrent lookups for one host share a single resolver call, sequentially they do not", async () => {
  const dns = await import("node:dns");
  const orig = dns.promises.lookup;
  let calls = 0;
  dns.promises.lookup = async () => {
    calls++;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  try {
    const two = await Promise.all([
      assertSafeHttpUrl("http://busy-host.test/a"),
      assertSafeHttpUrl("http://busy-host.test/b"),
    ]);
    assert.equal(two.length, 2);
    assert.equal(calls, 1, "200 concurrent subresources on one host must not serialize 200 getaddrinfo calls");
    await assertSafeHttpUrl("http://busy-host.test/c");
    assert.equal(calls, 2, "the decision must not be cached across time (rebinding re-check)");
  } finally {
    dns.promises.lookup = orig;
  }
});

test("an aborted caller signal bounds the DNS round-trip instead of waiting for the resolver", async () => {
  const controller = new AbortController();
  const slow = assertSafeHttpUrl("http://slow-resolver.test/x", {
    resolveHost: () => new Promise((r) => setTimeout(() => r(["93.184.216.34"]), 5000)),
    signal: controller.signal,
  });
  controller.abort();
  const started = Date.now();
  await assert.rejects(slow, (err) => {
    assert.equal(err.name, "AbortError", "must surface as an abort so callers report it unchanged");
    assert.ok(Date.now() - started < 1000, "must not wait out the resolver");
    return true;
  });
});
