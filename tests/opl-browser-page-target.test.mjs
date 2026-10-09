import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePageIndex, indexAfterClose } from "../extensions/opl-browser/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserSrc = readFileSync(join(root, "extensions/opl-browser/browser.ts"), "utf-8");

test("resolvePageIndex: an empty page list is an error, not a fallback", () => {
  assert.throws(() => resolvePageIndex(0, 0), /no open pages/);
  assert.throws(() => resolvePageIndex(2, 0, 1), /no open pages/);
});

test("resolvePageIndex: a stale selection throws instead of retargeting the last page", () => {
  // This is the bug the Phase 6 fix closes: `pages[activeIndex] ?? pages[pages.length - 1]`
  // happily navigated or screenshotted a different document once the selected page was gone.
  assert.throws(() => resolvePageIndex(3, 2), /no page at index 3 \(2 pages open/);
  assert.throws(() => resolvePageIndex(1, 1), /no page at index 1 \(1 page open/);
});

test("resolvePageIndex: an explicit index wins and is bounds-checked", () => {
  assert.equal(resolvePageIndex(0, 3, 2), 2);
  assert.equal(resolvePageIndex(2, 3, 0), 0);
  assert.throws(() => resolvePageIndex(0, 3, 3), /no page at index 3/);
  assert.throws(() => resolvePageIndex(0, 3, -1), /no page at index -1/);
  assert.throws(() => resolvePageIndex(0, 3, 1.5), /no page at index 1.5/);
  // A requested index is still validated against an empty list.
  assert.throws(() => resolvePageIndex(0, 0, 0), /no open pages/);
});

test("resolvePageIndex: with no request the selection is used as-is", () => {
  assert.equal(resolvePageIndex(1, 4), 1);
  assert.equal(resolvePageIndex(0, 1), 0);
});

test("indexAfterClose: closing a page before the selection shifts it down", () => {
  assert.equal(indexAfterClose(2, 0, 3), 1);
  assert.equal(indexAfterClose(1, 0, 2), 0);
});

test("indexAfterClose: closing the selected page keeps the nearest survivor", () => {
  assert.equal(indexAfterClose(1, 1, 3), 1); // the page behind it moves into slot 1
  assert.equal(indexAfterClose(2, 2, 3), 1); // last page closed -> step back one
  assert.equal(indexAfterClose(0, 0, 1), 0); // no pages left
});

test("indexAfterClose: closing a page after the selection does not move it", () => {
  assert.equal(indexAfterClose(0, 1, 2), 0);
  assert.equal(indexAfterClose(0, 2, 3), 0);
});

test("the stale-index fallback is gone from the page resolver", () => {
  assert.ok(!browserSrc.includes("?? pages[pages.length - 1]"), "silent last-page fallback returned");
  assert.ok(!/function page\(\)/.test(browserSrc), "the unresolvable page() helper returned");
});

test("page-scoped actions resolve their target through the index argument", () => {
  assert.ok(browserSrc.includes("const target = () => pageAt(p.index)"), "target binding missing");
  assert.match(browserSrc, /case "close_page"[\s\S]*?indexAfterClose\(activeIndex, i, pages\.length\)/);
  assert.match(browserSrc, /case "select_page"[\s\S]*?resolvePageIndex\(activeIndex, ctx\.pages\(\)\.length, p\.index \?\? 0\)/);
  // new_page must select the page it created rather than assuming it landed last.
  assert.match(browserSrc, /case "new_page"[\s\S]*?ctx\.pages\(\)\.indexOf\(pg\)/);
});

test("the index argument is documented as page-scoped, not just select/close", () => {
  const schema = readFileSync(join(root, "extensions/opl-browser/index.ts"), "utf-8");
  assert.match(schema, /index: Type\.Optional\(Type\.Number\(\{ description: "page-scoped actions/);
  assert.ok(!schema.includes("select_page/close_page: page index"), "schema still limits index to select/close");
});
