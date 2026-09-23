import assert from "node:assert/strict";
import { test } from "bun:test";
import { extractMarkdown } from "../extensions/opl-browser/extract.ts";
import { assertHttpUrl, safeScreenshotPath } from "../extensions/opl-browser/validate.ts";
import { paginateStored, continuationNotice } from "../extensions/opl-browser/paging.ts";
import { DEFAULT_CONFIG, loadUserConfig } from "../extensions/opl-browser/config.ts";

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
  assert.equal(DEFAULT_CONFIG.getChars, 60000);
  assert.equal(loadUserConfig("/nonexistent/opl-browser.json").getChars, 60000);
  assert.equal(loadUserConfig("/nonexistent/opl-browser.json").previewChars, 4000, "existing default preserved");
});

test("browser guards reject non-http URLs and escaping screenshot paths", () => {
  assert.equal(assertHttpUrl("https://example.com"), "https://example.com/");
  assert.equal(assertHttpUrl("http://example.com/a?b=1"), "http://example.com/a?b=1");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => assertHttpUrl("javascript:alert(1)"), /http\/https/);
  assert.equal(safeScreenshotPath("shot.png"), "shot.png");
  assert.equal(safeScreenshotPath("shots/x.png"), "shots/x.png");
  assert.throws(() => safeScreenshotPath("../x.png"), /project directory/);
  assert.throws(() => safeScreenshotPath("/tmp/x.png"), /project directory/);
});
