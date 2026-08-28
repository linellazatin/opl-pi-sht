// Functional tests for opl-modes config helpers and registry gating. Requires Bun.
// Run: bun tests/opl-modes-helpers.test.mjs
import assert from "node:assert/strict";
import { test } from "bun:test";
import { transition } from "../extensions/opl-modes/state.ts";
import {
  getModeDefinition,
  registerMode,
  executeHandoffAllowed,
  withPlanComplete,
  resolveLazyTools,
  applyLazyPolicy,
  lazyToolsToEnable,
  PROTECTED_TOOLS,
  LOADER_TOOL_NAME,
} from "../extensions/opl-modes/config.ts";

test("lazy-tool policy: resolution, subtraction, loader injection, and mode-bounded activation", () => {
  const lazy = new Set(["subagent", "browser"]);

  // resolveLazyTools drops protected/core tools and dedupes
  assert.deepEqual(resolveLazyTools(["subagent", "browser", "read", "edit", "bash", "plan_complete", LOADER_TOOL_NAME, "subagent"]), ["subagent", "browser"]);
  for (const p of ["read", "edit", "write", "bash", "grep", "find", "ls", "plan_complete", LOADER_TOOL_NAME]) {
    assert.ok(PROTECTED_TOOLS.has(p), `protected: ${p}`);
  }

  // applyLazyPolicy strips lazy tools and injects the loader ONLY when something was withheld
  const off = applyLazyPolicy(["read", "bash", "subagent", "browser", "write"], lazy);
  assert.ok(!off.includes("subagent") && !off.includes("browser"), "lazy stripped");
  assert.ok(off.includes(LOADER_TOOL_NAME), "loader injected when lazy withheld");
  assert.ok(off.includes("read") && off.includes("write"), "non-lazy preserved");

  // A read-only mode list with no lazy tools is unchanged and gets no loader
  const chat = applyLazyPolicy(["read", "grep", "find"], lazy);
  assert.deepEqual(chat, ["read", "grep", "find"]);

  // Empty lazy set is a no-op
  assert.deepEqual(applyLazyPolicy(["read", "subagent"], new Set()), ["read", "subagent"]);

  // lazyToolsToEnable: only lazy ∩ mode-allowed ∩ not-already-active
  // inherit-all mode (modeAllowed=null): all requested lazy tools enable
  assert.deepEqual(lazyToolsToEnable(["subagent"], ["read"], null, lazy), ["subagent"]);
  // omitting request enables all currently-allowed lazy tools
  assert.deepEqual(lazyToolsToEnable(undefined, ["read"], null, lazy).sort(), ["browser", "subagent"]);
  // mode restricts allowed set: browser not allowed here
  assert.deepEqual(lazyToolsToEnable(["subagent", "browser"], ["read"], ["read", "subagent"], lazy), ["subagent"]);
  // already active is skipped; non-lazy request ignored
  assert.deepEqual(lazyToolsToEnable(["subagent", "read"], ["subagent"], null, lazy), []);
});

test("validates mode registry and published appearance", () => {

// ─── Registry invariants ────────────────────────────────────────────────────

for (const builtin of ["off", "chat", "plan", "execute"]) {
  assert.ok(getModeDefinition(builtin), `built-in mode registered: ${builtin}`);
}

// execute is the only mode with allowPlanComplete by default
assert.equal(getModeDefinition("execute")?.allowPlanComplete, true);
assert.equal(getModeDefinition("plan")?.allowPlanComplete, false);
assert.equal(getModeDefinition("chat")?.allowPlanComplete, false);

// Built-ins default to allowing the execute handoff
assert.equal(executeHandoffAllowed("off"), true);
assert.equal(executeHandoffAllowed("chat"), true);
assert.equal(getModeDefinition("plan")?.allowExecute, true);

// ─── executeHandoffAllowed against a synthetic registry ─────────────────────

const reg = new Map([
  ["audit", { prompt: "", allowExecute: false }],
  ["review", { prompt: "" }], // unset → allowed (default true)
]);
assert.equal(executeHandoffAllowed("audit", reg), false, "allowExecute: false blocks handoff");
assert.equal(executeHandoffAllowed("review", reg), true, "unset allowExecute defaults to allowed");
assert.equal(executeHandoffAllowed("unknown-mode", reg), true, "unknown modes default to allowed");

// ─── withPlanComplete ────────────────────────────────────────────────────────

const toolsReg = new Map([
  ["verifier", { prompt: "", allowPlanComplete: true }],
  ["reader", { prompt: "", allowPlanComplete: false }],
]);
assert.deepEqual(
  withPlanComplete("verifier", ["read", "grep"], toolsReg),
  ["read", "grep", "plan_complete"],
  "appends plan_complete when allowed",
);
assert.deepEqual(
  withPlanComplete("reader", ["read"], toolsReg),
  ["read"],
  "no plan_complete when not allowed",
);
assert.deepEqual(
  withPlanComplete("verifier", ["read", "plan_complete"], toolsReg),
  ["read", "plan_complete"],
  "idempotent — no duplicate",
);
assert.deepEqual(withPlanComplete("ghost", ["read"]), ["read"], "unknown mode unchanged");

// ─── Built-in override merge honors allowExecute from user config shape ─────

// Simulate the built-in override path semantics used by initModeRegistry:
const existing = { ...getModeDefinition("chat") };
const overridden = { ...existing, ...{ allowExecute: false }, labels: { ...existing.labels } };
assert.equal(overridden.allowExecute, false);
assert.equal(overridden.tools, existing.tools, "override keeps tools when not re-specified");

// State publication must retain a custom mode's appearance for renderers.
const appearance = { prefix: "◎", prefixColor: "#ce93d8", borderColor: "#ce93d8", modeColor: "#ce93d8" };
registerMode("appearance-test", { ...getModeDefinition("chat"), appearance });
transition("appearance-test", { appendEntry() {} });
assert.deepEqual(globalThis.__agentMode, { mode: "appearance-test", appearance });
});
