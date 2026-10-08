import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMarkdown } from "../extensions/opl-browser/extract.ts";
import { assertHttpUrl, assertSafeHttpUrl, decideSubresource, safeScreenshotPath } from "../extensions/opl-browser/validate.ts";
import { paginateStored, continuationNotice } from "../extensions/opl-browser/paging.ts";
import { DEFAULT_CONFIG, loadUserConfig } from "../extensions/opl-browser/config.ts";
import { makeRouteHandler } from "../extensions/opl-browser/browser.ts";
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

test("browser guards allow loopback by default and block private/link-local ranges", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1/admin", "http://[::1]"]) {
    assert.equal(assertHttpUrl(url), new URL(url).href, `should allow loopback: ${url}`);
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
    assert.equal(safeScreenshotPath("shot.png", dir), "shot.png");
    assert.equal(safeScreenshotPath("shots/x.png", dir), "shots/x.png");
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
  // a loopback answer follows allowLoopback, which stays default-true until Phase 3 flips it
  assert.equal(
    await assertSafeHttpUrl("http://127.0.0.1.nip.io:8080/x", { resolveHost: at("127.0.0.1") }),
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
  const enotfound = Object.assign(new Error("ENOTFOUND gone.example"), { code: "ENOTFOUND" });
  assert.equal(await decideSubresource("http://gone.example/", { resolveHost: async () => { throw enotfound; } }), "continue");
  const timeout = Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
  assert.equal(await decideSubresource("http://slow.example/", { resolveHost: async () => { throw timeout; } }), "abort");
  assert.equal(await decideSubresource("http://weird.example/", { resolveHost: async () => { throw "not even an error"; } }), "abort");
});

test("browser config carries allowLoopback to the guard, default true", () => {
  const dir = mkdtempSync(join(tmpdir(), "opl-browser-cfg-"));
  const write = (name, body) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
  assert.equal(DEFAULT_CONFIG.allowLoopback, true);
  assert.equal(loadUserConfig(write("unset.json", { headless: true })).allowLoopback, true, "absent key defaults to true");
  assert.equal(loadUserConfig(write("off.json", { allowLoopback: false })).allowLoopback, false);
  // the shipped sample must parse to the documented default, not merely contain the key
  assert.equal(loadUserConfig(new URL("../configs/opl-browser.json.sample", import.meta.url).pathname).allowLoopback, true);
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
