import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatTokens, withIcon } from "../extensions/opl-footer/segments/helpers.ts";
import { formatMs, sessionStatsSegment } from "../extensions/opl-footer/segments/session-stats.ts";
import { lerp } from "../extensions/opl-footer/segments/context.ts";
import { modeSwitcherSegment } from "../extensions/opl-footer/segments/mode-switcher.ts";

test("session_stats renders prompts, api calls, and tool calls", () => {
  const ctx = { theme: { fg: (_c, s) => s }, sessionStats: { prompts: 2, apiCalls: 31, toolCalls: 48, llmMs: 0, toolMs: 0, ttftSamples: [], lastTurnaroundMs: 0 } };
  const seg = sessionStatsSegment.render(ctx);
  assert.equal(seg.visible, true);
  assert.match(seg.content, /2 prompts.*31 api calls.*48 tool calls/s);
  assert.equal(sessionStatsSegment.render({ ...ctx, sessionStats: { ...ctx.sessionStats, prompts: 0 } }).visible, false);
});

test("formats footer token and duration values at display boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999", "under 1k is raw");
  assert.equal(formatTokens(1000), "1.00k", "1k boundary");
  assert.equal(formatTokens(1536), "1.54k");
  assert.equal(formatTokens(999999), "1000.00k", "just under 1M still k");
  assert.equal(formatTokens(1000000), "1.00M", "1M boundary");
  assert.equal(formatTokens(2500000), "2.50M");
  assert.equal(formatMs(0), "0.0s");
  assert.equal(formatMs(1500), "1.5s");
  assert.equal(formatMs(59_999), "60.0s", "just under a minute stays seconds");
  assert.equal(formatMs(60_000), "1m 0s", "minute boundary switches format");
  assert.equal(formatMs(90_000), "1m 30s");
  assert.equal(formatMs(3_661_000), "61m 1s");
});

test("renders footer helpers and mode color precedence", () => {
  assert.equal(withIcon("*", "text"), "* text");
  assert.equal(withIcon("", "text"), "text", "empty icon omits the space");
  assert.equal(lerp(0, 100, 0), 0, "t=0 returns start");
  assert.equal(lerp(0, 100, 1), 100, "t=1 returns end");
  assert.equal(lerp(0, 100, 0.5), 50, "midpoint");
  assert.equal(lerp(0, 10, 0.25), 3, "rounds (2.5 -> 3)");
  assert.equal(lerp(0xf2, 0xd6, 1), 0xd6, "color channel interpolation");

  const theme = { fg: (color, text) => `[${color}]${text}` };
  const segmentCtx = { theme, config: { colors: {} } };
  globalThis.__agentMode = { mode: "research", appearance: { modeColor: "warning" } };
  assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [warning]Research", "custom modeColor wins");
  globalThis.__agentMode = { mode: "research" };
  assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [muted]Research", "falls back to hardcoded muted");
  delete globalThis.__agentMode;
});
