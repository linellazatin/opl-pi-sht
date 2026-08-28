// Functional tests for opl-modes config helpers and registry gating. Requires Bun.
// Run: bun tests/opl-modes-helpers.test.mjs
import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { transition } from "../extensions/opl-modes/state.ts";
import {
  MODE_REGISTRY,
  getModeDefinition,
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

test("validates mode registry, config policy, and published appearance", () => {

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
});
