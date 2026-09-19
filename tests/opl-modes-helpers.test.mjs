// Functional tests for opl-modes config helpers and registry gating. Requires Bun.
// Run: bun tests/opl-modes-helpers.test.mjs
import assert from "node:assert/strict";
import { test } from "bun:test";
import { transition, restore, resetState, getRestoringModel, setRestoringModel } from "../extensions/opl-modes/state.ts";
import {
  getModeDefinition,
  registerMode,
  executeHandoffAllowed,
  withPlanComplete,
  resolveLazyTools,
  applyLazyPolicy,
  lazyToolsToEnable,
  resolveModeModel,
  DEFAULT_SAFE_PATTERNS,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  resolveCustomPatterns,
  PROTECTED_TOOLS,
  LOADER_TOOL_NAME,
} from "../extensions/opl-modes/config.ts";
import * as modeUtils from "../extensions/opl-modes/utils.ts";
import { isDestructive, bashBlockReason } from "../extensions/opl-modes/utils.ts";
import * as modeConfig from "../extensions/opl-modes/config.ts";

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

test("serializes model changes so only the latest request can finish last", async () => {
  const queue = modeUtils.createLatestModelQueue();
  const calls = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const first = queue(async () => {
    calls.push("mode");
    markFirstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
  });
  await firstStarted;
  const second = queue(async () => { calls.push("original"); });

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["mode", "original"]);
});

test("mode pattern overrides reject malformed values and preserve explicit empty arrays", () => {
  const chat = getModeDefinition("chat");
  const invalid = modeConfig.mergeModeDefinition(chat, { safePatterns: ["["] });
  assert.equal(invalid.safePatterns, chat.safePatterns, "invalid regex retains the built-in policy");
  assert.equal(
    modeConfig.resolveCustomPatterns({ safePatterns: "not-an-array" }).safe,
    modeConfig.SAFE_COMMAND_PATTERNS,
    "non-array patterns inherit the shared policy",
  );
  const mixed = modeConfig.mergeModeDefinition(chat, {
    safePatterns: ["^git", "["],
    destructivePatterns: ["\\brm\\b", "["],
  });
  assert.equal(mixed.safePatterns, chat.safePatterns, "mixed safe patterns retain the built-in policy");
  assert.equal(mixed.destructivePatterns, chat.destructivePatterns, "mixed destructive patterns retain the built-in policy");
  assert.deepEqual(modeConfig.mergeModeDefinition(chat, { safePatterns: [] }).safePatterns, []);
});

test("shared bash policy blocks destructive primitives and env leaks", () => {
  const matches = (cmd) => DEFAULT_DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd));
  assert.ok(matches("find . -delete"), "find -delete is destructive");
  assert.ok(matches("find . -exec rm {} \\;"), "find -exec is destructive");
  assert.ok(matches("git clean -fd"), "git clean is destructive");
  assert.ok(matches("git push origin main"), "git push is destructive");
  assert.ok(matches("git update-ref refs/heads/x HEAD"), "git update-ref is destructive");
  assert.ok(matches("truncate -s 0 f"), "truncate is destructive");
  assert.ok(!DEFAULT_SAFE_PATTERNS.some((p) => p.test("env")), "env is not safe-patterned");
  assert.ok(!DEFAULT_SAFE_PATTERNS.some((p) => p.test("printenv")), "printenv is not safe-patterned");
  assert.ok(DEFAULT_SAFE_PATTERNS.some((p) => p.test("cat notes.md")), "cat remains safe");
});

test("quote-skeleton normalization catches shell obfuscation", () => {
  assert.equal(isDestructive('r"m" -rf /', DEFAULT_DESTRUCTIVE_PATTERNS), true, 'r"m" == rm');
  assert.equal(isDestructive("r\\m -rf /", DEFAULT_DESTRUCTIVE_PATTERNS), true, "r\\m == rm");
  assert.equal(isDestructive("rm -rf /", DEFAULT_DESTRUCTIVE_PATTERNS), true, "plain rm matches");
  assert.equal(isDestructive("cat notes.md", DEFAULT_DESTRUCTIVE_PATTERNS), false, "read-only command is clean");
});

test("custom modes inherit the shared bash base unless they override or opt out", () => {
  // no overrides -> inherits BOTH the safe allowlist and destructive base
  const inherited = resolveCustomPatterns({});
  assert.ok(inherited.safe && inherited.safe.length > 0, "inherits safe allowlist");
  assert.ok(inherited.destructive && inherited.destructive.length > 0, "inherits destructive base");
  assert.ok(inherited.destructive.some((p) => p.test("git push origin main")), "inherited destructive blocks git push");

  // explicit safe -> own safe list + inherited destructive
  const safeOnly = resolveCustomPatterns({ safePatterns: ["^git", "^cat"] });
  assert.ok(safeOnly.destructive && safeOnly.destructive.length > 0, "destructive still inherited");
  assert.ok(safeOnly.safe.some((p) => p.test("git status")), "explicit safe list used");

  // explicit destructive -> override destructive + inherited safe
  const destOnly = resolveCustomPatterns({ destructivePatterns: ["\\brm\\b"] });
  assert.ok(destOnly.destructive.some((p) => p.test("rm x")), "explicit destructive used");
  assert.ok(destOnly.safe && destOnly.safe.length > 0, "safe still inherited");

  // unrestrictedBash opts out of all gating
  const open = resolveCustomPatterns({ unrestrictedBash: true });
  assert.equal(open.safe, undefined, "unrestricted: no safe list");
  assert.equal(open.destructive, undefined, "unrestricted: no destructive list");
});

test("bash gate checks every shell segment, not just the command prefix", () => {
  const blocked = (cmd) => bashBlockReason(cmd, DEFAULT_SAFE_PATTERNS, DEFAULT_DESTRUCTIVE_PATTERNS) !== null;
  const allowed = (cmd) => !blocked(cmd);

  // State-changing payloads riding on a safe-listed first command.
  for (const cmd of [
    `cat x && node -e 'require("fs").writeFileSync("/tmp/p","x")'`,
    `ls; python -c 'open("/tmp/p","w")'`,
    `echo hi && sed -i 's/a/b/' important.txt`,
    "diff a b; :(){ :|:& };:",
    "echo hi | tee /dev/null",
    "ls > list.txt",
    "sort -o out.txt in.txt",
    "cat f && sudo rm -rf /",
    'cat "$(rm -rf /tmp/x)"',
    "cat `rm -rf /tmp/x`",
    "cat <(node -e 'x')",
    "find . -exec node -e 'x' ;",
  ]) {
    assert.ok(blocked(cmd), `blocked: ${cmd}`);
  }

  // Obfuscation still caught.
  assert.ok(blocked('r"m" -rf /tmp/x'), 'r"m" still blocked');
  assert.ok(blocked('find . -del"ete" x'), '-del"ete" still blocked');

  // Read-only commands that only mention a dangerous word in an argument.
  for (const cmd of [
    "du -sh .",
    "find . -name '*.sh'",
    "ls -la cp",
    "cat mv.sh",
    "git log --grep=rm",
    "grep -rn 'touch' src",
    "git branch -a",
    "git diff | grep '^+.*rm -rf'",
    `grep -rn "a|b" src`,
    "echo 'a; b' | wc -l",
    "ls -R | grep -c sh",
    "git status && git log --oneline -5",
    'cat "my dir/file.txt"',
  ]) {
    assert.ok(allowed(cmd), `allowed: ${cmd}`);
  }

  // Explicit empty safe list = no allowlist gate; blocklist still applies per segment.
  assert.ok(bashBlockReason("cat x && rm y", [], DEFAULT_DESTRUCTIVE_PATTERNS) !== null, "segment blocklist still applies");
  assert.equal(bashBlockReason("anything goes", [], []), null, "no patterns configured = no gate");
});

test("unrestrictedBash opts a built-in mode out of bash gating, custom modes do not light up plan state",
  () => {
    const merged = modeConfig.mergeModeDefinition(getModeDefinition("chat"), { unrestrictedBash: true });
    assert.equal(merged.safePatterns, undefined, "override clears the safe list");
    assert.equal(merged.destructivePatterns, undefined, "override clears the destructive list");
    assert.notEqual(
      modeConfig.mergeModeDefinition(getModeDefinition("chat"), { prompt: "x" }).safePatterns,
      undefined,
      "without the flag the built-in policy stays armed",
    );

    registerMode("gatecheck", { prompt: "" });
    const pi = { appendEntry() {} };
    transition("gatecheck", pi);
    assert.equal(globalThis.__planMode.mode, "off", "custom mode is not plan mode");
    assert.equal(globalThis.__chatMode.mode, "off", "custom mode is not chat mode");
    transition("execute", pi);
    assert.equal(globalThis.__planMode.mode, "execute", "execute still reports plan state");
    transition("off", pi);
  });

test("blank model means no override and the model restore point survives a reload", () => {
  // Blank/partial references are normalized to "unset" instead of warning "Model not found: /".
  assert.equal(resolveModeModel({ provider: "", id: "" }), undefined);
  assert.equal(resolveModeModel({ provider: "  ", id: "gpt-5.6-terra" }), undefined);
  assert.equal(resolveModeModel({}), undefined);
  assert.deepEqual(resolveModeModel({ provider: "litellm-proxy", id: " gpt-5.6-terra " }), {
    provider: "litellm-proxy",
    id: "gpt-5.6-terra",
  });
  const blanked = modeConfig.mergeModeDefinition(getModeDefinition("chat"), { model: { provider: "", id: "" } });
  assert.equal(blanked.model, undefined, "blank override clears the mode model");

  // The restore point is persisted with the mode entry, so /reload and /resume keep it.
  const written = [];
  const pi = { appendEntry: (_type, data) => written.push(data) };
  resetState();
  transition("chat", pi);
  setRestoringModel({ provider: "litellm-proxy", id: "gpt-5.6-terra" }, pi);
  assert.deepEqual(getRestoringModel(), { provider: "litellm-proxy", id: "gpt-5.6-terra" });

  resetState();
  assert.equal(getRestoringModel(), null, "reset clears the restore point");
  const entries = [{ type: "custom", customType: "mode-switcher", data: written[written.length - 1] }];
  assert.equal(restore(entries), true);
  assert.deepEqual(getRestoringModel(), { provider: "litellm-proxy", id: "gpt-5.6-terra" }, "restore brings it back");

  // Malformed restore references degrade to "nothing to restore".
  assert.equal(restore([{ type: "custom", customType: "mode-switcher", data: { mode: "chat", restoreModel: { provider: "" } } }]), true);
  assert.equal(getRestoringModel(), null);
  resetState();
});

test("three-digit hex renders as truecolor instead of falling through to the theme", () => {
  // theme.fg would throw for "#abc"; the shorthand must expand to #aabbcc (170,187,204)
  // so footer, input, and modes all colour it the same way.
  const throwingTheme = { fg: () => { throw new Error("should not be consulted for hex"); } };
  assert.equal(
    modeUtils.applyLabelColor(throwingTheme, "#abc", "x"),
    "\x1b[38;2;170;187;204mx\x1b[39m",
  );
  assert.equal(modeUtils.applyLabelColor(throwingTheme, "#nope", "x"), "x", "bad hex still degrades");
});
