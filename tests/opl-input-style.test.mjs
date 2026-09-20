import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolveModeStyle } from "../extensions/opl-input/mode-style.ts";
import * as inputUtils from "../extensions/opl-input/utils.ts";

test("resolves built-in mode styles", () => {
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "off" }), { borderColor: "border", prefixColor: "accent", prefix: "❯" });
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "chat" }), { borderColor: "borderAccent", prefixColor: "borderAccent", prefix: "»" });
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "plan" }), { borderColor: "customMessageLabel", prefixColor: "customMessageLabel", prefix: "⏸" });
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "execute" }), { borderColor: "customMessageLabel", prefixColor: "customMessageLabel", prefix: "⏸" });
});

test("input colors: bad hex stays uncolored, bad token falls back to border", () => {
  const theme = {
    fg: (color, text) => {
      if (color !== "border") throw new Error(`unknown theme color: ${color}`);
      return `[border]${text}`;
    },
  };
  assert.equal(inputUtils.applyColor(theme, "#nope", "x"), "x", "malformed hex emits no escape at all");
  assert.ok(!inputUtils.applyColor(theme, "#nope", "x").includes("\x1b"));
  assert.equal(inputUtils.applyColor(theme, "#abc", "x"), "\x1b[38;2;170;187;204mx\x1b[0m", "shorthand expands");
  assert.equal(inputUtils.applyColor(theme, "nope", "x"), "[border]x", "unknown token falls back to border");
});

test("stops the input render timer when the editor is disposed", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let cleared;
  globalThis.setInterval = () => 42;
  globalThis.clearInterval = (timer) => { cleared = timer; };
  try {
    inputUtils.startRenderTimer(() => {})();
    assert.equal(cleared, 42);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("honors appearance overrides while bash retains precedence", () => {
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "chat", appearance: { prefix: "󰭻", prefixColor: "#157cd6", borderColor: "#157cd6" } }), { borderColor: "#157cd6", prefixColor: "#157cd6", prefix: "󰭻" });
  assert.deepEqual(resolveModeStyle({ bash: false, mode: "research", appearance: { prefixColor: "warning" } }), { borderColor: "border", prefixColor: "warning", prefix: "❯" });
  assert.equal(resolveModeStyle({ bash: true, mode: "research", appearance: { prefixColor: "warning" } }).prefixColor, "bashMode");
});

test("the shared render timer honors its period and stops on dispose", async () => {
  let ticks = 0;
  const stop = inputUtils.startRenderTimer(() => { ticks++; }, 40);
  await new Promise((r) => setTimeout(r, 160));
  const seen = ticks;
  stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(seen >= 2, `a 40ms period should keep ticking, saw ${seen}`);
  assert.equal(ticks, seen, "the returned disposer clears the interval");
  assert.equal(inputUtils.COMPANION_TICK_MS, 100, "companion cadence");
  assert.equal(inputUtils.IDLE_REPAINT_MS, 1000, "idle cadence is one tenth of it");
});
