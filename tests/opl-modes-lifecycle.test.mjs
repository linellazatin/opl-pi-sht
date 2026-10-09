// Lifecycle tests for opl-modes: they mount the real extension against a fake Pi host so the
// tool/model snapshot behaviour and the agent_before_settle auto-exit rule are exercised end to end.
// Run: bun test tests/opl-modes-lifecycle.test.mjs
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pi's extension host package ships with the running `pi` binary and is deliberately not a
// dependency of this repo, so `extensions/opl-modes/index.ts` cannot be imported directly here.
// Bundle it through tests/support/opl-modes-host-shim.ts with that one value import stubbed, and
// take the shared state/registry modules from the same bundle so test and extension agree.
const buildDir = new URL("./.build/opl-modes", import.meta.url).pathname;
mkdirSync(buildDir, { recursive: true });
const hostPackage = "@earendil-works/" + "pi-coding-agent";

// The stub has to carry every host value the bundled extension imports. `getAgentDir()` mirrors
// pi's resolver (PI_CODING_AGENT_DIR else ~/.pi/agent) so the lifecycle test exercises the same
// path the host would, instead of a second private copy of the rule.
const STUB_HOST = [
  'import { join } from "node:path";',
  'import { homedir } from "node:os";',
  "export class DynamicBorder {}",
  "export function getAgentDir() {",
  "  const dir = process.env.PI_CODING_AGENT_DIR;",
  "  return dir ? dir : join(homedir(), \".pi\", \"agent\");",
  "}",
  "",
].join("\n");
const built = await Bun.build({
  entrypoints: [new URL("./support/opl-modes-host-shim.ts", import.meta.url).pathname],
  target: "node",
  outdir: buildDir,
  external: ["@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox"],
  plugins: [{
    name: "opl-pi-host",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${hostPackage}$`) }, () => ({ path: "pi-host", namespace: "opl-stub" }));
      build.onLoad({ filter: /.*/, namespace: "opl-stub" }, () => ({ contents: STUB_HOST, loader: "js" }));
    },
  }],
});
if (!built.success) throw new Error(`opl-modes lifecycle build failed: ${built.logs.map((l) => l.message).join("\n")}`);
const { default: modeSwitcher, getMode, getRestoringModel, resetState, MODE_REGISTRY, registerMode, getModeDefinition } =
  await import(new URL("./.build/opl-modes/opl-modes-host-shim.js", import.meta.url).href);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Mount the extension against a fake Pi.
 * - `tools`: every tool name the host knows (Pi drops unknown names from setActiveTools).
 * - `active`: tools active at mount time.
 * - `models`: registry entries; `current` is the session model.
 * - `journal`: pre-existing session entries (simulates a resumed branch).
 */
function mount({ tools = [], active, models = [], current, journal = [] } = {}) {
  const host = {
    active: [...(active ?? tools)],
    model: current ?? models[0] ?? null,
    journal: journal.map((entry) => ({ ...entry })),
    modelChanges: [],
    userMessages: [],
    sentMessages: [],
    entryRenderers: [],
  };
  const events = new Map();
  const commands = new Map();
  const known = () => host.active;

  const pi = {
    on(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    registerTool(tool) { if (!tools.includes(tool.name)) tools.push(tool.name); },
    registerCommand(name, def) { commands.set(name, def); },
    registerFlag() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    registerEntryRenderer(type, renderer) { host.entryRenderers.push({ type, renderer }); },
    getActiveTools: () => [...host.active],
    // Pi silently drops names it does not know; mirror that so the test sees the real set.
    setActiveTools(names) { host.active = names.filter((n) => tools.includes(n)); },
    getAllTools: () => known().map((name) => ({ name })),
    getFlag: (name) => host.flags?.[name],
    async setModel(model) {
      host.modelChanges.push(`${model.provider}/${model.id}`);
      host.model = model;
      return true;
    },
    appendEntry(type, data) { host.journal.push({ type: "custom", customType: type, data }); },
    sendUserMessage(text) { host.userMessages.push(text); },
    sendMessage(message) { host.sentMessages.push(message); },
    events: { emit() {} },
  };

  const ctx = {
    hasUI: false,
    get model() { return host.model; },
    modelRegistry: {
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id) ?? null,
    },
    sessionManager: { getBranch: () => host.journal.map((entry) => ({ ...entry })) },
    ui: {
      notify() {},
      setWidget() {},
      theme: { fg: (_c, text) => text },
      custom: async () => undefined,
      select: async () => undefined,
    },
  };

  modeSwitcher(pi);
  const fire = async (name, event) => {
    const results = [];
    for (const handler of events.get(name) ?? []) results.push(await handler(event, ctx));
    return results; // handlers that rewrite the prompt return a patch; tests assert on it
  };
  const run = async (name, args = "") => {
    await commands.get(name).handler(args, ctx);
    await tick();
  };
  return { host, pi, ctx, fire, run, active: () => [...host.active], blob: () => host.journal.at(-1)?.data };
}

/** Built-in definitions are module state; snapshot and restore them around each test. */
let registrySnapshot;
beforeEach(() => {
  registrySnapshot = new Map(MODE_REGISTRY);
  resetState();
});
afterEach(() => {
  MODE_REGISTRY.clear();
  for (const [name, def] of registrySnapshot) MODE_REGISTRY.set(name, def);
});

function defineMode(name, def) {
  registerMode(name, { ...(getModeDefinition(name) ?? {}), ...def });
}

const MODEL_A = { provider: "alpha", id: "model-a" };
const MODEL_B = { provider: "beta", id: "model-b" };
const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "plan_complete"];

test("OFF with pinned tools discards the snapshot taken on mode entry", async () => {
  defineMode("off", { tools: ["read", "grep"] });
  const h = mount({ tools: BASE_TOOLS, active: ["read", "bash"], models: [MODEL_A] });

  await h.run("mode", "chat");
  assert.notDeepEqual(h.active(), ["read", "bash"], "chat mode replaced the active set");

  await h.run("mode", "off");
  assert.deepEqual(h.active(), ["read", "grep"], "OFF restores the pinned baseline, not the pre-chat set");
  assert.equal(h.blob().mode, "off");

  // A second cycle must not resurrect the stale snapshot either.
  await h.run("mode", "chat");
  await h.run("mode", "off");
  assert.deepEqual(h.active(), ["read", "grep"]);
});

test("resuming into OFF keeps the pinned baseline instead of widening it", async () => {
  defineMode("off", { tools: ["read", "grep"] });
  const blobEntry = (data) => ({ type: "custom", customType: "mode-switcher", data });
  const h = mount({
    tools: BASE_TOOLS,
    active: ["read", "bash", "edit"],
    models: [MODEL_A],
    journal: [
      blobEntry({ mode: "chat", activePlanFile: null, restoreModel: null }),
      blobEntry({ mode: "off", activePlanFile: null, restoreModel: null }),
    ],
  });

  await h.fire("session_start", { reason: "resume" });
  assert.equal(getMode(), "off");
  assert.deepEqual(h.active(), ["read", "grep"], "OFF's declared tools win over whatever was active before");
});

test("an unknown mode in the newest entry restores nothing", async () => {
  const h = mount({
    tools: BASE_TOOLS,
    active: ["read", "bash"],
    models: [MODEL_A],
    journal: [
      { type: "custom", customType: "mode-switcher", data: { mode: "chat", activePlanFile: null, restoreModel: null } },
      { type: "custom", customType: "mode-switcher", data: { mode: "removed-mode", activePlanFile: null, restoreModel: null } },
    ],
  });

  await h.fire("session_start", { reason: "resume" });
  assert.equal(getMode(), "off", "a removed custom mode must not resume the older chat entry");
  assert.deepEqual(h.active(), ["read", "bash"], "restored tools are unchanged for OFF without a declared list");
});

test("a mode model captures a restore point and releases it on exit", async () => {
  defineMode("chat", { model: MODEL_B });
  const h = mount({ tools: BASE_TOOLS, active: ["read", "bash"], models: [MODEL_A, MODEL_B], current: MODEL_A });

  await h.run("mode", "chat");
  assert.deepEqual(h.host.modelChanges, ["beta/model-b"]);
  assert.equal(h.host.model, MODEL_B);
  assert.deepEqual(getRestoringModel(), { provider: "alpha", id: "model-a" });
  assert.deepEqual(h.blob().restoreModel, { provider: "alpha", id: "model-a" }, "restore point is persisted to the session");

  await h.run("mode", "off");
  assert.deepEqual(h.host.modelChanges, ["beta/model-b", "alpha/model-a"], "exit restores the previous model");
  assert.equal(h.host.model, MODEL_A);
  assert.equal(getRestoringModel(), null, "restore point is released");
  assert.equal(h.blob().restoreModel, null);
});

test("switching modes twice does not overwrite the restore point with the mode model", async () => {
  defineMode("chat", { model: MODEL_B });
  const h = mount({ tools: BASE_TOOLS, active: ["read", "bash"], models: [MODEL_A, MODEL_B], current: MODEL_A });

  await h.run("mode", "chat");
  await h.run("mode", "off");
  await h.run("mode", "chat");
  assert.deepEqual(h.host.modelChanges, ["beta/model-b", "alpha/model-a", "beta/model-b"]);
  assert.deepEqual(getRestoringModel(), { provider: "alpha", id: "model-a" }, "the real previous model survives");
});

test("OFF's own model replaces the pending restore point", async () => {
  defineMode("chat", { model: MODEL_B });
  defineMode("off", { model: MODEL_A });
  const h = mount({ tools: BASE_TOOLS, active: ["read"], models: [MODEL_A, MODEL_B], current: MODEL_B });

  await h.run("mode", "chat");
  assert.deepEqual(h.host.modelChanges, ["beta/model-b"], "Pi is re-asserted on the mode model even when it is current");
  assert.deepEqual(getRestoringModel(), null);
  await h.run("mode", "off");
  assert.deepEqual(h.host.modelChanges, ["beta/model-b", "alpha/model-a"], "OFF's model wins over any pending restore");
  assert.deepEqual(getRestoringModel(), null);
});

test("execute mode survives aborted/error outcomes and exits on a completed one", async () => {
  const h = mount({
    tools: BASE_TOOLS,
    active: ["read", "bash"],
    models: [MODEL_A],
    journal: [
      { type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } },
    ],
  });
  const settleWith = async (outcome) => { await h.fire("agent_before_settle", { outcome }); await tick(); };

  await h.fire("session_start", { reason: "startup" });
  assert.equal(getMode(), "execute", "resume re-enters execute mode");
  assert.ok(h.active().includes("plan_complete"), "resume re-arms plan_complete");

  await settleWith("aborted");
  assert.equal(getMode(), "execute", "ESC is a pause, not a finished execution");

  await settleWith("error");
  assert.equal(getMode(), "execute", "a provider failure keeps the plan resumable");

  await settleWith("completed");
  assert.equal(getMode(), "off", "a completed run exits execute mode");
});

test("the plan injected into the system prompt is capped", async () => {
  const planDir = join(process.cwd(), ".pi", "plans");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "plan-huge.md");
  const body = "# Plan: Huge\n" + Array.from({ length: 1200 }, (_, i) => `- step ${i}: ${"y".repeat(60)}`).join("\n");
  writeFileSync(planPath, body);
  try {
    const h = mount({
      tools: BASE_TOOLS,
      active: ["read", "bash"],
      models: [MODEL_A],
      journal: [
        { type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: "plan-huge.md", restoreModel: null } },
      ],
    });
    await h.fire("session_start", { reason: "startup" });
    assert.equal(getMode(), "execute", "the harness resumed execute mode");

    const results = await h.fire("before_agent_start", { systemPrompt: "BASE", reason: "startup" });
    const prompt = results.find((r) => r && typeof r.systemPrompt === "string")?.systemPrompt;
    assert.ok(prompt, "execute mode rewrites the system prompt");
    assert.ok(prompt.startsWith("BASE"), "the base prompt is preserved");
    assert.ok(Buffer.byteLength(body, "utf8") > 60000, "fixture must be well over the 24 KB ceiling");
    assert.ok(Buffer.byteLength(prompt, "utf8") < 25000, `injected prompt is ${Buffer.byteLength(prompt)} bytes`);
    assert.match(prompt, /plan truncated: showing \d+ of \d+ bytes/);
    assert.ok(prompt.includes(planPath), "the marker points at the plan file to read");
    assert.ok(prompt.includes("EXECUTE MODE"), "the execute instructions still surround the plan");
  } finally {
    rmSync(planPath, { force: true });
  }
});

test("a user execute template cannot bypass the injection ceiling", async () => {
  const planDir = join(process.cwd(), ".pi", "plans");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "plan-huge2.md");
  writeFileSync(planPath, "# Plan: Huge2\n" + Array.from({ length: 1200 }, (_, i) => `- step ${i}: ${"z".repeat(60)}`).join("\n"));
  try {
    defineMode("execute", { prompt: "CUSTOM TEMPLATE\n{plan}" });
    const h = mount({
      tools: BASE_TOOLS,
      active: ["read", "bash"],
      models: [MODEL_A],
      journal: [
        { type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: "plan-huge2.md", restoreModel: null } },
      ],
    });
    await h.fire("session_start", { reason: "startup" });
    const results = await h.fire("before_agent_start", { systemPrompt: "BASE", reason: "startup" });
    const prompt = results.find((r) => r && typeof r.systemPrompt === "string")?.systemPrompt;
    assert.ok(prompt.startsWith("BASE\n\nCUSTOM TEMPLATE"), "the custom template is still used");
    assert.ok(Buffer.byteLength(prompt, "utf8") < 25000, `injected prompt is ${Buffer.byteLength(prompt)} bytes`);
    assert.match(prompt, /plan truncated/);
  } finally {
    defineMode("execute", { prompt: undefined });
    rmSync(planPath, { force: true });
  }
});

test("loading a plan appends a TUI-only entry, not a model-facing message", async () => {
  const planDir = join(process.cwd(), ".pi", "plans");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "plan-test-plan.md");
  writeFileSync(planPath, "# Plan: Test Plan\n\n- step one\n- step two\n");
  try {
    const h = mount({ tools: BASE_TOOLS, active: ["read"], models: [MODEL_A] });
    h.ctx.ui.custom = async () => "save"; // exit the post-load action menu
    await h.run("plan", "test-plan");

    const planEntries = h.host.journal.filter((e) => e.customType === "plan-mode");
    assert.equal(planEntries.length, 1, "exactly one plan-mode entry is appended");
    assert.equal(planEntries[0].data.title, "Test Plan");
    assert.match(planEntries[0].data.plan, /step one/);
    assert.equal(h.host.sentMessages.length, 0, "the plan is never a model-facing message");
    assert.equal(h.host.entryRenderers.filter((e) => e.type === "plan-mode").length, 1, "a plan-mode entry renderer is registered");
  } finally {
    rmSync(planPath, { force: true });
  }
});

test("a plan over the entry ceiling is stored capped, pointing at the file", async () => {
  const planDir = join(process.cwd(), ".pi", "plans");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "plan-long-plan.md");
  writeFileSync(planPath, "# Plan: Long Plan\n" + Array.from({ length: 400 }, (_, i) => `- step ${i}: ${"x".repeat(60)}`).join("\n"));
  try {
    const h = mount({ tools: BASE_TOOLS, active: ["read"], models: [MODEL_A] });
    h.ctx.ui.custom = async () => "save";
    await h.run("plan", "long-plan");

    const entry = h.host.journal.filter((e) => e.customType === "plan-mode").pop();
    const size = Buffer.byteLength(entry.data.plan, "utf8");
    assert.ok(size <= 4096, `entry copy is ${size} bytes, over the 4096 ceiling`);
    assert.equal(entry.data.truncated, true, "the entry records that the copy is partial");
    assert.equal(entry.data.file, planPath, "the entry points at the full plan file");
    assert.match(entry.data.plan, /plan truncated: showing \d+ of \d+ bytes/);
  } finally {
    rmSync(planPath, { force: true });
  }
});

test("the footer seam is published on session start and cleared on shutdown", async () => {
  const h = mount({ tools: BASE_TOOLS, active: ["read"], models: [MODEL_A] });
  assert.equal(globalThis.__agentMode.mode, "off", "module load publishes an initial state");
  await h.fire("session_shutdown", {});
  assert.equal(globalThis.__agentMode, undefined, "a dead session leaves no mode behind");
  assert.equal(globalThis.__planMode, undefined);
  assert.equal(globalThis.__chatMode, undefined);

  await h.fire("session_start", { reason: "startup" });
  assert.equal(globalThis.__agentMode.mode, "off", "the next session republishes the seam");
  await h.fire("session_shutdown", {});
});

test("a bash call whose command is not a string is blocked by the mode gate", async () => {
  const h = mount({ tools: BASE_TOOLS, active: ["read"], models: [MODEL_A] });
  h.ctx.ui.custom = async () => "save";
  await h.run("plan", "seam-probe");
  const blocked = await h.fire("tool_call", {
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: ["echo", "hi"] },
  });
  assert.ok(
    blocked.some((result) => result?.block === true && /not a string/.test(result.reason ?? "")),
    JSON.stringify(blocked),
  );
  const ok = await h.fire("tool_call", {
    type: "tool_call",
    toolCallId: "c2",
    toolName: "bash",
    input: { command: "echo hi" },
  });
  assert.ok(!ok.some((result) => result?.block === true && /not a string/.test(result.reason ?? "")));
  await h.fire("session_shutdown", {});
});
