import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatTokens, withIcon } from "../extensions/opl-footer/segments/helpers.ts";
import { formatMs, sessionStatsSegment } from "../extensions/opl-footer/segments/session-stats.ts";
import { lerp } from "../extensions/opl-footer/segments/context.ts";
import { modeSwitcherSegment } from "../extensions/opl-footer/segments/mode-switcher.ts";
import { nextTabIndex } from "../extensions/opl-footer/configure-navigation.ts";
import { getLayoutSegments, hasSegmentSeparator, moveLayoutSegment, setLayoutSegment, setSegmentSeparator } from "../extensions/opl-footer/config.ts";

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

test("updates one footer layout while preserving retained config entries", () => {
  const config = {
    row1LeftSegments: ["model", "text:keep", "path", "mystery"],
    colors: { model: "#c07898" },
  };

  const hidden = setLayoutSegment(config, "row1LeftSegments", "path", false);
  assert.deepEqual(hidden.row1LeftSegments, ["model", "text:keep", "mystery"]);
  assert.deepEqual(hidden.colors, { model: "#c07898" });

  const shown = setLayoutSegment(hidden, "row1LeftSegments", "pi", true);
  assert.deepEqual(shown.row1LeftSegments, ["pi", "model", "text:keep", "mystery"]);
  assert.equal(shown.row1LeftSegments.includes("path"), false);
});

test("uses default layouts and keeps shown segments unique", () => {
  assert.deepEqual(getLayoutSegments({}, "row2RightSegments"), ["token_total", "separator", "cost"]);
  const once = setLayoutSegment({ row2RightSegments: [] }, "row2RightSegments", "cost", true);
  const twice = setLayoutSegment(once, "row2RightSegments", "cost", true);
  assert.equal(twice.row2RightSegments.filter((segment) => segment === "cost").length, 1);
});

test("pairs a separator with its preceding visible segment", () => {
  const config = { row1LeftSegments: ["pi", "separator", "model", "separator", "path", "git"] };
  assert.deepEqual(
    setLayoutSegment(config, "row1LeftSegments", "model", false).row1LeftSegments,
    ["pi", "separator", "path", "git"],
  );
  assert.deepEqual(
    setSegmentSeparator(config, "row1LeftSegments", "pi", false).row1LeftSegments,
    ["pi", "model", "separator", "path", "git"],
  );
  assert.deepEqual(
    setSegmentSeparator(config, "row1LeftSegments", "pi", true).row1LeftSegments,
    config.row1LeftSegments,
  );
});

test("normalizes malformed footer layout values", () => {
  const malformed = { row1LeftSegments: "model" };
  assert.deepEqual(getLayoutSegments(malformed, "row1LeftSegments"), ["pi", "separator", "model", "separator", "path", "git"]);
  assert.deepEqual(
    setLayoutSegment(malformed, "row1LeftSegments", "path", false).row1LeftSegments,
    ["pi", "separator", "model", "separator", "git"],
  );
  assert.deepEqual(
    getLayoutSegments({ row1LeftSegments: [1, "model"] }, "row1LeftSegments"),
    ["pi", "separator", "model", "separator", "path", "git"],
  );
});

test("does not attribute a leading separator to an absent segment", () => {
  const config = { row1LeftSegments: ["separator", "model"] };
  assert.equal(hasSegmentSeparator(config, "row1LeftSegments", "path"), false);
  assert.deepEqual(
    setSegmentSeparator(config, "row1LeftSegments", "path", false).row1LeftSegments,
    config.row1LeftSegments,
  );
});

test("moves a segment with its trailing separator", () => {
  const config = { row1LeftSegments: ["pi", "separator", "model", "separator", "path"] };
  assert.deepEqual(
    moveLayoutSegment(config, "row1LeftSegments", "model", "up").row1LeftSegments,
    ["model", "separator", "pi", "separator", "path"],
  );
  assert.deepEqual(
    moveLayoutSegment(config, "row1LeftSegments", "model", "down").row1LeftSegments,
    ["pi", "separator", "path", "model", "separator"],
  );
  assert.deepEqual(
    moveLayoutSegment({ row1LeftSegments: ["pi", "text:fixed", "model"] }, "row1LeftSegments", "model", "up").row1LeftSegments,
    ["pi", "text:fixed", "model"],
  );
});

test("wraps footer configuration tabs in both directions", () => {
  assert.equal(nextTabIndex(0, "left", 6), 5);
  assert.equal(nextTabIndex(5, "right", 6), 0);
  assert.equal(nextTabIndex(2, "right", 6), 3);
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
