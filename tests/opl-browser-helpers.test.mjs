import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMarkdown } from "../extensions/opl-browser/extract.ts";
import { assertHttpUrl, assertSafeHttpUrl, decideSubresource, safeScreenshotPath } from "../extensions/opl-browser/validate.ts";
import { paginateStored, continuationNotice } from "../extensions/opl-browser/paging.ts";
import { DEFAULT_CONFIG, loadUserConfig } from "../extensions/opl-browser/config.ts";
import { assertFrameTargetsSafe, installGuard, makeRouteHandler, makeWebSocketGuard } from "../extensions/opl-browser/browser.ts";
import { MAX_LOG_ENTRIES, pushLogEntry } from "../extensions/opl-browser/browser.ts";

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>My Post — SiteName</title></head><body>
<nav><a href="/">Home</a><a href="/login">LoginPlaceholder</a><a href="/about">About</a></nav>
<article>
  <h1>My Post</h1>
  <p>Intro paragraph with enough words in it so that the readability heuristics treat this
  article element as the primary candidate for extraction instead of rejecting the document
  for having too little text content to score against the boilerplate removal rules.</p>
  <h2>Section</h2>
  <p>Second paragraph that keeps the article body comfortably above the minimum length
  threshold used by the candidate scoring pass.</p>
  <pre><code>const x = 1;
console.log(x);</code></pre>
</article>
<footer>FooterPlaceholder copyright nobody</footer>
</body></html>`;

test("extractMarkdown pulls the article and keeps markdown structure", () => {
  const { title, markdown } = extractMarkdown(ARTICLE_HTML);
  assert.equal(title, "My Post — SiteName");
  assert.ok(markdown.includes("## Section"), "headings survive as atx markdown");
  assert.ok(markdown.includes("```"), "code block survives as fenced markdown");
  assert.ok(markdown.includes("console.log(x);"), "code content preserved");
  assert.ok(!markdown.includes("LoginPlaceholder"), "nav boilerplate stripped");
  assert.ok(!markdown.includes("FooterPlaceholder"), "footer boilerplate stripped");
});

test("extractMarkdown falls back to raw turndown when Readability finds nothing", () => {
  const { title, markdown } = extractMarkdown("<p>just a tiny fragment</p>");
  assert.equal(title, "");
  assert.ok(markdown.includes("just a tiny fragment"), "fallback keeps the text");
});

test("raw mode keeps every sibling in a selector-scoped fragment", () => {
  // Real fragment from gcash.com #about-gcash: Readability's whole-document
  // candidate scoring, run on the scoped subtree, kept only the "200+"
  // countries card and dropped the heading and five other stat cards.
  const FRAGMENT = `<section id="about-gcash" class="consumer_panel infographics"><div class="aboutus_section strength_section"><div class="bounding-box strength_section mb-section"><div class="aboutus_inner_section strength_section"><h2 class="item h2---title strengths">Strength, in numbers</h2></div><div class="aboutus_inner_section strength_card_section"><div class="strength_card_grid"><div class="strength_card used-gcash"><div class="stack column"><div class="strength_card_title">94M</div><div class="strength_card_description">Filipino have used GCash</div></div></div><div class="strength_card via-gsave"><div class="stack column"><div class="strength_card_title">Over 9M Filipinos</div><div class="strength_card_description">with savings via GSave</div></div></div><div class="strength_card merchants"><div class="stack column"><div class="strength_card_title">6M merchants</div><div class="strength_card_description">and social sellers on the app</div></div></div><div class="strength_card countries"><div class="strength_text_side-to-side"><div class="strength_card_title">200+</div><div class="strength_card_description countries">Countries with Filipino GCash Users</div></div></div><div class="strength_card planted"><div class="stack column"><div class="strength_card_title">3M+</div><div class="strength_card_description">Actual trees planted</div></div></div><div class="strength_card borrowers"><div class="stack column"><div class="strength_card_title">Over 3M borrowers</div><div class="strength_card_description borrowers">through GLoan, GGives, and GCredit</div></div></div></div></div></div></div></section>`;
  const { title, markdown } = extractMarkdown(FRAGMENT, { raw: true });
  assert.equal(title, "", "raw mode does not invent a title");
  assert.ok(markdown.includes("Strength, in numbers"), "heading kept");
  for (const stat of ["94M", "Over 9M Filipinos", "6M merchants", "200+", "3M+", "Over 3M borrowers"]) {
    assert.ok(markdown.includes(stat), `raw mode keeps every stat card: ${stat}`);
  }
});

test("browser get paginates stored output", () => {
  const page = paginateStored("abcdefghij", 4, 3);
  assert.equal(page.text, "efg");
  assert.equal(page.offset, 4);
  assert.equal(page.totalChars, 10);
  assert.equal(page.nextOffset, 7);
  assert.ok(continuationNotice(page).includes("offset=7"), "notice explains how to continue");
  assert.ok(continuationNotice(page).includes("action:get"), "notice names the retrieval action");

  const last = paginateStored("abcdefghij", 9, 3);
  assert.equal(last.text, "j");
  assert.equal(last.nextOffset, null);
  assert.equal(continuationNotice(last), "", "no notice on the final page");
});

test("browser config exposes a configurable retrieval cap", () => {
  assert.equal(DEFAULT_CONFIG.getChars, 30000);
  assert.equal(loadUserConfig("/nonexistent/opl-browser.json").getChars, 30000);
  assert.equal(loadUserConfig("/nonexistent/opl-browser.json").previewChars, 4000, "existing default preserved");
});

test("browser guards reject non-http URLs and escaping screenshot paths", () => {
  assert.equal(assertHttpUrl("https://example.com"), "https://example.com/");
  assert.equal(assertHttpUrl("http://example.com/a?b=1"), "http://example.com/a?b=1");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => assertHttpUrl("javascript:alert(1)"), /http\/https/);
});

test("browser guards block loopback by default and gate it on allowLoopback", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1/admin", "http://[::1]"]) {
    assert.throws(() => assertHttpUrl(url), /blocked network host/i, `should block by default: ${url}`);
    assert.equal(assertHttpUrl(url, { allowLoopback: true }), new URL(url).href, `should allow when opted in: ${url}`);
  }
  for (const url of ["http://192.168.1.100/", "http://10.0.0.1/", "http://[::ffff:10.0.0.1]/", "http://[fd00::1]"]) {
    assert.throws(() => assertHttpUrl(url), /blocked network host/i, `should block: ${url}`);
  }
});

test("browser guards hard-block cloud metadata even with private opt-in", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/",
    "http://metadata.google.internal/",
    "http://[fd00:ec2::254]/",
  ]) {
    assert.throws(() => assertHttpUrl(url), /blocked network host/i, `should block: ${url}`);
    assert.throws(() => assertHttpUrl(url, { allowPrivateNetwork: true }), /blocked network host/i, `should still block with opt-in: ${url}`);
  }
  assert.equal(assertHttpUrl("http://192.168.1.100:8000", { allowPrivateNetwork: true }), "http://192.168.1.100:8000/");
});

test("safeScreenshotPath requires an image extension and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "opl-browser-shots-"));
  try {
    // The target is returned resolved, so Playwright writes into the session directory and not
    // wherever the harness happened to start; the reservation is created empty on success.
    assert.equal(safeScreenshotPath("shot.png", dir), join(dir, "shot.png"));
    assert.equal(safeScreenshotPath("shots/y.png", dir), join(dir, "shots", "y.png"));
    assert.throws(() => safeScreenshotPath("../x.png", dir), /project directory/);
    assert.throws(() => safeScreenshotPath("/tmp/x.png", dir), /project directory/);
    assert.throws(() => safeScreenshotPath("notes.txt", dir), /\.png or \.jpg/);

    writeFileSync(join(dir, "existing.png"), "sentinel");
    assert.throws(() => safeScreenshotPath("existing.png", dir), /refusing to overwrite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pushLogEntry trims the oldest entries past the cap", () => {
  const entries = [];
  for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) pushLogEntry(entries, `line-${i}`);
  assert.equal(entries.length, MAX_LOG_ENTRIES);
  assert.equal(entries[0], "line-50");
  assert.equal(entries.at(-1), `line-${MAX_LOG_ENTRIES + 49}`);
});

test("assertSafeHttpUrl blocks browser navigations whose host resolves internally", async () => {
  const at = (address) => async () => [address];
  // metadata and private answers are rejected under the shipped defaults
  await assert.rejects(
    () => assertSafeHttpUrl("http://spoofed.example/late", { resolveHost: at("169.254.169.254") }),
    /blocked network host/i,
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://corp.example/", { resolveHost: at("10.0.0.5") }),
    /blocked network host/i,
  );
  // a loopback answer follows allowLoopback, which is opt-in
  await assert.rejects(
    () => assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { resolveHost: at("127.0.0.1") }),
    /blocked network host/i,
  );
  assert.equal(
    await assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { allowLoopback: true, resolveHost: at("127.0.0.1") }),
    "http://127.0.0.1.nip.io:8080/x",
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { allowLoopback: false, resolveHost: at("127.0.0.1") }),
    /blocked network host/i,
  );
  assert.equal(await assertSafeHttpUrl("https://example.com/a", { resolveHost: at("93.184.216.34") }), "https://example.com/a");
  assert.equal(await assertSafeHttpUrl("http://192.168.1.100:8000", { allowPrivateNetwork: true }), "http://192.168.1.100:8000/");
});

test("decideSubresource aborts internal requests and continues non-http and missing hosts", async () => {
  const at = (address) => async () => [address];
  assert.equal(await decideSubresource("http://metadata.nip.io/", { resolveHost: at("169.254.169.254") }), "abort");
  assert.equal(await decideSubresource("http://corp.example/x", { resolveHost: at("10.0.0.1") }), "abort");
  assert.equal(await decideSubresource("http://loopback.nip.io/x", { allowLoopback: false, resolveHost: at("127.0.0.1") }), "abort");
  assert.equal(await decideSubresource("http://127.0.0.1:3000/hmr", { allowLoopback: false }), "abort");
  assert.equal(await decideSubresource("https://ok.example/a", { resolveHost: at("93.184.216.34") }), "continue");
  assert.equal(await decideSubresource("data:text/html,hi"), "continue");
  assert.equal(await decideSubresource("blob:https://ok.example/uuid"), "continue");
  assert.equal(await decideSubresource("about:blank"), "continue");
  // file: is NOT in the ignore list: the sync scheme guard rejects it, so it must abort
  assert.equal(await decideSubresource("file:///etc/passwd"), "abort");
  const enotfound = Object.assign(new Error("ENOTFOUND gone.example"), { code: "ENOTFOUND" });
  assert.equal(await decideSubresource("http://gone.example/", { resolveHost: async () => { throw enotfound; } }), "continue");
  const timeout = Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
  assert.equal(await decideSubresource("http://slow.example/", { resolveHost: async () => { throw timeout; } }), "abort");
  assert.equal(await decideSubresource("http://weird.example/", { resolveHost: async () => { throw "not even an error"; } }), "abort");
});

test("browser config carries allowLoopback to the guard, default false", () => {
  const dir = mkdtempSync(join(tmpdir(), "opl-browser-cfg-"));
  const write = (name, body) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
  assert.equal(DEFAULT_CONFIG.allowLoopback, false);
  assert.equal(loadUserConfig(write("unset.json", { headless: true })).allowLoopback, false, "absent key defaults to false");
  assert.equal(loadUserConfig(write("off.json", { allowLoopback: false })).allowLoopback, false);
  // the shipped sample must parse to the documented default, not merely contain the key
  assert.equal(loadUserConfig(new URL("../configs/opl-browser.json.sample", import.meta.url).pathname).allowLoopback, false);
  // the sample file itself must carry the key and describe it; a default alone hides regressions
  const sample = JSON.parse(readFileSync(new URL("../configs/opl-browser.json.sample", import.meta.url), "utf-8"));
  assert.equal(sample.allowLoopback, false, "shipped sample carries the documented default");
  assert.match(sample["_comment"], /allowLoopback/, "shipped sample carries the documented key and comment");
});

test("makeRouteHandler aborts guarded requests and lets the rest through", async () => {
  const internal = makeRouteHandler({ allowPrivateNetwork: false, allowLoopback: true, resolveHost: async () => ["10.0.0.1"] });
  const publicHost = makeRouteHandler({ allowPrivateNetwork: false, allowLoopback: true, resolveHost: async () => ["93.184.216.34"] });
  const seen = [];
  const fakeRoute = (url) => ({
    request: () => ({ url: () => url }),
    abort: async (why) => { seen.push(`abort:${why}`); },
    continue: async () => { seen.push("continue"); },
  });
  await internal(fakeRoute("http://internal.example/x"));
  assert.deepEqual(seen, ["abort:blockedbyclient"]);
  await publicHost(fakeRoute("https://ok.example/y"));
  assert.deepEqual(seen, ["abort:blockedbyclient", "continue"]);
  // no host to classify: the handler must neither abort nor re-issue
  await publicHost(fakeRoute("data:text/html,hi"));
  await publicHost(fakeRoute("blob:https://ok.example/uuid"));
  assert.deepEqual(seen, ["abort:blockedbyclient", "continue"], "data:/blob: requests are left alone");
});

// --- frame guard: server-side redirects are not re-routed by Playwright (review C1) ---

const fakePage = (urls, blanked) => ({
  url: () => urls[0],
  frames: () => urls.map((u) => ({ url: () => u })),
  goto: async () => { blanked.n++; },
});

test("assertFrameTargetsSafe blanks and rejects a page whose frame landed on a blocked host", async () => {
  const blanked = { n: 0 };
  const page = fakePage(["http://127.0.0.1:8080/stolen"], blanked);
  await assert.rejects(
    () => assertFrameTargetsSafe(page, { allowPrivateNetwork: false, allowLoopback: false }),
    /Blocked network host/,
  );
  assert.equal(blanked.n, 1, "unsafe page must be cleared before the error surfaces");
});

test("assertFrameTargetsSafe rejects on a blocked iframe even when the top frame is public", async () => {
  const blanked = { n: 0 };
  const page = fakePage(["https://public.example/page", "http://10.0.0.9/inline"], blanked);
  await assert.rejects(
    () => assertFrameTargetsSafe(page, {
      allowPrivateNetwork: false,
      allowLoopback: true,
      resolveHost: async () => ["93.184.216.34"],
    }),
    /Blocked network host "10.0.0.9"/,
  );
  assert.equal(blanked.n, 1);
});

test("assertFrameTargetsSafe allows public and hostless frames without blanking", async () => {
  const blanked = { n: 0 };
  const page = fakePage(["https://public.example/page", "about:blank", "data:text/html,hi", "blob:https://public.example/x", ""], blanked);
  await assertFrameTargetsSafe(page, { allowPrivateNetwork: false, allowLoopback: false, resolveHost: async () => ["93.184.216.34"] });
  assert.equal(blanked.n, 0);
});

// --- guard installation wiring (review I2b) + websocket leg (review I2) ---

test("installGuard registers http(s) routing and websocket routing on the context", async () => {
  const calls = [];
  const ctx = {
    route: async (pattern, handler) => { calls.push(["route", String(pattern), typeof handler]); },
    routeWebSocket: async (pattern, handler) => { calls.push(["routeWebSocket", String(pattern), typeof handler]); },
  };
  await installGuard(ctx, { allowPrivateNetwork: false, allowLoopback: true, resolveHost: async () => ["93.184.216.34"] });
  assert.deepEqual(calls.map((c) => c[0]), ["route", "routeWebSocket"], "both guards must be installed");
  assert.ok(calls.every((c) => c[2] === "function"));
});

test("installGuard propagates a registration failure so ensure() cannot publish an unguarded context", async () => {
  const ctx = {
    route: async () => { throw new Error("routing unsupported in this build"); },
    routeWebSocket: async () => {},
  };
  await assert.rejects(() => installGuard(ctx, { allowLoopback: true }), /routing unsupported/);
});

test("makeWebSocketGuard closes internal sockets and connects public ones", async () => {
  const seen = [];
  const strict = makeWebSocketGuard({
    allowPrivateNetwork: false,
    allowLoopback: false,
    resolveHost: async (host) => (host === "internal.test" ? ["10.0.0.1"] : ["93.184.216.34"]),
  });
  const fake = (url) => ({ url: () => url, close: async () => { seen.push("close"); }, connectToServer: () => { seen.push("connect"); } });
  await strict(fake("ws://127.0.0.1:9229/devtools/browser"));
  await strict(fake("ws://internal.test:8888/ws"));
  await strict(fake("ws://169.254.169.254/latest/meta-data"));
  await strict(fake("wss://public.example/feed"));
  await strict(fake("ftp://public.example/x"));
  assert.deepEqual(seen, ["close", "close", "close", "connect", "close"], "ws:// must map onto the http(s) policy; anything unclassifiable is closed");
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

test("decideSubresource refuses rather than waiting on a stalled resolver", async () => {
  const started = Date.now();
  const decision = await decideSubresource("http://stalled.test/x", {
    resolveHost: () => new Promise(() => {}),
    dnsTimeoutMs: 50,
  });
  assert.equal(decision, "abort", "an unclassifiable request is not a request to let through");
  assert.ok(Date.now() - started < 1000, "the guard must bound its own DNS wait");
});

test("assertFrameTargetsSafe bounds its DNS wait per frame", async () => {
  const blanked = { n: 0 };
  const page = {
    url: () => "http://stalled.test/x",
    frames: () => [{ url: () => "http://stalled.test/x" }],
    goto: async () => { blanked.n++; },
  };
  await assert.rejects(
    () => assertFrameTargetsSafe(page, { resolveHost: () => new Promise(() => {}), dnsTimeoutMs: 50 }),
    /Aborted|Blocked/,
  );
  assert.equal(blanked.n, 1);
});

// --- IPv6 forms that embed an internal IPv4 (review "declined to judge", measured here) ---

test("nat64, 6to4 and ipv4-compatible literals are judged by the address they embed", () => {
  const blocked = [
    "http://[64:ff9b::a9fe:a9fe]/", // NAT64 -> 169.254.169.254 (metadata)
    "http://[64:ff9b::169.254.169.254]/",
    "http://[64:ff9b::6464:64c8]/", // NAT64 -> 100.100.100.200 (Alibaba metadata)
    "http://[2002:c0a8:101::]/", // 6to4 -> 192.168.1.1
    "http://[2002:0a00:0001::]/", // 6to4 -> 10.0.0.1
    "http://[::7f00:1]/", // ipv4-compatible -> 127.0.0.1
    "http://[::127.0.0.1]/",
  ];
  for (const url of blocked) {
    assert.throws(() => assertHttpUrl(url, { allowPrivateNetwork: false, allowLoopback: false }), /Blocked network host/, url);
  }
  // metadata embedded in NAT64 stays blocked even with every opt-in
  assert.throws(() => assertHttpUrl("http://[64:ff9b::a9fe:a9fe]/", { allowPrivateNetwork: true, allowLoopback: true }), /Blocked network host/);
});

test("nat64 and 6to4 forms that embed a public ipv4 still pass", async () => {
  const publicForms = ["http://[2002:5bf0:1::]/x", "http://[64:ff9b::5d96:98b6]/x"]; // 91.240.0.1, 93.150.152.182
  for (const url of publicForms) {
    assert.equal(await assertSafeHttpUrl(url, { allowPrivateNetwork: false }), new URL(url).href, url);
  }
});
