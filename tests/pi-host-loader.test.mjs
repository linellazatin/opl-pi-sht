import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "bun:test";

// Load the extensions with the Pi build this machine actually runs, not the
// local devDependency, so a new release's loader (and its `@earendil-works/*`
// aliases) is exercised before users hit it. Falls back to the resolved
// devDependency when no managed install is present, e.g. in CI.
function findManagedInstallEntry() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir, "install");
  const versionFile = join(installRoot, "current-version");
  if (!existsSync(versionFile)) return null;

  const version = readFileSync(versionFile, "utf8").trim();
  if (!version) return null;
  const packageDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const entry = join(packageDir, manifest.main ?? "dist/index.js");
  return existsSync(entry) ? { entry, version: manifest.version ?? version } : null;
}

async function loadHost() {
  const installed = findManagedInstallEntry();
  if (installed) {
    const module = await import(pathToFileURL(installed.entry).href);
    return { module, entry: installed.entry, version: installed.version, source: `installed pi ${installed.version}` };
  }
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const module = await import(pathToFileURL(entry).href);
  return { module, entry, version: module.VERSION, source: `devDependency pi ${module.VERSION ?? "unknown"}` };
}

const execFileAsync = promisify(execFile);
const host = await loadHost();
const [major, minor] = host.version.split(".").map(Number);
const supportsCustomRunLifecycle = major > 1 || (major === 1 && minor >= 2);
const supportsResponsesToolChanges = major > 1 || (major === 1 && minor >= 4);
const hostAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai", pathToFileURL(host.entry).href));
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
