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

// ─── Tracked config shape: merged review + research mode ─────────────────

import { readFileSync } from "node:fs";
const tracked = JSON.parse(readFileSync("configs/opl-modes.json", "utf8")).modes;
assert.equal(tracked.audit, undefined, "audit mode removed");
assert.ok(tracked.review, "review mode present");
assert.equal(tracked.review.allowExecute, false);
for (const tool of ["web_search", "fetch_content", "get_search_content", "artifact", "questionnaire"]) {
  assert.ok(tracked.review.tools.includes(tool), `review has ${tool}`);
}
assert.ok(tracked.review.safePatterns.includes("^diff"), "^diff typo fixed");
assert.ok(!tracked.review.prompt.includes("webfetch"), "stale webfetch reference removed");
assert.ok(tracked.review.prompt.includes("Security Review"), "audit directives folded into review");
assert.ok(tracked.research, "research mode present");
assert.equal(tracked.research.allowExecute, false);
for (const tool of ["subagent", "subagent_wait", "write"]) {
  assert.ok(tracked.research.tools.includes(tool), `research has ${tool}`);
}
assert.ok(!tracked.research.tools.includes("edit"), "research cannot edit existing files");
assert.ok(!tracked.research.tools.includes("bash"), "research has no bash");
assert.ok(tracked.research.prompt.includes("Output Discipline"), "research output rules present");

const inputCfg = JSON.parse(readFileSync("configs/opl-input.json", "utf8")).modes;
assert.equal(inputCfg.audit, undefined, "opl-input audit styling removed");
assert.ok(inputCfg.research, "opl-input research styling present");

console.log("opl-modes helper tests passed");
