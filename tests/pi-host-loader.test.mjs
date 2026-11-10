import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "bun:test";

// Host resolution (managed install first, devDependency fallback) lives in
// tests/support/pi-host.mjs and is shared with the pi-tui marker test, so both
// read the same Pi build.
import { hostFile, loadHost } from "./support/pi-host.mjs";

const execFileAsync = promisify(execFile);
const host = await loadHost();
const [major, minor] = host.version.split(".").map(Number);
const supportsCustomRunLifecycle = major > 1 || (major === 1 && minor >= 2);
const supportsResponsesToolChanges = major > 1 || (major === 1 && minor >= 4);
const supportsProgramStatus = major > 1 || (major === 1 && minor >= 5);
// Pi 1.5.1 replaced ui.hideOverlay() (topmost only) with a registry it drains newest-first,
// so the cleanup tests below self-skip on hosts that never had the registry.
const interactiveModePath = join(dirname(host.entry), "modes/interactive/interactive-mode.js");
const resetsExtensionOverlayRegistry = existsSync(interactiveModePath)
  && readFileSync(interactiveModePath, "utf8").includes("this.extensionOverlays.delete(");
const hostAiEntry = hostFile(host, "@earendil-works/pi-ai");
const hostAi = await import(pathToFileURL(hostAiEntry).href);

async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "opl-pi-host-loader-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  // Configure lazy tools before the first load: older hosts cache helper modules.
  mkdirSync(join(agentDir, "configs"));
  writeFileSync(join(agentDir, "configs/opl-modes.json"), JSON.stringify({ lazyTools: ["browser", "simplebench"] }));
  try {
    await run(agentDir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("Pi host loader loads every package extension without errors", async () => {
  const { discoverAndLoadExtensions } = host.module;
  const { source } = host;
  // A floor job must not silently run against the machine's own pi. When OPL_PI_HOST_SOURCE is
  // set, the loader has to report exactly that source.
  const expected = process.env.OPL_PI_HOST_SOURCE;
  if (expected) assert.equal(source, expected, "wrong pi build exercised");
  await withAgentDir(async (agentDir) => {
    const result = await discoverAndLoadExtensions(["extensions"], process.cwd(), agentDir);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 12);
    console.log(`[pi-host] loaded ${result.extensions.length} extensions with ${source}`);
  });
});

test("Pi host resource reload replaces configurator tab factories", async () => {
  const key = "__oplConfiguratorTabs";
  const previous = globalThis[key];
  delete globalThis[key];
  try {
    await withAgentDir(async (agentDir) => {
      const { DefaultResourceLoader, SettingsManager } = host.module;
      const cwd = join(agentDir, "workspace");
      mkdirSync(cwd);
      const settingsManager = SettingsManager.inMemory({});
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        additionalExtensionPaths: [join(process.cwd(), "extensions/opl-footer/index.ts"), join(process.cwd(), "extensions/opl-input/index.ts")],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const first = [...globalThis[key]];
      const firstExtensions = resourceLoader.getExtensions().extensions;
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      assert.notEqual(resourceLoader.getExtensions().extensions[0], firstExtensions[0], "reload must create a new extension instance");
      const second = globalThis[key];
      for (const id of ["opl-footer", "opl-input"]) {
        assert.notEqual(second.find((tab) => tab.id === id), first.find((tab) => tab.id === id), `${id} kept the old factory after reload`);
        assert.equal(second.filter((tab) => tab.id === id).length, 1);
      }
      console.log(`[pi-host] configurator reload checked with ${host.source}`);
    });
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("Pi parses versioned changelog entries from the actual npm package", async () => {
  await withAgentDir(async (agentDir) => {
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", agentDir], {
      cwd: process.cwd(), env: { ...process.env, npm_config_cache: join(agentDir, "npm-cache") }, timeout: 15_000,
    });
    const packed = JSON.parse(stdout)[0];
    const paths = packed.files.map((file) => file.path);
    assert.ok(paths.includes("CHANGELOG.md"));
    assert.equal(paths.filter((path) => /^extensions\/[^/]+\/index\.ts$/.test(path)).length, 12);
    assert.ok(paths.some((path) => path.endsWith(".json.sample")));
    assert.ok(!paths.some((path) => /^configs\/.*\.json$/.test(path)), "live configs must not ship");
    const { stdout: changelog } = await execFileAsync("tar", ["-xOf", join(agentDir, packed.filename), "package/CHANGELOG.md"], { timeout: 5_000 });
    assert.equal(changelog, readFileSync("CHANGELOG.md", "utf8"), "packed changelog must be complete");
    const changelogPath = join(agentDir, "CHANGELOG.md");
    writeFileSync(changelogPath, changelog);
    const { parseChangelog } = await import(pathToFileURL(join(dirname(host.entry), "utils/changelog.js")).href);
    const entries = parseChangelog(changelogPath);
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    assert.equal(`${entries[0].major}.${entries[0].minor}.${entries[0].patch}`, version);
    assert.ok(entries[0].content.split("\n").length > 2, "release notes include content, not only a heading");
    assert.ok(entries.length > 1, "historical versioned entries remain parseable");
  });
}, 20_000);

test("Pi host validator checks and normalizes real extension arguments without mutating calls", async () => {
  await withAgentDir(async (agentDir) => {
    const loaded = await host.module.discoverAndLoadExtensions(["extensions"], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const tools = new Map(loaded.extensions.flatMap((extension) => [...extension.tools.values()].map(({ definition }) => [definition.name, definition])));
    const question = { id: "scope", prompt: "Pick", options: [{ value: "a", label: "A" }] };
    const valid = {
      browser: { action: "pages" }, web_search: { query: "fixture" }, fetch_content: { url: "https://example.com" },
      get_search_content: { responseId: "fixture" }, questionnaire: { questions: [question] }, todo: { action: "list" },
      simplebench: { no_artifact: true }, plan_complete: {}, load_tools: { tools: ["browser"] },
    };
    assert.deepEqual([...tools.keys()].sort(), Object.keys(valid).sort(), "every registered tool needs validator coverage");
    let checks = 0;
    const check = (name, args, expected, rejects = false) => {
      const call = { type: "toolCall", id: "fixture", name, arguments: structuredClone(args) };
      const before = structuredClone(call);
      if (rejects) assert.throws(() => hostAi.validateToolArguments(tools.get(name), call), Error, `${name}: ${JSON.stringify(args)}`);
      else assert.deepEqual(hostAi.validateToolArguments(tools.get(name), call), expected, `${name}: ${JSON.stringify(args)}`);
      assert.deepEqual(call, before, "normalization must not rewrite transcript arguments");
      checks++;
    };
    for (const [name, args] of Object.entries(valid)) {
      check(name, args, args);
      for (const key of tools.get(name).parameters.required ?? []) {
        const missing = { ...args };
        delete missing[key];
        check(name, missing, undefined, true);
      }
      const property = Object.keys(tools.get(name).parameters.properties)[0];
      if (property) check(name, { ...args, [property]: { invalid: "object" } }, undefined, true);
    }
    check("todo", { action: "invalid" }, undefined, true);
    check("questionnaire", { questions: [{ ...question, options: [{ label: "missing value" }] }] }, undefined, true);
    check("todo", { action: "toggle", id: "42" }, { action: "toggle", id: 42 });
    check("browser", { action: "screenshot", fullPage: "false", timeoutMs: "42" }, { action: "screenshot", fullPage: false, timeoutMs: 42 });
    check("simplebench", { no_artifact: "true" }, { no_artifact: true });
    check("get_search_content", { responseId: "fixture", offset: "42" }, { responseId: "fixture", offset: 42 });
    check("questionnaire", { questions: [{ ...question, label: null, allowOther: "false" }] }, { questions: [{ ...question, allowOther: false }] });
    check("browser", { action: "pages", index: null, fullPage: null, values: null }, { action: "pages" });
    check("web_search", { query: null, queries: ["fixture"] }, { queries: ["fixture"] });
    check("load_tools", { tools: null }, {});
    check("web_search", { queries: "fixture" }, { queries: ["fixture"] });
    check("questionnaire", { questions: question }, { questions: [question] });
    console.log(`[pi-host] ${checks} validator cases across ${tools.size} tools with ${host.source}; pi-ai ${JSON.parse(readFileSync(join(dirname(hostAiEntry), "../package.json"), "utf8")).version}`);
  });
});

(supportsResponsesToolChanges ? test : test.skip)("Pi Responses converter declarations are trimmed by the loaded ctxtrim handler", async () => {
  await withAgentDir(async (agentDir) => {
    const converterPath = join(dirname(hostAiEntry), "api/openai-responses-shared.js");
    const { convertResponsesMessages } = await import(pathToFileURL(converterPath).href);
    const runtime = await host.module.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModels("openai-codex").find((candidate) => candidate.compat?.supportsAdditionalTools && candidate.compat?.supportsMidConvoSystemMessages);
    assert.ok(model, "selected host must have a model using additional_tools");
    const context = hostAi.normalizeContext({ systemPrompt: "Fixture.", tools: [{
      name: "ctx_execute", description: "Verbose fixture. Keep execution routing.",
      parameters: { type: "object", properties: { code: { type: "string", description: "Code to run. More prose." } }, required: ["code"] },
    }], messages: [{ role: "user", content: "Fixture.", timestamp: 0 }] });
    const input = convertResponsesMessages(model, context, new Set([model.provider]), {
      includeSystemPrompt: false, supportsAdditionalTools: true, supportsMidConvoSystemMessages: true, toolOptions: { strict: null },
    });
    const payload = { model: model.id, input };
    const before = structuredClone(payload);
    assert.ok(input.some((item) => item.type === "additional_tools"), "exercise the actual declaration encoding");
    const loaded = await host.module.discoverAndLoadExtensions(["extensions/opl-ctxtrim/index.ts"], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const handler = loaded.extensions[0].handlers.get("before_provider_request")[0];
    const out = await handler({ payload }, {});
    const declaration = out.input.find((item) => item.type === "additional_tools").tools[0];
    assert.match(declaration.description, /^Run code in a sandbox;/);
    assert.equal(declaration.parameters.properties.code.description, "Code to run.");
    assert.deepEqual(declaration.parameters.required, ["code"]);
    assert.deepEqual(out.input.filter((item) => item.type !== "additional_tools"), input.filter((item) => item.type !== "additional_tools"));
    assert.deepEqual(payload, before);
  });
});

(supportsResponsesToolChanges ? test : test.skip)("Pi inline Anthropic tool_addition declarations are trimmed by the loaded ctxtrim handler", async () => {
  // The Anthropic converter is not exported, so pin the shape from the selected host's own
  // source and then run the real handler against it: a fixture that quietly drifts from the
  // provider request would otherwise keep this test green while production stayed untrimmed.
  const source = readFileSync(join(dirname(hostAiEntry), "api/anthropic-messages.js"), "utf8");
  assert.match(source, /type: "tool_addition", tool: \{ type: "tool_definition", definition \}/, "host no longer nests inline tool definitions this way");

  const verbose = "Verbose context-mode description. Routing prose that should be replaced. ".repeat(8);
  const payload = {
    model: "claude-opus-5",
    tools: [{ name: "ctx_search", description: verbose, input_schema: { type: "object", properties: { queries: { type: "string", description: "Queries array. More prose." } } } }],
    messages: [{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "ctx_search", description: verbose, input_schema: { type: "object", properties: { queries: { type: "string", description: "Queries array. More prose." } } } } } }] }],
  };
  const before = structuredClone(payload);
  await withAgentDir(async (agentDir) => {
    const loaded = await host.module.discoverAndLoadExtensions(["extensions/opl-ctxtrim/index.ts"], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const handler = loaded.extensions[0].handlers.get("before_provider_request")[0];
    const out = await handler({ payload }, {});
    for (const declaration of [out.tools[0], out.messages[0].content[0].tool.definition]) {
      assert.match(declaration.description, /^Search the indexed knowledge base/);
      assert.equal(declaration.input_schema.properties.queries.description, "Queries array.");
    }
    assert.deepEqual(payload, before, "input must not be mutated");
  });
});

(resetsExtensionOverlayRegistry ? test : test.skip)("Pi resetExtensionUI drains every extension overlay and opl-todo forgets its handle", async () => {
  await withAgentDir(async (agentDir) => {
    // Real host method, stubbed collaborators: the 1.5.1 contract our recovery depends on is
    // that ALL extension overlays are removed, newest first, including a hidden one, because
    // reload and session switches never call the extension's done().
    const { InteractiveMode } = await import(pathToFileURL(join(dirname(host.entry), "modes/interactive/interactive-mode.js")).href);
    const receiver = Object.create(InteractiveMode.prototype);
    const removed = [];
    const overlay = (id) => ({ dispose: () => removed.push(`dispose:${id}`) });
    receiver.extensionDialogs = [];
    receiver.extensionOverlays = new Map();
    for (const id of ["older", "newer"]) {
      const component = overlay(id);
      receiver.extensionOverlays.set(id, () => {
        receiver.extensionOverlays.delete(id);
        component.dispose?.();
      });
    }
    receiver.showTopExtensionDialog = () => {};
    receiver.clearExtensionTerminalInputListeners = () => {};
    receiver.setExtensionFooter = () => {};
    receiver.setExtensionHeader = () => {};
    receiver.clearExtensionWidgets = () => {};
    receiver.setCustomEditorComponent = () => {};
    receiver.setupAutocompleteProvider = () => {};
    receiver.footerDataProvider = { clearExtensionStatuses: () => {} };
    receiver.footer = { invalidate: () => {} };
    receiver.autocompleteProviderWrappers = [];
    receiver.defaultEditor = {};
    receiver.activeStatusIndicator = undefined;
    receiver.updateTerminalTitle = () => {};
    receiver.setWorkingIndicator = () => {};
    receiver.setHiddenThinkingLabel = () => {};

    receiver.resetExtensionUI();
    assert.deepEqual(removed, ["dispose:newer", "dispose:older"], "every extension overlay must be disposed, newest first");
    assert.equal(receiver.extensionOverlays.size, 0);

    // And the extension side of the seam: opl-todo must clean up on session_shutdown, since
    // the host leaves the custom() promise pending and a retained OverlayHandle is inert.
    const loaded = await host.module.discoverAndLoadExtensions(["extensions/opl-todo/index.ts"], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const handlers = loaded.extensions[0].handlers;
    assert.ok(handlers.has("session_shutdown"), "opl-todo must register session_shutdown to drop the overlay handle");
    assert.ok(handlers.has("session_start"), "opl-todo must re-mount the widget on session_start");
  });
});

// These use the actual selected-host dialog/status implementation and real
// questionnaire rendering/input, with controlled focus/terminal fixtures, not a live TUI.
async function withQuestionnaireDialog(run) {
  await withAgentDir(async (agentDir) => {
    const { InteractiveMode } = await import(pathToFileURL(join(dirname(host.entry), "modes/interactive/interactive-mode.js")).href);
    const { initTheme } = await import(pathToFileURL(join(dirname(host.entry), "modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const tuiEntry = hostFile(host, "@earendil-works/pi-tui");
    const { Container, visibleWidth } = await import(pathToFileURL(tuiEntry).href);
    const reporterModule = supportsProgramStatus ? await import(pathToFileURL(join(dirname(host.entry), "modes/interactive/program-status-reporter.js")).href) : null;
    const statusModule = supportsProgramStatus ? await import(pathToFileURL(join(dirname(tuiEntry), "program-status.js")).href) : null;
    const loaded = await host.module.discoverAndLoadExtensions(["extensions/opl-questionnaire/index.ts"], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const tool = loaded.extensions[0].tools.get("questionnaire").definition;
    const question = (id = "scope") => ({ id, prompt: `Choose ${id}`, allowOther: true, options: [{ value: "a", label: "Option A" }] });
    function fixture() {
      const statuses = [], reports = [];
      const receiver = Object.create(InteractiveMode.prototype);
      let draft = "preserved editor draft";
      receiver.editor = { getText: () => draft, setText: (value) => { draft = value; }, render: () => [draft], invalidate() {} };
      receiver.editorContainer = new Container();
      receiver.editorContainer.addChild(receiver.editor);
      receiver.extensionDialogs = [];
      receiver.keybindings = { matches: () => false };
      receiver.disposeActiveSelector = () => {};
      const terminal = { columns: 100, rows: 30, setProgramStatus(status) { statuses.push(status); reports.push(statusModule.formatProgramStatus(status)); } };
      receiver.ui = { terminal, requestRender() {}, setFocus(component) { this.focused = component; }, focused: receiver.editor };
      receiver.programStatus = supportsProgramStatus
        ? new reporterModule.ProgramStatusReporter(() => terminal, () => "Fixture")
        : { setBlocked() { throw new Error("old host must ignore metadata"); } };
      if (supportsProgramStatus) receiver.programStatus.handleEvent({ type: "agent_start" });
      let capturedOptions;
      const ctx = { mode: "tui", ui: { custom(factory, options) { capturedOptions = options; return receiver.showExtensionCustom(factory, options); } } };
      return { receiver, statuses, reports, ctx, options: () => capturedOptions, draft: () => draft };
    }
    async function open(questions) {
      const f = fixture();
      const result = tool.execute("fixture", { questions }, undefined, undefined, f.ctx);
      for (let i = 0; i < 10 && f.receiver.ui.focused === f.receiver.editor; i++) await Promise.resolve();
      const component = f.receiver.ui.focused;
      assert.notEqual(component, f.receiver.editor, "actual host mounts and focuses the questionnaire");
      assert.deepEqual(f.options(), { overlay: false, blocked: { kind: "question", message: "Answer the questionnaire" } });
      const lines = f.receiver.editorContainer.render(80);
      assert.ok(lines.some((line) => line.includes("Choose")));
      assert.ok(lines.every((line) => visibleWidth(line) <= 80));
      if (supportsProgramStatus) {
        assert.equal(f.statuses.at(-1).state, "blocked");
        assert.equal(f.statuses.at(-1).kind, "question");
        assert.ok(f.reports.at(-1).includes("state=blocked"));
        assert.ok(f.reports.at(-1).includes("kind=question"));
      } else assert.deepEqual(f.statuses, []);
      return { ...f, component, result };
    }
    function restored(f) {
      assert.equal(f.receiver.ui.focused, f.receiver.editor);
      assert.equal(f.draft(), "preserved editor draft");
      if (supportsProgramStatus) {
        assert.equal(f.statuses.at(-1).state, "working", "closing clears blocked status and resumes the run");
        assert.equal(f.receiver.extensionDialogs.length, 0);
        f.receiver.programStatus.handleEvent({ type: "agent_settled", aborted: false });
        assert.equal(f.statuses.at(-1).state, "done");
      } else assert.deepEqual(f.statuses, []);
    }
    await run({ tool, question, fixture, open, restored });
  });
}

for (const cancel of [false, true]) {
  test(`Pi questionnaire ${cancel ? "cancellation" : "answer"} restores editor and run status`, async () => {
    await withQuestionnaireDialog(async ({ question, open, restored }) => {
      const f = await open([question()]);
      f.component.handleInput(cancel ? "\x1b" : "1");
      const result = await f.result;
      assert.equal(result.details.cancelled, cancel);
      if (!cancel) assert.equal(result.details.answers[0].value, "a");
      restored(f);
    });
  });
}

test("Pi questionnaire remains mounted until every question is answered and submitted", async () => {
  await withQuestionnaireDialog(async ({ question, open, restored }) => {
    const f = await open([question("scope"), question("priority")]);
    // Premature submission must not close the dialog.
    f.component.handleInput("\t");
    f.component.handleInput("\t");
    f.component.handleInput("\r");
    assert.notEqual(f.receiver.ui.focused, f.receiver.editor);
    f.component.handleInput("\t");
    f.component.handleInput("1");
    assert.notEqual(f.receiver.ui.focused, f.receiver.editor);
    f.component.handleInput("1");
    assert.notEqual(f.receiver.ui.focused, f.receiver.editor);
    f.component.handleInput("\r");
    const result = await f.result;
    assert.deepEqual(result.details.answers.map((answer) => answer.id), ["scope", "priority"]);
    restored(f);
  });
});

test("Pi questionnaire custom text uses the host editor and submits", async () => {
  await withQuestionnaireDialog(async ({ question, open, restored }) => {
    const f = await open([question()]);
    f.component.handleInput("2");
    f.component.handleInput("custom answer");
    f.component.handleInput("\r");
    const result = await f.result;
    assert.equal(result.details.answers[0].wasCustom, true);
    assert.equal(result.details.answers[0].value, "custom answer");
    restored(f);
  });
});

test("Pi questionnaire invalid and noninteractive calls do not mount or report blocked", async () => {
  await withQuestionnaireDialog(async ({ tool, question, fixture }) => {
    const f = fixture();
    const invalid = await tool.execute("fixture", { questions: [] }, undefined, undefined, f.ctx);
    assert.equal(invalid.isError, true);
    const headless = await tool.execute("fixture", { questions: [question()] }, undefined, undefined, { ...f.ctx, mode: "print" });
    assert.equal(headless.isError, true);
    assert.equal(f.options(), undefined);
    assert.equal(f.receiver.ui.focused, f.receiver.editor);
    assert.ok(!f.statuses.some((status) => status.state === "blocked"));
  });
});

test("Pi custom factory failure does not leave blocked status or lose the editor draft", async () => {
  await withQuestionnaireDialog(async ({ fixture }) => {
    const f = fixture();
    await assert.rejects(f.receiver.showExtensionCustom(() => { throw new Error("fixture failure"); }, {
      overlay: false, blocked: { kind: "question", message: "Fixture" },
    }), /fixture failure/);
    assert.ok(!f.statuses.some((status) => status.state === "blocked"));
    assert.equal(f.draft(), "preserved editor draft");
  });
});

// Pi 1.2 added custom-triggered before_agent_start events. Older hosts still run the
// loader check above and the extension unit cases, but cannot exercise this host contract.
for (const mode of ["chat", "plan"]) {
  (supportsCustomRunLifecycle ? test : test.skip)(`Pi host keeps ${mode} instructions across custom and user runs with tools`, async () => {
    await withAgentDir(async (agentDir) => {
      const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = host.module;
      const { AssistantMessageEventStream, getCurrentSystemMessage } = hostAi;
      const cwd = join(agentDir, "workspace");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "note.txt"), "compatibility fixture\n");
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const starts = [];
      let pi;
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        additionalExtensionPaths: [join(process.cwd(), "extensions/opl-modes/index.ts")],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: "Compatibility fixture.",
        extensionFactories: [(api) => {
          pi = api;
          api.on("before_agent_start", (event, ctx) => {
            starts.push({ messageType: event.messageType, hasPrompt: Object.hasOwn(event, "prompt"), idle: ctx.isIdle() });
          });
        }],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
      });
      // A fixture key satisfies preflight; the replaced stream below never calls a provider.
      await modelRuntime.setRuntimeApiKey("anthropic", "compatibility-fixture-not-a-real-key");
      const model = modelRuntime.getModels("anthropic")[0];
      assert.ok(model);
      const { session } = await createAgentSession({
        cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
      });
      const errors = [];
      const prompts = [];
      let readNext = false;
      session.agent.streamFunction = async (activeModel, context) => {
        prompts.push(getCurrentSystemMessage(context.messages));
        const stream = new AssistantMessageEventStream();
        const read = readNext;
        readNext = false;
        const message = {
          role: "assistant", api: activeModel.api, provider: activeModel.provider, model: activeModel.id, timestamp: Date.now(),
          stopReason: read ? "toolUse" : "stop",
          content: read
            ? [{ type: "toolCall", id: `fixture-read-${prompts.length}`, name: "read", arguments: { path: "note.txt" } }]
            : [{ type: "text", text: "Fixture completed." }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        return stream;
      };
      try {
        await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
        await session.prompt(mode === "plan" ? "/plan compatibility-fixture" : "/mode chat");
        readNext = true;
        pi.sendMessage({ customType: "compatibility-fixture", content: "Continue the work.", display: false }, { triggerTurn: true });
        await session.waitForIdle();
        readNext = true;
        await session.prompt("Continue the work.");

        assert.deepEqual(starts, [
          { messageType: "custom", hasPrompt: false, idle: false },
          { messageType: "user", hasPrompt: true, idle: false },
        ]);
        assert.equal(prompts.length, 4, "each run requests a tool and then a follow-up");
        const marker = mode === "chat" ? /CHAT MODE/ : /PLAN MODE/;
        for (const prompt of prompts) assert.match(JSON.stringify(prompt), marker);
        assert.deepEqual(prompts[0], prompts[1], "custom-run prompt survives the first tool call");
        assert.deepEqual(prompts[2], prompts[3], "user-run prompt survives the first tool call");
        const results = session.messages.filter((message) => message.role === "toolResult");
        assert.equal(results.length, 2);
        assert.ok(results.every((result) => !result.isError && result.content.some((part) => part.type === "text" && part.text.includes("compatibility fixture"))));
        assert.deepEqual(errors, []);
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
        session.dispose();
      }
    });
  }, 15_000);
}

test("Pi normalizes built-in Bash arguments before extension handlers run", async () => {
  // Why the extensions' non-string command guards are defense-in-depth rather than the
  // primary gate: the host's coercing validator already rejects arrays and stringifies
  // scalars, and it never rewrites the transcripted arguments themselves.
  const { createBashToolDefinition } = await import(pathToFileURL(join(dirname(host.entry), "core/tools/bash.js")).href);
  const definition = createBashToolDefinition(process.cwd());
  const validate = (args) => hostAi.validateToolArguments(definition, { type: "toolCall", id: "fixture", name: "bash", arguments: args });
  assert.throws(() => validate({ command: ["rm", "-rf"] }), /command/);
  assert.throws(() => validate({ count: 3 }), /command/);
  assert.deepEqual(validate({ command: 42 }), { command: "42" });
  assert.deepEqual(validate({ command: null }), { command: "null" });
  assert.deepEqual(validate({ command: "ls", count: null }), { command: "ls", count: null });
  const call = { type: "toolCall", id: "fixture", name: "bash", arguments: { command: 42 } };
  hostAi.validateToolArguments(definition, call);
  assert.deepEqual(call.arguments, { command: 42 }, "normalization must not rewrite transcript arguments");
});
