import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage } from "playwright";
import type { BrowserConfig } from "./config.js";

// ponytail: single module-level Chromium instance reused across tool calls.
// One browser per session is enough; add contexts only if parallel isolation matters.
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let activeIndex = 0;

const consoleBuf = new WeakMap<Page, string[]>();
const networkBuf = new WeakMap<Page, string[]>();

function track(page: Page, cfg: BrowserConfig): void {
  consoleBuf.set(page, []);
  networkBuf.set(page, []);
  page.setDefaultNavigationTimeout(cfg.navigationTimeoutMs);
  page.on("console", (m: ConsoleMessage) => consoleBuf.get(page)?.push(`[${m.type()}] ${m.text()}`));
  page.on("requestfinished", async (req) => {
    try {
      const res = await req.response();
      networkBuf.get(page)?.push(`${req.method()} ${res?.status() ?? "?"} ${req.url()}`);
    } catch {
      /* response unavailable */
    }
  });
  page.on("requestfailed", (req) =>
    networkBuf.get(page)?.push(`${req.method()} FAILED ${req.url()} (${req.failure()?.errorText ?? "unknown"})`),
  );
}

async function ensure(cfg: BrowserConfig): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({ headless: cfg.headless });
  context = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height } });
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

export async function runAction(p: BrowserParams, cfg: BrowserConfig): Promise<BrowserActionResult> {
  if (p.action === "close") {
    await closeBrowser();
    return { text: "Browser closed." };
  }

  const ctx = await ensure(cfg);

  switch (p.action) {
    case "navigate": {
      const url = p.url ?? "";
      if (url === "back") { await page().goBack(); }
      else if (url === "forward") { await page().goForward(); }
      else if (url === "reload") { await page().reload(); }
      else if (url) { await page().goto(url, { waitUntil: "domcontentloaded" }); }
      else throw new Error("navigate requires url (or back|forward|reload)");
      return { text: `${page().url()} — ${await page().title()}` };
    }
    case "snapshot": {
      const tree = await page().locator("body").ariaSnapshot();
      return { text: tree || "(empty snapshot)" };
    }
    case "screenshot": {
      const file = p.path ?? `opl-browser-${Date.now()}.png`;
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
      return { text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
    }
    case "console": {
      const msgs = consoleBuf.get(page()) ?? [];
      return { text: msgs.length ? msgs.join("\n") : "(no console messages)" };
    }
    case "network": {
      const reqs = networkBuf.get(page()) ?? [];
      return { text: reqs.length ? reqs.join("\n") : "(no network requests)" };
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
      if (p.url) await pg.goto(p.url, { waitUntil: "domcontentloaded" });
      return { text: `Opened page [${activeIndex}] ${pg.url()}` };
    }
    case "select_page": {
      const i = p.index ?? 0;
      if (i < 0 || i >= ctx.pages().length) throw new Error(`no page at index ${i}`);
      activeIndex = i;
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

export async function closeBrowser(): Promise<void> {
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
