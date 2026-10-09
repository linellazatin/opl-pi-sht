import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePageIndex, indexAfterClose, runAction, closeBrowser } from "../extensions/opl-browser/browser.ts";
import { createRequire } from "node:module";
import { DEFAULT_CONFIG } from "../extensions/opl-browser/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserSrc = readFileSync(join(root, "extensions/opl-browser/browser.ts"), "utf-8");
const { chromium } = await import(createRequire(new URL("../extensions/opl-browser/browser.ts", import.meta.url)).resolve("playwright"));

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

async function driver(onNewPage = () => {}) {
  await closeBrowser();
  const launch = chromium.launch;
  const pages = [];
  let count = 0;
  const context = {
    pages: () => [...pages],
    route: async () => {},
    routeWebSocket: async () => {},
    close: async () => { for (const page of [...pages]) await page.close(); },
    newPage: async () => {
      const name = `page-${count++}`;
      let closed = false;
      const page = {
        name, onFrames: null,
        on() {}, setDefaultNavigationTimeout() {},
        frames() { this.onFrames?.(); return []; },
        url: () => "about:blank",
        goto: async () => {},
        isClosed: () => closed,
        evaluate: async () => { if (closed) throw new Error("target page closed"); return name; },
        close: async () => { closed = true; const i = pages.indexOf(page); if (i >= 0) pages.splice(i, 1); },
      };
      pages.push(page);
      onNewPage(page);
      return page;
    },
  };
  chromium.launch = async () => ({ newContext: async () => context, close: async () => {} });
  const act = (params, cfg = DEFAULT_CONFIG) => runAction(params, cfg, root);
  await act({ action: "pages" });
  return { pages, act, dispose: async () => { await closeBrowser(); chromium.launch = launch; } };
}

test("externally closing the selected page requires explicit recovery", async () => {
  const h = await driver();
  try {
    await h.act({ action: "new_page" });
    await h.act({ action: "new_page" });
    await h.act({ action: "select_page", index: 1 });
    await h.pages[1].close();
    await assert.rejects(() => h.act({ action: "evaluate", script: "window.name" }), /closed|no page/);
    assert.ok(!(await h.act({ action: "pages" })).text.includes("*"));
    assert.equal((await h.act({ action: "evaluate", index: 1, script: "window.name" })).text, "page-2");
    await assert.rejects(() => h.act({ action: "evaluate", script: "window.name" }), /closed|no page/);
    await h.act({ action: "select_page", index: 1 });
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-2");
  } finally { await h.dispose(); }
});

test("externally closing an earlier page preserves the selected document", async () => {
  const h = await driver();
  try {
    await h.act({ action: "new_page" });
    await h.act({ action: "new_page" });
    await h.act({ action: "select_page", index: 1 });
    await h.pages[0].close();
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-1");
    assert.match((await h.act({ action: "pages" })).text, /\* \[0\]/);
  } finally { await h.dispose(); }
});

test("a page closing during its safety check cannot retarget the action", async () => {
  const h = await driver();
  try {
    await h.act({ action: "new_page" });
    const first = h.pages[0];
    first.onFrames = () => { void first.close(); };
    await assert.rejects(() => h.act({ action: "evaluate", index: 0, script: "window.name" }), /closed|no page/);
  } finally { await h.dispose(); }
});

test("deliberate closes preserve selection or choose the nearest surviving page", async () => {
  const h = await driver();
  try {
    await h.act({ action: "new_page" });
    await h.act({ action: "new_page" });
    await h.act({ action: "select_page", index: 1 });
    await h.act({ action: "close_page", index: 0 });
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-1");
    await h.act({ action: "close_page" });
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-2");
    await h.act({ action: "close_page" });
    await assert.rejects(() => h.act({ action: "evaluate", script: "window.name" }), /no open pages/);
    await h.act({ action: "new_page" });
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-3");
  } finally { await h.dispose(); }
});

test("a new page closing during validation fails instead of reporting index -1", async () => {
  const h = await driver((page) => {
    if (page.name === "page-1") page.onFrames = () => { void page.close(); };
  });
  try {
    await assert.rejects(() => h.act({ action: "new_page", url: "http://127.0.0.1/" }, { ...DEFAULT_CONFIG, allowLoopback: true }), /closed/);
    await assert.rejects(() => h.act({ action: "evaluate", script: "window.name" }), /closed/);
    await h.act({ action: "select_page", index: 0 });
    assert.equal((await h.act({ action: "evaluate", script: "window.name" })).text, "page-0");
  } finally { await h.dispose(); }
});

test("the index argument is documented as page-scoped, not just select/close", () => {
  const schema = readFileSync(join(root, "extensions/opl-browser/index.ts"), "utf-8");
  assert.match(schema, /index: Type\.Optional\(Type\.Number\(\{ description: "page-scoped actions/);
  assert.ok(!schema.includes("select_page/close_page: page index"), "schema still limits index to select/close");
});
