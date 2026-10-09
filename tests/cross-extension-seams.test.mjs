// Cross-extension seams. Extensions install one directory at a time and load in any
// combination, so globalThis is the only channel between them: opl-modes writes
// `__agentMode`/`__planMode`/`__chatMode`, opl-footer writes `__footerRequestRender`, and
// opl-footer's mode segment reads what opl-modes wrote. These tests pin that neither side
// can crash the other when the counterpart is missing, malformed, or already torn down.
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  clearModeGlobals,
  getMode,
  publishModeGlobals,
  resetState,
  transition,
} from "../extensions/opl-modes/state.ts";
import { modeSwitcherSegment } from "../extensions/opl-footer/segments/mode-switcher.ts";
import { planModeSegment } from "../extensions/opl-footer/segments/plan-mode.ts";
import { chatModeSegment } from "../extensions/opl-footer/segments/chat-mode.ts";
import { cavemanSegment } from "../extensions/opl-footer/segments/caveman.ts";

const theme = { fg: (_name, text) => text };
const ctx = { theme };

function withGlobal(name, value, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const prev = globalThis[name];
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
  try {
    return run();
  } finally {
    if (had) globalThis[name] = prev;
    else delete globalThis[name];
  }
}

const piStub = { appendEntry: () => {} };

test("a healthy footer render trigger is called once per transition", () => {
  let calls = 0;
  withGlobal("__footerRequestRender", () => { calls++; }, () => {
    transition("plan", piStub);
    assert.equal(calls, 1);
    assert.equal(getMode(), "plan");
  });
  resetState();
});

test("a footer that throws, or was never mounted, cannot fail a mode transition", () => {
  for (const trigger of [
    () => { throw new Error("TUI is torn down"); },
    42,
    "not a function",
    null,
    undefined,
    { call() {} },
  ]) {
    withGlobal("__footerRequestRender", trigger, () => {
      assert.doesNotThrow(() => transition("execute", piStub), `trigger ${JSON.stringify(String(trigger))}`);
      assert.equal(getMode(), "execute", "the transition still happened");
    });
  }
  resetState();
});

test("the mode globals are published and cleared as a set", () => {
  withGlobal("__footerRequestRender", undefined, () => {
    transition("chat", piStub);
    assert.equal(globalThis.__agentMode.mode, "chat");
    assert.equal(globalThis.__planMode.mode, "off", "chat does not light up the plan family");
    assert.equal(globalThis.__chatMode.mode, "chat");

    clearModeGlobals();
    assert.equal(globalThis.__agentMode, undefined);
    assert.equal(globalThis.__planMode, undefined);
    assert.equal(globalThis.__chatMode, undefined);

    publishModeGlobals();
    assert.equal(globalThis.__agentMode.mode, "chat", "re-publish reflects live state");
    clearModeGlobals();
  });
  resetState();
});

test("the footer mode segment only honours a well-formed state", () => {
  const cases = [
    [{ mode: "plan" }, true, /Plan/],
    [{ mode: "execute", appearance: { modeColor: "cyan" } }, true, /Execute/],
    [{ mode: "off" }, true, /Normal/],
    [{ mode: 5 }, true, /Normal/, "a non-string mode is ignored, not upper-cased"],
    [{ mode: "" }, true, /Normal/],
    [{}, true, /Normal/],
    ["plan", true, /Normal/, "a bare string is not a state object"],
    [7, true, /Normal/],
    [null, true, /Normal/],
    [undefined, true, /Normal/],
  ];
  for (const [value, visible, expect, note] of cases) {
    withGlobal("__agentMode", value, () => {
      const out = modeSwitcherSegment.render(ctx);
      assert.equal(out.visible, visible, `${String(value)}: ${note ?? ""}`);
      if (expect) assert.match(out.content, expect, `${String(value)}: ${note ?? ""}`);
    });
  }
});

test("the other mode segments refuse malformed seam values instead of throwing", () => {
  const cases = [
    [planModeSegment, "__planMode", { mode: "plan" }, true, /ON/],
    [planModeSegment, "__planMode", { mode: "off" }, true, /OFF/],
    [planModeSegment, "__planMode", { mode: 5 }, false, null],
    [planModeSegment, "__planMode", "plan", false, null],
    [planModeSegment, "__planMode", undefined, false, null],
    [chatModeSegment, "__chatMode", { mode: "chat" }, true, /ON/],
    [chatModeSegment, "__chatMode", { mode: ["chat"] }, false, null],
    [cavemanSegment, "__caveman", { enabled: true, mode: "grunting" }, true, /GRUNTING/],
    [cavemanSegment, "__caveman", { enabled: "yes", mode: "grunting" }, false, null],
    [cavemanSegment, "__caveman", { enabled: true, mode: 7 }, false, null],
    [cavemanSegment, "__caveman", { enabled: true }, false, null],
  ];
  for (const [segment, name, value, visible, expect] of cases) {
    withGlobal(name, value, () => {
      const out = segment.render(ctx);
      assert.equal(out.visible, visible, `${name} = ${JSON.stringify(value) ?? String(value)}`);
      if (expect) assert.match(out.content, expect);
    });
  }
});
