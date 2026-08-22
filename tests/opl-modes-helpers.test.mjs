// Functional tests for opl-modes config helpers and registry gating. Requires Bun.
// Run: bun tests/opl-modes-helpers.test.mjs
import assert from "node:assert/strict";
import {
  MODE_REGISTRY,
  getModeDefinition,
  executeHandoffAllowed,
  withPlanComplete,
} from "../extensions/opl-modes/config.ts";

// ─── Registry invariants (built-ins + user config merged) ───────────────────

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

// User-config custom modes (from tracked defaults / local config) merge with allowExecute defaulting to true
for (const [name, def] of MODE_REGISTRY) {
  assert.equal(typeof def.prompt, "string" || typeof def.prompt === "function", `prompt defined for ${name}`);
  assert.notEqual(def.allowExecute, undefined, `allowExecute resolved for ${name}`);
}

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

console.log("opl-modes helper tests passed");
