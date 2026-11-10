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

test("resetDone clears only completed todos and persists the remaining list", async () => {
  if (!tool) return;
  const ext = (await import("../extensions/opl-todo/index.ts")).default;
  const localHandlers = {};
  const shortcuts = {};
  const branch = [];
  let localTool;
  ext({
    registerTool: (t) => { localTool = t; },
    on: (ev, fn) => { localHandlers[ev] = fn; },
    registerShortcut: (key, options) => { shortcuts[key] = options.handler; },
    registerCommand: () => {},
    appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
  });
  const ctx = { mode: "headless", sessionManager: { getBranch: () => branch } };
  await localHandlers.session_start({}, ctx);

  const invoke = async (params) => {
    const out = await localTool.execute("t1", params, undefined, undefined, ctx);
    branch.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: out.details } });
    return out;
  };
  for (let i = 1; i <= 10; i++) await invoke({ action: "add", text: `todo ${i}` });
  for (let id = 1; id <= 7; id++) await invoke({ action: "toggle", id });

  await shortcuts["ctrl+alt+r"](ctx);
  const expected = [8, 9, 10].map((id) => ({ id, text: `todo ${id}`, done: false }));
  assert.deepEqual((await localTool.execute("t1", { action: "list" }, undefined, undefined, ctx)).details.todos, expected);

  await localHandlers.session_tree({}, ctx);
  assert.deepEqual((await localTool.execute("t1", { action: "list" }, undefined, undefined, ctx)).details.todos, expected);
  const added = await localTool.execute("t1", { action: "add", text: "todo 11" }, undefined, undefined, ctx);
  assert.equal(added.details.todos.at(-1).id, 11);
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

// Pi 1.5.1's resetExtensionUI() removes and disposes every extension overlay on /reload and
// on a session switch, newest first, and deliberately leaves the custom() promise pending.
// A retained OverlayHandle then only flips a detached `hidden` flag: setHidden(false) can
// never bring the widget back. So the handle must die with the session, and the next
// session_start must mount again - while one instance must not stack two overlays.
function overlayFixture(branch = []) {
  const mounts = [];
  const calls = [];
  const theme = { fg: (_c, s) => String(s), bold: (s) => String(s) };
  const handlers = {};
  const shortcuts = {};
  const ext = require("../extensions/opl-todo/index.ts").default;
  ext({
    registerTool: () => {},
    on: (ev, fn) => { handlers[ev] = fn; },
    registerShortcut: (key, options) => { shortcuts[key] = options.handler; },
    registerCommand: () => {},
    appendEntry: () => {},
  });
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      custom(factory, options) {
        const handle = {
          hidden: false,
          removed: false,
          setHidden(value) { calls.push(["setHidden", value, this.removed]); this.hidden = value; },
          isHidden() { return this.hidden; },
          hide() { this.removed = true; },
        };
        mounts.push(handle);
        factory({ requestRender() {} }, theme, {}, () => {});
        options.onHandle(handle);
        return Promise.resolve();
      },
    },
  };
  return { ctx, handlers, shortcuts, mounts, calls };
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

test("one session mounts one overlay, and a reload-style restart reuses it", async () => {
  const f = overlayFixture();
  await f.handlers.session_start({}, f.ctx);
  await f.handlers.session_start({}, f.ctx);
  assert.equal(f.mounts.length, 1, "a second session_start stacked another overlay");
});

test("session_shutdown drops the handle so the next session re-mounts the widget", async () => {
  const f = overlayFixture();
  await f.handlers.session_start({}, f.ctx);
  assert.equal(f.mounts.length, 1);
  const first = f.mounts[0];

  // Pi disposes the overlay before the old instance is torn down.
  first.hide();
  await f.handlers.session_shutdown({ reason: "reload" }, f.ctx);
  f.calls.length = 0;

  await f.shortcuts["ctrl+alt+t"](f.ctx);
  assert.deepEqual(f.calls, [], "a dead overlay handle must not receive setHidden");

  await f.handlers.session_start({}, f.ctx);
  assert.equal(f.mounts.length, 2, "the new session must mount the widget again");
  assert.notEqual(f.mounts[1], first);
});

test("session_shutdown stops the widget state from being toggled through a stale handle", async () => {
  const f = overlayFixture();
  assert.ok(f.handlers.session_shutdown, "opl-todo must clear its overlay handle on session_shutdown");
  await f.handlers.session_start({}, f.ctx);
  const mounted = f.mounts[0];
  const hiddenBefore = mounted.hidden;

  await f.handlers.session_shutdown({ reason: "quit" }, f.ctx);
  f.calls.length = 0;
  f.shortcuts["ctrl+alt+t"](f.ctx);

  assert.deepEqual(f.calls, [], "no setHidden may reach an overlay this instance no longer owns");
  assert.equal(mounted.hidden, hiddenBefore);
});
