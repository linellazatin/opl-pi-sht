// Functional tests for opl-todo config loading. Requires Bun.
// Run: bun tests/opl-todo-config.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTodoConfig, TODO_DEFAULT_CONFIG } from "../extensions/opl-todo/config.ts";

const dir = mkdtempSync(join(tmpdir(), "opl-todo-"));
const write = (obj) => {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
};

// Missing file -> defaults
assert.deepEqual(loadTodoConfig(join(dir, "nope.json")), TODO_DEFAULT_CONFIG);

// Invalid JSON -> defaults
assert.deepEqual(loadTodoConfig(write("{ not json")), TODO_DEFAULT_CONFIG);

// Valid overrides applied
const cfg = loadTodoConfig(write({
  allDoneHideMs: 1000,
  shortcuts: { toggleWidget: "ctrl+x", resetDone: "ctrl+y" },
  widget: { widthPercent: 50, maxHeightPercent: 40, minWidth: 25 },
}));
assert.equal(cfg.allDoneHideMs, 1000);
assert.equal(cfg.shortcuts.toggleWidget, "ctrl+x");
assert.equal(cfg.widget.widthPercent, 50);
assert.equal(cfg.widget.minWidth, 25);

// Out-of-range / wrong-type values fall back per-field
const clamped = loadTodoConfig(write({
  allDoneHideMs: -5,               // negative -> default
  shortcuts: { toggleWidget: 123 }, // wrong type -> default
  widget: { widthPercent: 0, maxHeightPercent: 200, minWidth: 10 }, // 0, >100, <20 -> defaults
}));
assert.equal(clamped.allDoneHideMs, TODO_DEFAULT_CONFIG.allDoneHideMs);
assert.equal(clamped.shortcuts.toggleWidget, TODO_DEFAULT_CONFIG.shortcuts.toggleWidget);
assert.equal(clamped.widget.widthPercent, TODO_DEFAULT_CONFIG.widget.widthPercent);
assert.equal(clamped.widget.maxHeightPercent, TODO_DEFAULT_CONFIG.widget.maxHeightPercent);
assert.equal(clamped.widget.minWidth, TODO_DEFAULT_CONFIG.widget.minWidth);

// allDoneHideMs = 0 is valid (>= 0)
assert.equal(loadTodoConfig(write({ allDoneHideMs: 0 })).allDoneHideMs, 0);

console.log("opl-todo config tests passed");
