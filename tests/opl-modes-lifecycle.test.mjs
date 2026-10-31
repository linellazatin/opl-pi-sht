// Lifecycle tests for opl-modes: they mount the real extension against a fake Pi host so the
// tool/model snapshot behaviour and the agent_before_settle auto-exit rule are exercised end to end.
// Run: bun test tests/opl-modes-lifecycle.test.mjs
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { default: modeSwitcher, getMode, getRestoringModel, resetState, setSessionCwd, MODE_REGISTRY, registerMode, getModeDefinition, LAZY_TOOLS } =
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
    userMessageModels: [],
    userMessageTools: [],
    sentMessages: [],
    entryRenderers: [],
    registeredTools: new Map(),
  };
  const events = new Map();
  const commands = new Map();
  const known = () => host.active;

  const pi = {
    on(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    registerTool(tool) { host.registeredTools.set(tool.name, tool); if (!tools.includes(tool.name)) tools.push(tool.name); },
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
    sendUserMessage(text) { host.userMessages.push(text); host.userMessageModels.push(host.model); host.userMessageTools.push([...host.active]); },
    sendMessage(message) { host.sentMessages.push(message); },
    events: { emit() {} },
  };

  const ctx = {
    cwd: process.cwd(),
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
let lazySnapshot;
beforeEach(() => {
  registrySnapshot = new Map(MODE_REGISTRY);
  lazySnapshot = [...LAZY_TOOLS];
  resetState();
});
afterEach(() => {
  setSessionCwd(process.cwd());
  LAZY_TOOLS.clear();
  for (const name of lazySnapshot) LAZY_TOOLS.add(name);
  MODE_REGISTRY.clear();
  for (const [name, def] of registrySnapshot) MODE_REGISTRY.set(name, def);
});

function defineMode(name, def) {
  registerMode(name, { ...(getModeDefinition(name) ?? {}), ...def });
}

const MODEL_A = { provider: "alpha", id: "model-a" };
const MODEL_B = { provider: "beta", id: "model-b" };
const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "plan_complete"];

function beforeAgentStart(messageType) {
  const base = { type: "before_agent_start", messageType, systemPrompt: "BASE" };
  return messageType === "user"
    ? { ...base, prompt: "Continue the work.", images: [] }
    : { ...base, message: { role: "custom", customType: "compatibility-probe", content: "Continue the work.", display: false, timestamp: 1 } };
}

for (const mode of ["chat", "plan"]) {
  for (const messageType of ["user", "custom"]) {
    test(`${mode} mode injects its prompt for a ${messageType}-started run`, async () => {
      const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A] });
      await h.run(mode === "plan" ? "plan" : "mode", mode === "plan" ? "lifecycle-probe" : "chat");
      const event = beforeAgentStart(messageType);
      assert.equal(Object.hasOwn(event, "prompt"), messageType === "user");

      const results = await h.fire("before_agent_start", event);
      const prompt = results.find((r) => typeof r?.systemPrompt === "string")?.systemPrompt;
      assert.ok(prompt?.startsWith("BASE\n\n"), "the base prompt is preserved");
      assert.match(prompt, mode === "chat" ? /CHAT MODE/ : /PLAN MODE/);
      assert.equal(getMode(), mode, "prompt injection does not change the active mode");
    });
  }
}

test("session startup and replacement resolve named plans from each session cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-mode-cwd-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const name = "session-cwd-probe";
  const planName = `plan-${name}.md`;
  for (const [cwd, text] of [[first, "FIRST SESSION PLAN"], [second, "SECOND SESSION PLAN"]]) {
    const dir = join(cwd, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, planName), `# Plan: Session\n\n${text}\n`);
  }
  try {
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A] });
    h.ctx.cwd = first;
    await h.fire("session_start", { reason: "startup" });
    await h.run("execute", name);
    let results = await h.fire("before_agent_start", beforeAgentStart("user"));
    assert.match(results[0]?.systemPrompt ?? "", /FIRST SESSION PLAN/);

    h.host.journal = [];
    h.ctx.cwd = second;
    await h.fire("session_start", { reason: "new" });
    await h.run("execute", name);
    results = await h.fire("before_agent_start", beforeAgentStart("user"));
    assert.match(results[0]?.systemPrompt ?? "", /SECOND SESSION PLAN/);
    assert.doesNotMatch(results[0]?.systemPrompt ?? "", /FIRST SESSION PLAN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume and --plan startup use session cwd before resolving a plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-mode-cwd-"));
  const planDir = join(root, ".pi", "plans");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "plan-cwd-resume.md"), "# Plan: Resume\n\nRESUMED SESSION PLAN\n");
  try {
    const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: "plan-cwd-resume.md", restoreModel: null } }];
    const resumed = mount({ tools: [...BASE_TOOLS], models: [MODEL_A], journal });
    resumed.ctx.cwd = root;
    await resumed.fire("session_start", { reason: "resume" });
    const results = await resumed.fire("before_agent_start", beforeAgentStart("user"));
    assert.match(results[0]?.systemPrompt ?? "", /RESUMED SESSION PLAN/);

    resetState();
    const flagged = mount({ tools: [...BASE_TOOLS], models: [MODEL_A] });
    flagged.host.flags = { plan: true };
    flagged.ctx.cwd = root;
    await flagged.fire("session_start", { reason: "startup" });
    await flagged.run("execute", "cwd-resume");
    const flagResults = await flagged.fire("before_agent_start", beforeAgentStart("user"));
    assert.match(flagResults[0]?.systemPrompt ?? "", /RESUMED SESSION PLAN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--plan writes generated plans in the session cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-mode-cwd-"));
  try {
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A] });
    h.host.flags = { plan: true };
    h.ctx.cwd = root;
    h.ctx.hasUI = true;
    h.ctx.ui.custom = async () => "save";
    await h.fire("session_start", { reason: "startup" });
    await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "# Plan:\n1. Write the expected plan." }] }] });
    const dir = join(root, ".pi", "plans");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(readFileSync(join(dir, files[0]), "utf8"), /Write the expected plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh and unknown-branch startup apply the pinned OFF tools", async () => {
  defineMode("off", { tools: ["read", "grep"] });
  for (const journal of [[], [{ type: "custom", customType: "mode-switcher", data: { mode: "removed-mode" } }]]) {
    resetState();
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A], journal });
    await h.fire("session_start", { reason: "startup" });
    assert.equal(getMode(), "off");
    assert.deepEqual(h.active(), ["read", "grep"]);
  }
});

test("fresh OFF without a pinned list preserves the active set", async () => {
  const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash"], models: [MODEL_A] });
  await h.fire("session_start", { reason: "startup" });
  assert.deepEqual(h.active(), ["read", "bash"]);
});

for (const mode of ["chat", "plan"]) {
  test(`--${mode} startup keeps its mode tools rather than the pinned OFF list`, async () => {
    defineMode("off", { tools: ["write"] });
    defineMode(mode, { tools: ["read", "grep"] });
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash"], models: [MODEL_A] });
    h.host.flags = { [mode]: true };
    await h.fire("session_start", { reason: "startup" });
    assert.equal(getMode(), mode);
    assert.deepEqual(h.active(), ["read", "grep"]);
  });
}

test("--plan execution inherits the pinned OFF baseline instead of startup tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-flag-execute-"));
  try {
    defineMode("off", { tools: ["read", "grep"] });
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A] });
    h.host.flags = { plan: true };
    h.ctx.cwd = root;
    h.ctx.hasUI = true;
    h.ctx.ui.custom = async () => "execute";
    await h.fire("session_start", { reason: "startup" });
    await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "# Plan:\n1. Implement." }] }] });
    assert.equal(getMode(), "execute");
    assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
    await h.run("mode", "off");
    assert.deepEqual(h.active(), ["read", "grep"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--plan execution without an OFF override retains the startup tool set", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-flag-inherit-"));
  try {
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A] });
    h.host.flags = { plan: true };
    h.ctx.cwd = root;
    h.ctx.hasUI = true;
    h.ctx.ui.custom = async () => "execute";
    await h.fire("session_start", { reason: "startup" });
    await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "# Plan:\n1. Implement." }] }] });
    assert.deepEqual(h.active(), ["read", "bash", "edit", "plan_complete"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execute applies configured tools and restores the pre-plan snapshot on exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-execute-tools-"));
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-tools.md"), "# Plan: Tools\n\nImplement.\n");
    defineMode("execute", { tools: ["read", "grep"] });
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A] });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    await h.run("execute", "tools");
    assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
    await h.fire("agent_before_settle", { outcome: "completed" });
    assert.equal(getMode(), "off");
    assert.deepEqual(h.active(), ["read", "bash", "edit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execute without a tool override inherits the pre-plan active tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-execute-inherited-"));
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-tools.md"), "# Plan: Tools\n\nImplement.\n");
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A] });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    await h.run("execute", "tools");
    assert.deepEqual(h.active(), ["read", "bash", "edit", "plan_complete"]);
    await h.run("mode", "off");
    assert.deepEqual(h.active(), ["read", "bash", "edit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of ["resume", "fork", "startup"]) {
  test(`${reason} into execute uses pinned OFF tools before any follow-up`, async () => {
    defineMode("off", { tools: ["read", "grep"] });
    const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A], journal });
    await h.fire("session_start", { reason });
    assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
    assert.equal(h.host.userMessages.length, reason === "startup" ? 0 : 1);
    if (reason !== "startup") assert.deepEqual(h.host.userMessageTools[0], ["read", "grep", "plan_complete"]);
    await h.run("mode", "off");
    assert.deepEqual(h.active(), ["read", "grep"]);
  });
}

test("restored plan inherits the pinned OFF baseline when execution starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-resume-plan-"));
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-probe.md"), "# Plan: Probe\\n\\nImplement.\\n");
    defineMode("off", { tools: ["read", "grep"] });
    const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "plan", activePlanFile: "plan-probe.md", restoreModel: null } }];
    const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A], journal });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "resume" });
    await h.run("execute");
    assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resumed execute without a pinned OFF list retains the host tool set", async () => {
  const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
  const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A], journal });
  await h.fire("session_start", { reason: "resume" });
  assert.deepEqual(h.active(), ["read", "bash", "edit", "plan_complete"]);
});

test("resumed execute keeps lazy tools withheld from the pinned OFF baseline", async () => {
  LAZY_TOOLS.add("browser");
  defineMode("off", { tools: ["read", "browser"] });
  const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
  const h = mount({ tools: [...BASE_TOOLS, "browser"], active: ["read", "edit", "browser"], models: [MODEL_A], journal });
  await h.fire("session_start", { reason: "resume" });
  assert.deepEqual(h.active(), ["read", "load_tools", "plan_complete"]);
});

for (const restored of [false, true]) {
  for (const policy of ["pinned", "explicit", "unpinned"]) {
    test(`execute lazy loading respects ${policy} policy (${restored ? "restored" : "fresh"})`, async () => {
      LAZY_TOOLS.add("browser");
      LAZY_TOOLS.add("simplebench");
      if (policy !== "unpinned") defineMode("off", { tools: ["read", "browser"] });
      if (policy === "explicit") defineMode("execute", { tools: ["read", "simplebench"] });
      const journal = restored ? [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }] : [];
      const h = mount({ tools: [...BASE_TOOLS, "browser", "simplebench"], models: [MODEL_A], journal });
      await h.fire("session_start", { reason: restored ? "resume" : "startup" });
      if (!restored) {
        const root = mkdtempSync(join(tmpdir(), "opl-lazy-execute-"));
        try {
          h.ctx.cwd = root;
          h.host.flags = { plan: true };
          await h.fire("session_start", { reason: "startup" });
          h.ctx.hasUI = true;
          h.ctx.ui.custom = async () => "execute";
          await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "# Plan:\n1. Implement." }] }] });
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
      assert.equal(getMode(), "execute");
      const loader = h.host.registeredTools.get("load_tools");
      assert.ok(loader);
      // Both explicit requests and load-all must respect the effective policy.
      const result = await loader.execute("probe", { tools: [policy === "explicit" ? "browser" : "simplebench"] });
      assert.deepEqual(result.details.enabled, policy === "unpinned" ? ["simplebench"] : []);
      await loader.execute("probe-all", {});
      assert.equal(h.active().includes("browser"), policy !== "explicit");
      assert.equal(h.active().includes("simplebench"), policy !== "pinned");
    });
  }
}

test("tool-less custom modes inherit the pinned OFF lazy-tool policy", async () => {
  LAZY_TOOLS.add("browser");
  LAZY_TOOLS.add("simplebench");
  defineMode("off", { tools: ["read", "browser"] });
  defineMode("review-probe", { prompt: "Inspect." });
  const h = mount({ tools: [...BASE_TOOLS, "browser", "simplebench"], models: [MODEL_A] });
  await h.fire("session_start", { reason: "startup" });
  await h.run("mode", "review-probe");
  const result = await h.host.registeredTools.get("load_tools").execute("probe", {});
  assert.deepEqual(result.details.enabled, ["browser"]);
  assert.ok(!h.active().includes("simplebench"));
});

test("switching branches to execute applies the pinned OFF baseline", async () => {
  defineMode("off", { tools: ["read", "grep"] });
  const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A] });
  await h.fire("session_start", { reason: "startup" });
  h.host.journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
  await h.fire("session_tree", {});
  assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
  assert.equal(h.host.userMessages.length, 0);
});

test("restored execute preserves explicit tools and completion policy with pinned OFF", async () => {
  defineMode("off", { tools: ["read", "grep"] });
  defineMode("execute", { tools: ["read", "edit"], allowPlanComplete: false });
  const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
  const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash"], models: [MODEL_A], journal });
  await h.fire("session_start", { reason: "resume" });
  assert.deepEqual(h.active(), ["read", "edit"]);
  await h.run("mode", "off");
  assert.deepEqual(h.active(), ["read", "grep"]);
});

test("resumed execute restores the original active set after a configured tool policy", async () => {
  defineMode("execute", { tools: ["read", "grep"] });
  const journal = [{ type: "custom", customType: "mode-switcher", data: { mode: "execute", activePlanFile: null, restoreModel: null } }];
  const h = mount({ tools: [...BASE_TOOLS], active: ["read", "bash", "edit"], models: [MODEL_A], journal });
  await h.fire("session_start", { reason: "resume" });
  assert.deepEqual(h.active(), ["read", "grep", "plan_complete"]);
  await h.run("mode", "off");
  assert.deepEqual(h.active(), ["read", "bash", "edit"]);
});

test("execute respects lazy tools, completion permission, and pinned OFF on exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-execute-lazy-"));
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-tools.md"), "# Plan: Tools\n\nImplement.\n");
    LAZY_TOOLS.add("browser");
    defineMode("off", { tools: ["read", "bash"] });
    defineMode("execute", { tools: ["read", "browser"], allowPlanComplete: false });
    const h = mount({ tools: [...BASE_TOOLS, "browser"], active: ["read", "bash", "edit"], models: [MODEL_A] });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    assert.deepEqual(h.active(), ["read", "bash"]);
    await h.run("execute", "tools");
    assert.deepEqual(h.active(), ["read", "load_tools"]);
    const denied = await h.fire("tool_call", { toolName: "plan_complete", input: {} });
    assert.equal(denied[0]?.block, true);
    await h.run("mode", "off");
    assert.deepEqual(h.active(), ["read", "bash"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("named plan creation applies its model and restores the previous model", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  try {
    defineMode("plan", { model: MODEL_B });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A, MODEL_B], current: MODEL_A });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    await h.run("plan", "new-name");
    assert.equal(h.host.model, MODEL_B);
    assert.deepEqual(getRestoringModel(), { provider: "alpha", id: "model-a" });
    assert.deepEqual(h.blob().restoreModel, { provider: "alpha", id: "model-a" });
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loading a plan switches models before immediate execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-existing.md"), "# Plan: Existing\n\nImplement.\n");
    defineMode("plan", { model: MODEL_B });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A, MODEL_B], current: MODEL_A });
    h.ctx.cwd = root;
    h.ctx.ui.custom = async () => "execute";
    await h.fire("session_start", { reason: "startup" });
    await h.run("plan", "existing");
    assert.deepEqual(h.host.modelChanges, ["beta/model-b"]);
    assert.deepEqual(h.host.userMessageModels, [MODEL_B]);
    assert.deepEqual(getRestoringModel(), { provider: "alpha", id: "model-a" });
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loaded plan waits for a slow plan model before switching to execute model", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  const executeModel = { provider: "gamma", id: "model-c" };
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  try {
    const dir = join(root, ".pi", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-existing.md"), "# Plan: Existing\n\nImplement.\n");
    defineMode("plan", { model: MODEL_B });
    defineMode("execute", { model: executeModel });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A, MODEL_B, executeModel], current: MODEL_A });
    h.ctx.cwd = root;
    h.ctx.ui.custom = async () => "execute";
    h.pi.setModel = async (model) => {
      h.host.modelChanges.push(`${model.provider}/${model.id}`);
      if (model === MODEL_B) await pending;
      h.host.model = model;
      return true;
    };
    await h.fire("session_start", { reason: "startup" });
    const run = h.run("plan", "existing");
    await tick();
    assert.deepEqual(h.host.modelChanges, ["beta/model-b"]);
    assert.deepEqual(h.host.userMessages, []);
    release();
    await run;
    assert.deepEqual(h.host.modelChanges, ["beta/model-b", "gamma/model-c"]);
    assert.deepEqual(h.host.userMessageModels, [executeModel]);
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test("a named plan from the mode picker applies the plan model", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  try {
    defineMode("plan", { model: MODEL_B });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A, MODEL_B], current: MODEL_A });
    h.ctx.cwd = root;
    h.ctx.ui.custom = async () => "picker-name";
    await h.fire("session_start", { reason: "startup" });
    await h.run("mode", "plan");
    assert.equal(getMode(), "plan");
    assert.equal(h.host.model, MODEL_B);
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing plan model leaves the current model usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  try {
    defineMode("plan", { model: MODEL_B });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A], current: MODEL_A });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    await h.run("plan", "new-name");
    assert.equal(getMode(), "plan");
    assert.equal(h.host.model, MODEL_A);
    assert.deepEqual(h.host.modelChanges, []);
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unnamed plan entry applies its model and cancelled naming changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-plan-model-"));
  try {
    defineMode("plan", { model: MODEL_B });
    const h = mount({ tools: [...BASE_TOOLS], models: [MODEL_A, MODEL_B], current: MODEL_A });
    h.ctx.cwd = root;
    await h.fire("session_start", { reason: "startup" });
    h.ctx.ui.custom = async () => undefined;
    await h.run("plan");
    assert.equal(getMode(), "off");
    assert.equal(h.host.model, MODEL_A);
    h.ctx.ui.custom = async () => "";
    await h.run("plan");
    assert.equal(getMode(), "plan");
    assert.equal(h.host.model, MODEL_B);
    await h.run("mode", "off");
    assert.equal(h.host.model, MODEL_A);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

    const results = await h.fire("before_agent_start", beforeAgentStart("user"));
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

test("a custom-started run's execute template cannot bypass the injection ceiling", async () => {
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
    const results = await h.fire("before_agent_start", beforeAgentStart("custom"));
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
