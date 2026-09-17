// Functional tests for opl-todo against malformed tool results. Requires Bun.
// Regression guard: renderResult returning undefined crashed pi's TUI
// (MouseRegion with an undefined child, uncatchable per-frame, session unresumable),
// and an unvalidated details.todos aborted session_start before the widget overlay mounted.
import assert from "node:assert/strict";
import { test } from "bun:test";

const theme = { fg: (_c, s) => String(s), bold: (s) => String(s) };

let tool;
let handlers;
try {
  const ext = (await import("../extensions/opl-todo/index.ts")).default;
  handlers = {};
  ext({
    registerTool: (t) => { tool = t; },
    on: (ev, fn) => { handlers[ev] = fn; },
    registerShortcut: () => {},
    registerCommand: () => {},
  });
} catch (err) {
  console.warn(`skipping: peer deps not resolvable (${err.message})`);
}

const result = (text, details) => ({ content: [{ type: "text", text }], details });

test("renderResult always returns a component, never undefined", () => {
  if (!tool) return;
  const bad = [
    result("Validation failed for tool \"todo\"", {}), // schema-rejected call: the 0.1.20 crash
    result("x", undefined),
    result("x", null),
    { content: "not an array", details: {} },
    result("x", { action: "explode", todos: [], nextId: 1 }), // unknown action
    result("x", { action: "list", todos: undefined, nextId: 1 }), // missing todos
    result("x", { action: "add", todos: [], nextId: 1 }), // add with empty list
    result("x", { action: "toggle", todos: [{ id: 9, text: "t", done: true }], nextId: 10 }),
    result("x", { action: "clear", todos: [], nextId: 1 }),
  ];
  for (const r of bad) {
    const out = tool.renderResult(r, { expanded: false, isPartial: false }, theme, {});
    assert.ok(out && typeof out.render === "function", `undefined render output for ${JSON.stringify(r.details)}`);
  }
});

test("renderCall survives missing and partial args", () => {
  if (!tool) return;
  for (const args of [undefined, null, {}, { action: "add" }, { action: "toggle", id: 3 }, { action: "list" }]) {
    assert.ok(tool.renderCall(args, theme, {}), `no component for ${JSON.stringify(args)}`);
  }
});

test("session_start reconstruction skips malformed results and keeps valid state", async () => {
  if (!tool || !handlers.session_start) return;
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "add", todos: [{ id: 1, text: "real task", done: false }], nextId: 2 } } },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: {} } }, // schema-rejected, must not throw
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "list", todos: "nope" } } }, // wrong types
    { type: "message", message: { role: "toolResult", toolName: "other", details: { action: "add", todos: [], nextId: 99 } } }, // other tool
  ];
  const ctx = { mode: "headless", sessionManager: { getBranch: () => branch } };
  await handlers.session_start({}, ctx); // threw before the 0.1.21 guard
  const list = await tool.execute("t1", { action: "list" }, undefined, undefined, undefined);
  assert.deepEqual(list.details.todos, [{ id: 1, text: "real task", done: false }]);
  assert.equal(list.details.nextId, 2);
});
