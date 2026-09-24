import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatTokens, withIcon } from "../extensions/opl-footer/segments/helpers.ts";
import { formatMs, sessionStatsSegment } from "../extensions/opl-footer/segments/session-stats.ts";
import { renderSegment } from "../extensions/opl-footer/segments/index.ts";
import * as statusSegmentModule from "../extensions/opl-footer/segments/status.ts";
import * as contextSegmentModule from "../extensions/opl-footer/segments/context.ts";
import { modeSwitcherSegment } from "../extensions/opl-footer/segments/mode-switcher.ts";
import { nextTabIndex, restoreSelectedItem } from "../extensions/opl-footer/configure-navigation.ts";
import { applyColor, resolveColorToRgb } from "../extensions/opl-footer/theme.ts";
import { getLayoutSegments, hasSegmentSeparator, moveLayoutSegment, setLayoutSegment, setSegmentSeparator } from "../extensions/opl-footer/config.ts";

test("malformed colors render uncolored with no escape sequence at all", () => {
  const theme = { fg: (color) => { throw new Error(`unknown theme color: ${color}`); } };
  // A bad hex used to emit an empty color plus a stray reset; a bad token used to throw.
  for (const bad of ["#nope", "#12345", "#", "notatoken"]) {
    assert.equal(applyColor(theme, bad, "text"), "text", `no escape for ${bad}`);
    assert.ok(!applyColor(theme, bad, "text").includes("\x1b"), `silent for ${bad}`);
    assert.equal(resolveColorToRgb(theme, bad), null, `no rgb for ${bad}`);
  }
  // The #abc shorthand expands to the same RGB as #aabbcc.
  assert.deepEqual(resolveColorToRgb(theme, "#abc"), { r: 0xaa, g: 0xbb, b: 0xcc });
  assert.equal(applyColor(theme, "#abc", "x"), "\x1b[38;2;170;187;204mx\x1b[0m");
});

test("session_stats renders prompts, api calls, and tool calls", () => {
  const ctx = { theme: { fg: (_c, s) => s }, sessionStats: { prompts: 2, apiCalls: 31, toolCalls: 48, llmMs: 0, toolMs: 0, ttftSamples: [], lastTurnaroundMs: 0 } };
  const seg = sessionStatsSegment.render(ctx);
  assert.equal(seg.visible, true);
  assert.match(seg.content, /2 prompts.*31 api calls.*48 tool calls/s);
  assert.equal(sessionStatsSegment.render({ ...ctx, sessionStats: { ...ctx.sessionStats, prompts: 0 } }).visible, false);
});

test("renders each agent status with its theme color", () => {
  const ctx = { theme: { fg: (color, text) => `[${color}]${text}` } };
  assert.deepEqual(renderSegment("status", { ...ctx, agentStatus: "working" }), { content: "[accent]Working", visible: true });
  assert.deepEqual(renderSegment("status", { ...ctx, agentStatus: "waiting" }), { content: "[warning]Waiting", visible: true });
  assert.deepEqual(renderSegment("status", { ...ctx, agentStatus: "ready" }), { content: "[success]Ready", visible: true });
});

test("context_pct renders an explicit unknown state when usage is unavailable", () => {
  const ctx = { theme: { fg: (_c, s) => s }, colors: {}, options: {}, contextPercent: null, contextWindow: 128000 };
  const seg = renderSegment("context_pct", ctx);
  assert.equal(seg.visible, true);
  assert.equal(seg.content, "(--%)");
});

test("context_pct renders a percentage when usage is known", () => {
  const ctx = { theme: { fg: (_c, s) => s }, colors: {}, options: {}, contextPercent: 42.5, contextWindow: 128000 };
  const seg = renderSegment("context_pct", ctx);
  assert.equal(seg.visible, true);
  assert.match(seg.content, /\(42\.50%\)/, "shows the percentage and tokens");
});

test("context_pct marks estimated usage as approximate", () => {
  const ctx = { theme: { fg: (_c, s) => s }, colors: {}, options: {}, contextPercent: 42.5, contextWindow: 128000, contextEstimated: true };
  const seg = renderSegment("context_pct", ctx);
  assert.equal(seg.visible, true);
  assert.match(seg.content, /≈42\.50%/, "labels the percentage as an estimate");
});

test("estimates post-compaction usage from projected messages", () => {
  const messages = [
    { role: "system", content: "a".repeat(40) },
    { role: "user", content: "b".repeat(40) },
  ];
  assert.deepEqual(contextSegmentModule.estimateContextUsage(messages, 100), { tokens: 20, percent: 20 });
});

test("derives footer status from agent and parallel Pi tool lifecycles", () => {
  const tracker = statusSegmentModule.createAgentStatusTracker();
  assert.equal(tracker.status(), "ready");
  tracker.agentStarted();
  assert.equal(tracker.status(), "working");
  tracker.toolStarted("one");
  tracker.toolStarted("two");
  assert.equal(tracker.status(), "waiting");
  tracker.toolEnded("one");
  assert.equal(tracker.status(), "waiting");
  tracker.toolEnded("two");
  assert.equal(tracker.status(), "working");
  tracker.agentSettled();
  assert.equal(tracker.status(), "ready");
  tracker.toolEnded("late");
  assert.equal(tracker.status(), "ready", "a late tool-end event cannot regress the settled state");
});

test("formats footer token and duration values at display boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999", "under 1k is raw");
  assert.equal(formatTokens(1000), "1.00k", "1k boundary");
  assert.equal(formatTokens(1536), "1.54k");
  assert.equal(formatTokens(12500), "12.50k", "mid-range stays k after collapsing duplicate branches");
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

test("restores the active configurator selection after updates", () => {
  let selected = "";
  restoreSelectedItem([{ selectItem: (id) => { selected = id; } }], 0, "row1LeftSegments:model:segment");
  assert.equal(selected, "row1LeftSegments:model:segment");
});

test("renders footer helpers and mode color precedence", () => {
  assert.equal(withIcon("*", "text"), "* text");
  assert.equal(withIcon("", "text"), "text", "empty icon omits the space");
  assert.equal(contextSegmentModule.lerp(0, 100, 0), 0, "t=0 returns start");
  assert.equal(contextSegmentModule.lerp(0, 100, 1), 100, "t=1 returns end");
  assert.equal(contextSegmentModule.lerp(0, 100, 0.5), 50, "midpoint");
  assert.equal(contextSegmentModule.lerp(0, 10, 0.25), 3, "rounds (2.5 -> 3)");
  assert.equal(contextSegmentModule.lerp(0xf2, 0xd6, 1), 0xd6, "color channel interpolation");

  const theme = { fg: (color, text) => `[${color}]${text}` };
  const segmentCtx = { theme, config: { colors: {} } };
  globalThis.__agentMode = { mode: "research", appearance: { modeColor: "warning" } };
  assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [warning]Research", "custom modeColor wins");
  globalThis.__agentMode = { mode: "research" };
  assert.equal(modeSwitcherSegment.render(segmentCtx).content, "[dim]Mode: [muted]Research", "falls back to hardcoded muted");
  delete globalThis.__agentMode;
});

test("git probes back off outside a repository and recover on invalidation", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "opl-norepo-"));
  const log = join(dir, "calls.log");
  // Stand-in git that always fails like a non-repository does, and records what it was asked.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$OPL_GIT_LOG\"\nexit 128\n");
  chmodSync(join(bin, "git"), 0o755);

  const prevCwd = process.cwd();
  const prevPath = process.env.PATH;
  const prevLog = process.env.OPL_GIT_LOG;
  process.chdir(dir);
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.OPL_GIT_LOG = log;
  const calls = () => (readFileSync(log, "utf8").match(/\n/g) || []).length;

  const settle = () => new Promise((r) => setTimeout(r, 300));
  let git;

  try {
    git = await import("../extensions/opl-footer/git-status.ts");
    let fakeNow = 0;
    git.setClock(() => fakeNow);

    // First probe from a non-repository armed the 30s back-off.
    git.getGitStatus(null);
    await settle();
    await settle();
    const burst = calls();
    assert.ok(burst >= 1, "expected at least one git call");

    // Within the back-off window, no amount of rendering re-probes.
    for (let i = 0; i < 6; i++) {
      fakeNow += 3_000;
      git.getGitStatus(null);
    }
    assert.equal(calls(), burst, "back-off suppresses probes within its window");

    // Past the window the back-off expires and probing resumes.
    fakeNow += 29_000;
    git.getGitStatus(null);
    await settle();
    assert.ok(calls() > burst, "an expired back-off re-probes");

    // Invalidation clears the back-off so a just-created repo is re-discovered.
    const afterExpiry = calls();
    git.invalidateGitStatus();
    fakeNow += 1;
    git.getGitStatus(null);
    await settle();
    assert.ok(calls() > afterExpiry, "invalidation clears the back-off");
  } finally {
    git?.setClock();
    process.chdir(prevCwd);
    process.env.PATH = prevPath;
    if (prevLog === undefined) delete process.env.OPL_GIT_LOG;
    else process.env.OPL_GIT_LOG = prevLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
