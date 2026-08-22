// Functional tests for opl-footer pure helpers. Requires Bun.
// Run: bun tests/opl-footer-helpers.test.mjs
import assert from "node:assert/strict";
import { formatTokens, withIcon } from "../extensions/opl-footer/segments/helpers.ts";
import { formatMs } from "../extensions/opl-footer/segments/session-stats.ts";
import { lerp } from "../extensions/opl-footer/segments/context.ts";
import { modeSwitcherSegment } from "../extensions/opl-footer/segments/mode-switcher.ts";

// ─── formatTokens ────────────────────────────────────────────────────────────
assert.equal(formatTokens(0), "0");
assert.equal(formatTokens(999), "999", "under 1k is raw");
assert.equal(formatTokens(1000), "1.00k", "1k boundary");
assert.equal(formatTokens(1536), "1.54k");
assert.equal(formatTokens(999999), "1000.00k", "just under 1M still k");
assert.equal(formatTokens(1000000), "1.00M", "1M boundary");
assert.equal(formatTokens(2500000), "2.50M");

// ─── withIcon ────────────────────────────────────────────────────────────────
assert.equal(withIcon("*", "text"), "* text");
assert.equal(withIcon("", "text"), "text", "empty icon omits the space");

// ─── formatMs ────────────────────────────────────────────────────────────────
assert.equal(formatMs(0), "0.0s");
assert.equal(formatMs(1500), "1.5s");
assert.equal(formatMs(59_999), "60.0s", "just under a minute stays seconds");
assert.equal(formatMs(60_000), "1m 0s", "minute boundary switches format");
assert.equal(formatMs(90_000), "1m 30s");
assert.equal(formatMs(3_661_000), "61m 1s");

// ─── lerp ────────────────────────────────────────────────────────────────────
assert.equal(lerp(0, 100, 0), 0, "t=0 returns start");
assert.equal(lerp(0, 100, 1), 100, "t=1 returns end");
assert.equal(lerp(0, 100, 0.5), 50, "midpoint");
assert.equal(lerp(0, 10, 0.25), 3, "rounds (2.5 -> 3)");
assert.equal(lerp(0xf2, 0xd6, 1), 0xd6, "color channel interpolation");

// ─── Mode indicator color precedence ───────────────────────────────────────
const theme = { fg: (color, text) => `[${color}]${text}` };
const segmentCtx = { theme, config: { colors: {} } };
globalThis.__agentMode = { mode: "research", appearance: { modeColor: "warning" } };
assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [warning]Research", "custom modeColor wins");
globalThis.__agentMode = { mode: "research" };
assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [muted]Research", "falls back to hardcoded muted");

delete globalThis.__agentMode;

console.log("opl-footer helper tests passed");
