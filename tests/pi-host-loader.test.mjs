import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    return { module, version: installed.version, source: `installed pi ${installed.version}` };
  }
  const module = await import("@earendil-works/pi-coding-agent");
  return { module, version: module.VERSION, source: `devDependency pi ${module.VERSION ?? "unknown"}` };
}

const host = await loadHost();
const [major, minor] = host.version.split(".").map(Number);
const supportsCustomRunLifecycle = major > 1 || (major === 1 && minor >= 2);

async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "opl-pi-host-loader-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
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

// Pi 1.2 added custom-triggered before_agent_start events. Older hosts still run the
// loader check above and the extension unit cases, but cannot exercise this host contract.
for (const mode of ["chat", "plan"]) {
  (supportsCustomRunLifecycle ? test : test.skip)(`Pi host keeps ${mode} instructions across custom and user runs with tools`, async () => {
    await withAgentDir(async (agentDir) => {
      const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = host.module;
      const { AssistantMessageEventStream, getCurrentSystemMessage } = await import("@earendil-works/pi-ai");
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
