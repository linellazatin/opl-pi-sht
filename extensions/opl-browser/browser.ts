import { chromium, type Browser, type BrowserContext, type Page, type Route, type ConsoleMessage } from "playwright";
import { extractMarkdown } from "./extract.js";
import { assertSafeHttpUrl, decideSubresource, safeScreenshotPath, type HttpUrlOptions } from "./validate.js";
import type { BrowserConfig } from "./config.js";

// ponytail: single module-level Chromium instance reused across tool calls.
// One browser per session is enough; add contexts only if parallel isolation matters.
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let activeIndex = 0;

const consoleBuf = new WeakMap<Page, string[]>();
const networkBuf = new WeakMap<Page, string[]>();

/** Cap on per-page console/network log lines kept in memory. */
export const MAX_LOG_ENTRIES = 200;

/** Push one log line, trimming the oldest entries past the cap. */
export function pushLogEntry(entries: string[], entry: string, max = MAX_LOG_ENTRIES): string[] {
  entries.push(entry);
  if (entries.length > max) entries.splice(0, entries.length - max);
  return entries;
}

function track(page: Page, cfg: BrowserConfig): void {
  consoleBuf.set(page, []);
  networkBuf.set(page, []);
  page.setDefaultNavigationTimeout(cfg.navigationTimeoutMs);
  page.on("console", (m: ConsoleMessage) => {
    const buf = consoleBuf.get(page);
    if (buf) pushLogEntry(buf, `[${m.type()}] ${m.text()}`);
  });
  page.on("requestfinished", async (req) => {
    try {
      const res = await req.response();
      const buf = networkBuf.get(page);
      if (buf) pushLogEntry(buf, `${req.method()} ${res?.status() ?? "?"} ${req.url()}`);
    } catch {
      /* response unavailable */
    }
  });
  page.on("requestfailed", (req) => {
    const buf = networkBuf.get(page);
    if (buf) pushLogEntry(buf, `${req.method()} FAILED ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
  });
}

async function ensure(cfg: BrowserConfig): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({ headless: cfg.headless });
  const created = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height } });
  // Install the route before publishing the module-level context: if registration fails,
  // the tool must not keep browsing through a context with no host guard at all.
  try {
    await created.route("**/*", makeRouteHandler(guardOf(cfg)));
  } catch (err) {
    await created.close().catch(() => {});
    await browser.close().catch(() => {});
    browser = null;
    context = null;
    throw new Error(`cannot enforce the network host guard in this browser build: ${err instanceof Error ? err.message : err}`);
  }
  context = created;
  const page = await context.newPage();
  track(page, cfg);
  activeIndex = 0;
  return context;
}

function page(): Page {
  const pages = context!.pages();
  if (!pages.length) throw new Error("no open pages");
  return pages[activeIndex] ?? pages[pages.length - 1];
}

/** The host policy applied to every navigation and every page-initiated request. */
export function guardOf(cfg: BrowserConfig): HttpUrlOptions {
  return { allowPrivateNetwork: cfg.allowPrivateNetwork, allowLoopback: cfg.allowLoopback };
}

/** Route handler for the shared context: covers subresources, JS-driven redirects and
 *  popups, i.e. the requests a page makes that no tool argument ever named. Only http(s)
 *  is consulted — `data:`/`blob:` have no host to classify and cannot be re-issued. */
export function makeRouteHandler(guard: HttpUrlOptions): (route: Route) => Promise<void> {
  return async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const decision = await decideSubresource(url, guard);
    if (decision === "abort") {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };
}

/** Navigate with the host validated both before the request and on the live frames after it,
 *  so a public URL that redirects to a private/link-local host, or a hostname that answers
 *  with an internal address, is rejected and the landed page is cleared. */
async function gotoAllowed(target: Page, url: string, cfg: BrowserConfig): Promise<void> {
  const guard = guardOf(cfg);
  await target.goto(await assertSafeHttpUrl(url, guard), { waitUntil: "domcontentloaded" });
  await assertFrameTargetsSafe(target, guard);
}

/** Anything `page()` can hand back: its live frames plus a way to clear them. */
export interface FrameSafeTarget {
  frames(): Array<{ url(): string }>;
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
}

/** Playwright calls a route handler for the FIRST url of a redirect chain only, so a server-side
 *  redirect can land a page or iframe on a host the guard already rejected and the route never
 *  sees the second leg. Every read therefore re-checks the live frame URLs and clears the page
 *  before its content can be returned. */
export async function assertFrameTargetsSafe(target: FrameSafeTarget, guard: HttpUrlOptions): Promise<void> {
  let failure: Error | undefined;
  for (const frame of target.frames()) {
    const url = frame.url();
    if (!/^https?:/i.test(url)) continue; // about:blank, data:, blob:, empty: no host to classify
    try {
      await assertSafeHttpUrl(url, guard);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      break;
    }
  }
  if (failure) {
    await target.goto("about:blank", { timeout: 5000 }).catch(() => {});
    throw new Error(`${failure.message} (page cleared)`);
  }
}

/** Actions whose result is derived from, or acts upon, a page that is already open. */
const PAGE_BOUND_ACTIONS = new Set([
  "navigate",
  "snapshot",
  "extract",
  "screenshot",
  "click",
  "fill",
  "hover",
  "press",
  "select",
  "evaluate",
  "console",
  "network",
  "wait_for",
  "resize",
]);

export interface BrowserActionResult {
  text: string;
  file?: string;
}

export interface BrowserParams {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  values?: string[];
  script?: string;
  path?: string;
  index?: number;
  fullPage?: boolean;
  timeoutMs?: number;
  width?: number;
  height?: number;
}

let last: Promise<unknown> = Promise.resolve();
/** Serialize state-mutating browser work: a single shared context cannot service
 *  concurrent tool calls safely (activeIndex, page(), ensure() all race). Each new
 *  action is queued behind the previous one, and failures never break the chain. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = last.then(task, task);
  last = run.then(() => undefined, () => undefined);
  return run;
}

export function runAction(p: BrowserParams, cfg: BrowserConfig): Promise<BrowserActionResult> {
  return serialize(() => runActionInternal(p, cfg));
}

async function runActionInternal(p: BrowserParams, cfg: BrowserConfig): Promise<BrowserActionResult> {
  if (p.action === "close") {
    await closeBrowserInternal();
    return { text: "Browser closed." };
  }

  const ctx = await ensure(cfg);
  // A page can only have been landed on a blocked host through a path the route handler never
  // saw (redirect chain, history, script). Re-check before touching or reading it.
  if (PAGE_BOUND_ACTIONS.has(p.action)) await assertFrameTargetsSafe(page(), guardOf(cfg));

  switch (p.action) {
    case "navigate": {
      const url = p.url ?? "";
      if (url === "back" || url === "forward") {
        // Playwright returns null (no throw) when history is exhausted; report it
        // clearly instead of silently returning the unchanged page.
        const moved = url === "back" ? await page().goBack() : await page().goForward();
        if (!moved) return { text: `(no history to go ${url})` };
        return { text: `${page().url()} — ${await page().title()}` };
      }
      if (url === "reload") await page().reload();
      else if (url) await gotoAllowed(page(), url, cfg);
      else throw new Error("navigate requires url (or back|forward|reload)");
      return { text: `${page().url()} — ${await page().title()}` };
    }
    case "snapshot": {
      const tree = await page().locator("body").ariaSnapshot();
      return { text: tree || "(empty snapshot)" };
    }
    case "extract": {
      const selector = p.selector;
      let html: string;
      if (selector) {
        const loc = page().locator(selector);
        const count = await loc.count();
        if (count === 0) return { text: `(no elements match "${selector}")` };
        if (count > 1) {
          throw new Error(`extract selector "${selector}" matched ${count} elements; use a more specific selector`);
        }
        html = await loc.evaluate((el: Element) => el.outerHTML);
      } else {
        html = await page().content();
      }
      const { markdown } = extractMarkdown(html, { raw: Boolean(selector) });
      return { text: markdown || "(empty extraction)" };
    }
    case "screenshot": {
      const file = safeScreenshotPath(p.path ?? `opl-browser-${Date.now()}.png`);
      await page().screenshot({ path: file, fullPage: p.fullPage ?? false });
      return { text: `Screenshot saved to ${file}`, file };
    }
    case "click": {
      if (!p.selector) throw new Error("click requires selector");
      await page().click(p.selector);
      return { text: `Clicked ${p.selector}` };
    }
    case "fill": {
      if (!p.selector || p.text == null) throw new Error("fill requires selector and text");
      await page().fill(p.selector, p.text);
      return { text: `Filled ${p.selector}` };
    }
    case "hover": {
      if (!p.selector) throw new Error("hover requires selector");
      await page().hover(p.selector);
      return { text: `Hovered ${p.selector}` };
    }
    case "press": {
      if (!p.key) throw new Error("press requires key");
      await page().keyboard.press(p.key);
      return { text: `Pressed ${p.key}` };
    }
    case "select": {
      if (!p.selector || !p.values?.length) throw new Error("select requires selector and values");
      const picked = await page().selectOption(p.selector, p.values);
      return { text: `Selected ${picked.join(", ")} in ${p.selector}` };
    }
    case "evaluate": {
      if (!p.script) throw new Error("evaluate requires script");
      const value = await page().evaluate(p.script);
      if (value === undefined) return { text: "(undefined result)" };
      return { text: typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "(undefined result)") };
    }
    case "console": {
      const msgs = consoleBuf.get(page()) ?? [];
      const suffix = msgs.length >= MAX_LOG_ENTRIES ? `\n… (showing last ${MAX_LOG_ENTRIES} entries)` : "";
      return { text: msgs.length ? msgs.join("\n") + suffix : "(no console messages)" };
    }
    case "network": {
      const reqs = networkBuf.get(page()) ?? [];
      const suffix = reqs.length >= MAX_LOG_ENTRIES ? `\n… (showing last ${MAX_LOG_ENTRIES} requests)` : "";
      return { text: reqs.length ? reqs.join("\n") + suffix : "(no network requests)" };
    }
    case "wait_for": {
      const timeout = p.timeoutMs ?? cfg.navigationTimeoutMs;
      if (p.selector) await page().waitForSelector(p.selector, { timeout });
      else if (p.text) await page().getByText(p.text).first().waitFor({ timeout });
      else throw new Error("wait_for requires selector or text");
      return { text: `Condition met` };
    }
    case "pages": {
      const list = ctx.pages().map((pg, i) => `${i === activeIndex ? "*" : " "} [${i}] ${pg.url()}`);
      return { text: list.join("\n") || "(no pages)" };
    }
    case "new_page": {
      const pg = await ctx.newPage();
      track(pg, cfg);
      activeIndex = ctx.pages().length - 1;
      if (p.url) await gotoAllowed(pg, p.url, cfg);
      return { text: `Opened page [${activeIndex}] ${pg.url()}` };
    }
    case "select_page": {
      const i = p.index ?? 0;
      if (i < 0 || i >= ctx.pages().length) throw new Error(`no page at index ${i}`);
      activeIndex = i;
      await assertFrameTargetsSafe(page(), guardOf(cfg));
      return { text: `Selected page [${i}] ${page().url()}` };
    }
    case "close_page": {
      const i = p.index ?? activeIndex;
      const pages = ctx.pages();
      if (i < 0 || i >= pages.length) throw new Error(`no page at index ${i}`);
      await pages[i].close();
      activeIndex = Math.max(0, ctx.pages().length - 1);
      return { text: `Closed page [${i}]` };
    }
    case "resize": {
      if (p.width == null || p.height == null) throw new Error("resize requires width and height");
      await page().setViewportSize({ width: p.width, height: p.height });
      return { text: `Resized to ${p.width}x${p.height}` };
    }
    default:
      throw new Error(`unknown action: ${p.action}`);
  }
}

export function closeBrowser(): Promise<void> {
  return serialize(closeBrowserInternal);
}

async function closeBrowserInternal(): Promise<void> {
  try {
    await context?.close();
    await browser?.close();
  } catch {
    /* already gone */
  }
  context = null;
  browser = null;
  activeIndex = 0;
}
