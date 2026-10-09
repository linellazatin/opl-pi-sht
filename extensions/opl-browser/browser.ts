import { chromium, type Browser, type BrowserContext, type Page, type Route, type ConsoleMessage } from "playwright";
import { extractMarkdown } from "./extract.js";
import { assertSafeHttpUrl, decideSubresource, discardEmptyFile, safeScreenshotPath, type HttpUrlOptions } from "./validate.js";
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
  const created = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    // Playwright documents that routing does not see requests a service worker already
    // intercepted, so a worker would be a hole in the guard rather than another client of it.
    serviceWorkers: "block",
  });
  // Install the guards before publishing the module-level context: if registration fails, the tool
  // must not keep browsing through a context whose host guard is missing or only half installed.
  try {
    const wsGuarded = await installGuard(created, guardOf(cfg));
    if (!wsGuarded) console.warn("[opl-browser] this build cannot intercept page WebSockets, so ws:// and wss:// from the page are unguarded");
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

/** Which page an action acts on. A stale or out-of-range selection is an error, never a silent
 *  retarget: `context.pages()` is creation order, so the index a previous `pages` call showed is
 *  the page the model means - unless something closed it, which is exactly when guessing the last
 *  page would navigate or screenshot the wrong document. */
export function resolvePageIndex(active: number, count: number, requested?: number): number {
  if (count === 0) throw new Error("no open pages");
  const i = requested ?? active;
  if (!Number.isInteger(i) || i < 0 || i >= count) {
    throw new Error(`no page at index ${i} (${count} page${count === 1 ? "" : "s"} open; use \`pages\` to list them)`);
  }
  return i;
}

/** The selection after closing `closed` from `count` pages: keep the same page when the closed one
 *  was before it (indices shift down), otherwise fall to the nearest surviving page. */
export function indexAfterClose(active: number, closed: number, count: number): number {
  const remaining = count - 1;
  if (remaining <= 0) return 0;
  if (closed < active) return active - 1;
  if (closed === active) return Math.min(active, remaining - 1);
  return active;
}

/** The page for the current action: an explicit `index` argument wins, otherwise the selection. */
function pageAt(requested?: number): Page {
  const pages = context!.pages();
  return pages[resolvePageIndex(activeIndex, pages.length, requested)]!;
}

/** Budget for one DNS round-trip. Playwright has no timeout of its own on a route handler, so a
 *  stalled getaddrinfo would hold the navigation open; the guard cuts it instead. */
const DNS_BUDGET_MS = 5000;

/** The host policy applied to every navigation, frame re-check, page request and WebSocket. */
export function guardOf(cfg: BrowserConfig): HttpUrlOptions {
  return {
    allowPrivateNetwork: cfg.allowPrivateNetwork,
    allowLoopback: cfg.allowLoopback,
    dnsTimeoutMs: DNS_BUDGET_MS,
  };
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

/** Install both halves of the network guard on a context: http(s) requests and WebSocket
 *  handshakes. Returns false when this Playwright build cannot intercept WebSockets, which is
 *  reported rather than hidden: `route()` does not see `ws://`/`wss://`, so a page could otherwise
 *  open a socket straight to an internal service while the tool claims the boundary is enforced. */
export interface GuardTarget {
  // `unknown` rather than `void`: Playwright's route registration hands back a Disposable, and a
  // BrowserContext returns that where a Page returns void, so `void` would exclude contexts.
  route(url: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
  routeWebSocket?(match: (url: URL) => boolean, handler: (ws: WebSocketRouteLike) => Promise<void>): Promise<unknown>;
}

export interface WebSocketRouteLike {
  url(): string;
  close(): Promise<void>;
  connectToServer(): unknown;
}

/** WebSockets are classified with the http(s) policy: `ws:` counts as `http:`, `wss:` as `https:`.
 *  Anything the guard refuses, and anything it cannot classify, is closed. */
export function makeWebSocketGuard(guard: HttpUrlOptions): (ws: WebSocketRouteLike) => Promise<void> {
  return async (ws) => {
    const asHttp = ws.url().replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    let decision: "abort" | "continue";
    try {
      decision = await decideSubresource(asHttp, guard);
    } catch {
      decision = "abort";
    }
    if (decision === "abort") {
      await ws.close().catch(() => {});
      return;
    }
    ws.connectToServer();
  };
}

export async function installGuard(ctx: GuardTarget, guard: HttpUrlOptions): Promise<boolean> {
  await ctx.route("**/*", makeRouteHandler(guard));
  if (typeof ctx.routeWebSocket !== "function") return false;
  await ctx.routeWebSocket(() => true, makeWebSocketGuard(guard));
  return true;
}

/** Navigate with the host validated both before the request and on the live frames after it,
 *  so a public URL that redirects to a private/link-local host, or a hostname that answers
 *  with an internal address, is rejected and the landed page is cleared. */
async function gotoAllowed(target: Page, url: string, cfg: BrowserConfig): Promise<void> {
  const guard = guardOf(cfg);
  await target.goto(await assertSafeHttpUrl(url, guard), { waitUntil: "domcontentloaded" });
  await assertFrameTargetsSafe(target, guard);
}

/** Anything `pageAt()` can hand back: its live frames plus a way to clear them. */
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
 *  concurrent tool calls safely (activeIndex, pageAt(), ensure() all race). Each new
 *  action is queued behind the previous one, and failures never break the chain. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = last.then(task, task);
  last = run.then(() => undefined, () => undefined);
  return run;
}

/** `cwd` is the session directory from `ExtensionContext`, never `process.cwd()`: a screenshot
 *  name that arrives from the model has to be contained against the project the user is in, and
 *  the harness working directory is not that directory. */
export function runAction(p: BrowserParams, cfg: BrowserConfig, cwd: string): Promise<BrowserActionResult> {
  return serialize(() => runActionInternal(p, cfg, cwd));
}

async function runActionInternal(p: BrowserParams, cfg: BrowserConfig, cwd: string): Promise<BrowserActionResult> {
  if (p.action === "close") {
    await closeBrowserInternal();
    return { text: "Browser closed." };
  }

  const ctx = await ensure(cfg);
  const target = () => pageAt(p.index);
  // A page can only have been landed on a blocked host through a path the route handler never
  // saw (redirect chain, history, script). Re-check before touching or reading it.
  if (PAGE_BOUND_ACTIONS.has(p.action)) await assertFrameTargetsSafe(target(), guardOf(cfg));

  switch (p.action) {
    case "navigate": {
      const url = p.url ?? "";
      if (url === "back" || url === "forward") {
        // Playwright returns null (no throw) when history is exhausted; report it
        // clearly instead of silently returning the unchanged page.
        const moved = url === "back" ? await target().goBack() : await target().goForward();
        if (!moved) return { text: `(no history to go ${url})` };
        return { text: `${target().url()} — ${await target().title()}` };
      }
      if (url === "reload") await target().reload();
      else if (url) await gotoAllowed(target(), url, cfg);
      else throw new Error("navigate requires url (or back|forward|reload)");
      return { text: `${target().url()} — ${await target().title()}` };
    }
    case "snapshot": {
      const tree = await target().locator("body").ariaSnapshot();
      return { text: tree || "(empty snapshot)" };
    }
    case "extract": {
      const selector = p.selector;
      let html: string;
      if (selector) {
        const loc = target().locator(selector);
        const count = await loc.count();
        if (count === 0) return { text: `(no elements match "${selector}")` };
        if (count > 1) {
          throw new Error(`extract selector "${selector}" matched ${count} elements; use a more specific selector`);
        }
        html = await loc.evaluate((el: Element) => el.outerHTML);
      } else {
        html = await target().content();
      }
      const { markdown } = extractMarkdown(html, { raw: Boolean(selector) });
      return { text: markdown || "(empty extraction)" };
    }
    case "screenshot": {
      const file = safeScreenshotPath(p.path ?? `opl-browser-${Date.now()}.png`, cwd);
      try {
        await target().screenshot({ path: file, fullPage: p.fullPage ?? false });
      } catch (err) {
        // The reservation above created an empty file; a capture that threw must not leave it.
        discardEmptyFile(file);
        throw err;
      }
      return { text: `Screenshot saved to ${file}`, file };
    }
    case "click": {
      if (!p.selector) throw new Error("click requires selector");
      await target().click(p.selector);
      return { text: `Clicked ${p.selector}` };
    }
    case "fill": {
      if (!p.selector || p.text == null) throw new Error("fill requires selector and text");
      await target().fill(p.selector, p.text);
      return { text: `Filled ${p.selector}` };
    }
    case "hover": {
      if (!p.selector) throw new Error("hover requires selector");
      await target().hover(p.selector);
      return { text: `Hovered ${p.selector}` };
    }
    case "press": {
      if (!p.key) throw new Error("press requires key");
      await target().keyboard.press(p.key);
      return { text: `Pressed ${p.key}` };
    }
    case "select": {
      if (!p.selector || !p.values?.length) throw new Error("select requires selector and values");
      const picked = await target().selectOption(p.selector, p.values);
      return { text: `Selected ${picked.join(", ")} in ${p.selector}` };
    }
    case "evaluate": {
      if (!p.script) throw new Error("evaluate requires script");
      const value = await target().evaluate(p.script);
      if (value === undefined) return { text: "(undefined result)" };
      return { text: typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "(undefined result)") };
    }
    case "console": {
      const msgs = consoleBuf.get(target()) ?? [];
      const suffix = msgs.length >= MAX_LOG_ENTRIES ? `\n… (showing last ${MAX_LOG_ENTRIES} entries)` : "";
      return { text: msgs.length ? msgs.join("\n") + suffix : "(no console messages)" };
    }
    case "network": {
      const reqs = networkBuf.get(target()) ?? [];
      const suffix = reqs.length >= MAX_LOG_ENTRIES ? `\n… (showing last ${MAX_LOG_ENTRIES} requests)` : "";
      return { text: reqs.length ? reqs.join("\n") + suffix : "(no network requests)" };
    }
    case "wait_for": {
      const timeout = p.timeoutMs ?? cfg.navigationTimeoutMs;
      if (p.selector) await target().waitForSelector(p.selector, { timeout });
      else if (p.text) await target().getByText(p.text).first().waitFor({ timeout });
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
      // Select the page that was actually created; `pages()` order is creation order but a popup
      // from another page can land in the same tick, so ask instead of assuming it is last.
      const created = ctx.pages().indexOf(pg);
      activeIndex = created < 0 ? ctx.pages().length - 1 : created;
      if (p.url) await gotoAllowed(pg, p.url, cfg);
      return { text: `Opened page [${activeIndex}] ${pg.url()}` };
    }
    case "select_page": {
      const i = resolvePageIndex(activeIndex, ctx.pages().length, p.index ?? 0);
      activeIndex = i;
      await assertFrameTargetsSafe(pageAt(), guardOf(cfg));
      return { text: `Selected page [${i}] ${pageAt().url()}` };
    }
    case "close_page": {
      const pages = ctx.pages();
      const i = resolvePageIndex(activeIndex, pages.length, p.index);
      await pages[i].close();
      activeIndex = indexAfterClose(activeIndex, i, pages.length);
      return { text: `Closed page [${i}]; selection is now [${activeIndex}]${ctx.pages().length ? "" : " (no pages left)"}` };
    }
    case "resize": {
      if (p.width == null || p.height == null) throw new Error("resize requires width and height");
      await target().setViewportSize({ width: p.width, height: p.height });
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
