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
import { transition } from "../extensions/opl-modes/state.ts";
const trackedConfig = JSON.parse(readFileSync("configs/opl-modes.json", "utf8"));
const tracked = trackedConfig.modes;
assert.equal(trackedConfig.chatAllowedTools, undefined, "tracked config uses modes.chat.tools");
assert.equal(trackedConfig.planAllowedTools, undefined, "tracked config uses modes.plan.tools");
for (const name of ["chat", "plan"]) {
  assert.equal(tracked[name].safePatterns, undefined, `${name} uses shared bashPatterns`);
  assert.equal(tracked[name].destructivePatterns, undefined, `${name} uses shared bashPatterns`);
}
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
assert.deepEqual(tracked.off.appearance, { prefix: "❯", prefixColor: "accent", borderColor: "border", modeColor: "dim" });
assert.deepEqual(tracked.chat.appearance, { prefix: "󰭻", prefixColor: "#157cd6", borderColor: "#157cd6", modeColor: "#157cd6" });
assert.deepEqual(tracked.plan.appearance, { prefix: "⏸", prefixColor: "#52d90f", borderColor: "#52d90f", modeColor: "#52d90f" });
assert.deepEqual(tracked.execute.appearance, { prefix: "⏸", prefixColor: "#52d90f", borderColor: "#52d90f", modeColor: "#52d90f" });
assert.deepEqual(tracked.review.appearance, { prefix: "◎", prefixColor: "#ce93d8", borderColor: "#ce93d8", modeColor: "#ce93d8" });
assert.deepEqual(tracked.research.appearance, { prefix: "⌕", prefixColor: "#f2eb5a", borderColor: "#f2eb5a", modeColor: "#f2eb5a" });

const inputCfg = JSON.parse(readFileSync("configs/opl-input.json", "utf8"));
for (const key of [
  "borderColor", "prefix", "prefixColor",
  "planModePrefix", "planModePrefixColor", "planModeBorderColor",
  "chatModePrefix", "chatModePrefixColor", "chatModeBorderColor", "modes",
]) assert.equal(inputCfg[key], undefined, `opl-input has no ${key}`);

const footerCfg = JSON.parse(readFileSync("configs/opl-footer.json", "utf8"));
assert.equal(footerCfg.colors?.modeIndicator, undefined, "footer has no modeIndicator override");

// State publication must keep the configured appearance for renderers.
transition("research", { appendEntry() {} });
assert.deepEqual(globalThis.__agentMode, {
  mode: "research",
  appearance: getModeDefinition("research")?.appearance,
});

const modeIndex = readFileSync("extensions/opl-modes/index.ts", "utf8");
assert.doesNotMatch(modeIndex, /__agentMode\s*=\s*\{\s*mode,\s*widgetColor/, "status refresh must not clobber published appearance");

console.log("opl-modes helper tests passed");
