import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import {
  buildIncidentRecord,
  guardAssistantMessage,
  isMalformedToolCall,
} from "../extensions/opl-guardian/guardian.ts";
import { appendIncident, guardMessageEnd } from "../extensions/opl-guardian/index.ts";
import { DEFAULT_CONFIG, parseGuardianConfig } from "../extensions/opl-guardian/config.ts";
import { getProtectedPathBlock, hasPendingUserWork, matchesProtectedPath } from "../extensions/opl-guardian/policies.ts";
import {
  createMessageEndHandler,
  createSessionBeforeForkHandler,
  createSessionBeforeSwitchHandler,
  createToolCallHandler,
} from "../extensions/opl-guardian/index.ts";

function toolCall(id, name, arguments_ = {}) {
  return { type: "toolCall", id, name, arguments: arguments_ };
}

function assistantWith(content) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
    responseId: "gen-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

test("recognizes blank and whitespace-only tool-call identities", () => {
  assert.equal(isMalformedToolCall(toolCall("", "read")), true);
  assert.equal(isMalformedToolCall(toolCall(" ", "read")), true);
  assert.equal(isMalformedToolCall(toolCall("call", "")), true);
  assert.equal(isMalformedToolCall(toolCall("call", "  ")), true);
  assert.equal(isMalformedToolCall(toolCall("call", "read")), false);
});

test("leaves an assistant message with valid tool calls unchanged", () => {
  const message = assistantWith([toolCall("call_ok", "read")]);
  assert.equal(guardAssistantMessage(message), undefined);
});

test("removes malformed calls while preserving valid call order and tool use", () => {
  const result = guardAssistantMessage(assistantWith([
    { type: "text", text: "Checking." },
    toolCall("call_read", "read"),
    toolCall("call_bad", " ", { web_search: "query" }),
    toolCall("call_find", "find"),
  ]));

  assert.equal(result.removedToolCalls.length, 1);
  assert.deepEqual(result.message.content.map((block) => block.type === "toolCall" ? block.name : block.text), [
    "Checking.", "read", "find",
  ]);
  assert.equal(result.message.stopReason, "toolUse");
});

test("turns an invalid-only response into a text-ready stop with no tool calls", () => {
  const result = guardAssistantMessage(assistantWith([
    toolCall(" ", "read"),
    toolCall("call_bad", ""),
  ]));

  assert.equal(result.removedToolCalls.length, 2);
  assert.equal(result.message.stopReason, "stop");
  assert.equal(result.message.content.some((block) => block.type === "toolCall"), false);
});

test("builds an incident record containing only metadata and removed calls", () => {
  const message = assistantWith([toolCall("call_bad", "", { web_search: "query" })]);
  const removedToolCalls = message.content;
  const incident = buildIncidentRecord(message, {
    sessionId: "session-test",
    cwd: "/tmp/project",
  }, removedToolCalls);

  assert.deepEqual(incident, {
    timestamp: new Date(0).toISOString(),
    kind: "malformed_tool_call",
    sessionId: "session-test",
    cwd: "/tmp/project",
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
    responseId: "gen-test",
    action: "dropped",
    removedToolCalls,
  });
});

test("keeps only replayable calls with non-empty OpenAI function names", () => {
  const result = guardAssistantMessage(assistantWith([
    toolCall("call_ok", "read"),
    toolCall("call_bad", " "),
  ]));
  const replay = result.message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ function: { name: block.name } }));

  assert.deepEqual(replay, [{ function: { name: "read" } }]);
  assert.equal(replay.every((call) => call.function.name.trim().length > 0), true);
});

test("appends one JSON object per incident under the project err directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-"));
  const incident = buildIncidentRecord(assistantWith([]), {
    sessionId: "session-test",
    cwd,
  }, [toolCall("call_bad", "")]);

  try {
    await appendIncident(cwd, incident);
    const log = await readFile(join(cwd, "err", "guardian.jsonl"), "utf8");
    assert.deepEqual(JSON.parse(log.trim()), incident);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mixed responses log the dropped calls and retain valid calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-"));
  const message = assistantWith([toolCall("call_ok", "read"), toolCall("call_bad", "")]);

  try {
    const replacement = await guardMessageEnd(message, { cwd, sessionId: "session-test" });
    assert.equal(replacement.message.stopReason, "toolUse");
    assert.equal(replacement.message.content.some(isMalformedToolCall), false);
    assert.match(replacement.message.content.at(-1).text, /err\/guardian\.jsonl/);
    const log = await readFile(join(cwd, "err", "guardian.jsonl"), "utf8");
    assert.equal(JSON.parse(log).removedToolCalls[0].id, "call_bad");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("logging failure still strips invalid-only calls and reports the failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-"));
  await mkdir(join(cwd, "err", "guardian.jsonl"), { recursive: true });

  try {
    const replacement = await guardMessageEnd(assistantWith([toolCall("call_bad", "")]), {
      cwd,
      sessionId: "session-test",
    });
    assert.equal(replacement.message.stopReason, "stop");
    assert.equal(replacement.message.content.some((block) => block.type === "toolCall"), false);
    assert.match(replacement.message.content[0].text, /could not write err\/guardian\.jsonl/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("guardian config defaults enable all protections", () => {
  const { config, warnings } = parseGuardianConfig(undefined);
  assert.deepEqual(warnings, []);
  assert.equal(config.dropMalformedToolCalls, true);
  assert.equal(config.permissionGate.blockWithoutUI, true);
  assert.equal(config.permissionGate.patterns.length, 5);
  assert.equal(config.protectedPaths.paths.length, 4);
  assert.deepEqual(config.confirmDestructive, {
    clearSession: true,
    switchWithUnsavedWork: true,
    forkSession: true,
    blockWithoutUI: true,
  });
});

test("default permission gate recognizes reordered and separate recursive-delete flags", () => {
  const { config } = parseGuardianConfig(undefined);
  const matches = (command) => config.permissionGate.patterns.some((pattern) => pattern.test(command));
  for (const command of ["rm -rf /tmp/probe", "rm -fr /tmp/probe", "rm -f -r /tmp/probe", "rm --force --recursive /tmp/probe", "rm -v -R /tmp/probe"]) {
    assert.equal(matches(command), true, command);
  }
  assert.equal(matches("rm -f /tmp/probe"), false);
  assert.equal(matches("rm -rf-not-a-flag /tmp/probe"), false);
});

test("sample configuration detects the same recursive-delete variants as defaults", () => {
  const sample = JSON.parse(readFileSync("configs/opl-guardian.json.sample", "utf8"));
  const { config } = parseGuardianConfig(sample);
  assert.equal(config.permissionGate.patterns.some((pattern) => pattern.test("rm -f -r /tmp/probe")), true);
});

test("guardian config overrides fields and permits explicit empty policy arrays", () => {
  const { config, warnings } = parseGuardianConfig({
    permissionGate: { patterns: [], blockWithoutUI: false },
    protectedPaths: { paths: [] },
    confirmDestructive: { clearSession: false, blockWithoutUI: false },
    dropMalformedToolCalls: false,
    ignored: true,
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.permissionGate.patterns.length, 0);
  assert.equal(config.permissionGate.blockWithoutUI, false);
  assert.deepEqual(config.protectedPaths.paths, []);
  assert.deepEqual(config.confirmDestructive, {
    clearSession: false,
    switchWithUnsavedWork: true,
    forkSession: true,
    blockWithoutUI: false,
  });
  assert.equal(config.dropMalformedToolCalls, false);
});

test("guardian config reports invalid patterns while retaining valid ones", () => {
  const { config, warnings } = parseGuardianConfig({
    permissionGate: { patterns: ["danger", "[", 42] },
  });
  assert.equal(config.permissionGate.patterns.length, 1);
  assert.equal(config.permissionGate.patterns[0].test("dangerous"), true);
  assert.equal(warnings.length, 2);
});

test("guardian config falls back to defaults if configured patterns all fail", () => {
  const { config, warnings } = parseGuardianConfig({
    permissionGate: { patterns: ["["] },
  });
  assert.equal(config.permissionGate.patterns.length, DEFAULT_CONFIG.permissionGate.patterns.length);
  assert.equal(warnings.length, 1);
});

test("guardian config warnings do not echo configured regex contents", () => {
  const secretPattern = "private-value[";
  const { warnings } = parseGuardianConfig({ permissionGate: { patterns: [secretPattern] } });
  assert.doesNotMatch(warnings.join("\n"), /private-value/);
});

test("guardian config ignores invalid protected-path entries but retains valid ones", () => {
  const { config, warnings } = parseGuardianConfig({
    protectedPaths: { paths: [
      { path: ".private/", deny: ["read"] },
      { path: "", deny: ["write"] },
      { path: ".secret", deny: ["execute"] },
      null,
    ] },
  });
  assert.deepEqual(config.protectedPaths.paths, [{ path: ".private/", deny: ["read"] }]);
  assert.equal(warnings.length, 3);
});

test("malformed guardian config sections safely fall back to defaults", () => {
  const { config, warnings } = parseGuardianConfig({
    permissionGate: null,
    protectedPaths: { paths: "not-an-array" },
    confirmDestructive: { forkSession: "yes" },
    dropMalformedToolCalls: "false",
  });
  assert.equal(config.permissionGate.patterns.length, 5);
  assert.equal(config.protectedPaths.paths.length, 4);
  assert.equal(config.confirmDestructive.forkSession, true);
  assert.equal(config.dropMalformedToolCalls, true);
  assert.equal(warnings.length, 4);
});

test("bare protected paths match exact file and directory segments", () => {
  const env = { path: ".env", deny: ["read"] };
  const modules = { path: "node_modules/", deny: ["write"] };
  assert.equal(matchesProtectedPath("src/.env", env, "/project"), true);
  assert.equal(matchesProtectedPath(".envrc", env, "/project"), false);
  assert.equal(matchesProtectedPath("src/node_modules/pkg/a.js", modules, "/project"), true);
  assert.equal(matchesProtectedPath("src/not-node_modules/pkg/a.js", modules, "/project"), false);
});

test("absolute and home-relative protected paths match paths and descendants on boundaries", () => {
  const absolute = { path: "/secret", deny: ["read"] };
  const home = { path: "~/.pi/agent/auth.json", deny: ["read"] };
  assert.equal(matchesProtectedPath("/secret", absolute, "/project"), true);
  assert.equal(matchesProtectedPath("/secret/nested/file", absolute, "/project"), true);
  assert.equal(matchesProtectedPath("/secretly/file", absolute, "/project"), false);
  assert.equal(matchesProtectedPath(join(homedir(), ".pi/agent/auth.json"), home, "/project"), true);
});

test("relative tool paths resolve against the supplied project cwd", () => {
  const entry = { path: "/project/private", deny: ["read"] };
  assert.equal(matchesProtectedPath("private/file.txt", entry, "/project"), true);
  assert.equal(matchesProtectedPath("private-other/file.txt", entry, "/project"), false);
});

test("path block lookup honors operation deny lists", () => {
  const paths = [
    { path: ".env", deny: ["read", "write"] },
    { path: "node_modules/", deny: ["write"] },
  ];
  assert.deepEqual(getProtectedPathBlock("read", "configs/.env", paths, "/project"), {
    path: ".env", operation: "read",
  });
  assert.equal(getProtectedPathBlock("edit", "configs/.env", paths, "/project"), undefined);
  assert.deepEqual(getProtectedPathBlock("write", "node_modules/pkg/index.js", paths, "/project"), {
    path: "node_modules/", operation: "write",
  });
});

test("file tools block a symlink that resolves to a protected bare file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-path-"));
  try {
    await writeFile(join(cwd, ".env"), "fixture");
    await symlink(join(cwd, ".env"), join(cwd, "alias"));
    assert.deepEqual(getProtectedPathBlock("read", "alias", [{ path: ".env", deny: ["read"] }], cwd), {
      path: ".env", operation: "read",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file tools block new writes through symlinked parent directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-path-"));
  try {
    await mkdir(join(cwd, "private"));
    await symlink(join(cwd, "private"), join(cwd, "shortcut"));
    assert.deepEqual(getProtectedPathBlock("write", "shortcut/new/child.txt", [
      { path: join(cwd, "private"), deny: ["write"] },
    ], cwd), { path: join(cwd, "private"), operation: "write" });
    assert.equal(getProtectedPathBlock("write", "ordinary/new.txt", [
      { path: join(cwd, "private"), deny: ["write"] },
    ], cwd), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file tools block dangling symlinks targeting a protected new file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-path-"));
  try {
    await mkdir(join(cwd, "private"));
    await symlink(join(cwd, "private", "new.txt"), join(cwd, "alias"));
    assert.deepEqual(getProtectedPathBlock("write", "alias", [
      { path: join(cwd, "private"), deny: ["write"] },
    ], cwd), { path: join(cwd, "private"), operation: "write" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file-tool path aliases use the same normalization as Pi's built-in tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-path-"));
  try {
    const protectedFile = join(cwd, "private", "file.txt");
    await mkdir(join(cwd, "private"));
    const entries = [{ path: join(cwd, "private"), deny: ["read"] }];
    assert.deepEqual(getProtectedPathBlock("read", `@${protectedFile}`, entries, cwd), {
      path: join(cwd, "private"), operation: "read",
    });
    assert.deepEqual(getProtectedPathBlock("read", pathToFileURL(protectedFile).href, entries, cwd), {
      path: join(cwd, "private"), operation: "read",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file tools fail closed on an unresolvable symlink cycle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-path-"));
  try {
    await symlink("loop", join(cwd, "loop"));
    const result = getProtectedPathBlock("write", "loop", [{ path: "private/", deny: ["write"] }], cwd);
    assert.equal(result?.operation, "write");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Bash protected-path lookup preserves literal command matching", () => {
  const paths = [
    { path: ".env", deny: ["bash"] },
    { path: "~/.pi/agent/auth.json", deny: ["bash"] },
  ];
  assert.deepEqual(getProtectedPathBlock("bash", "cat project/.env.local", paths, "/project"), {
    path: ".env", operation: "bash",
  });
  assert.deepEqual(getProtectedPathBlock("bash", "cat ~/.pi/agent/auth.json", paths, "/project"), {
    path: "~/.pi/agent/auth.json", operation: "bash",
  });
  assert.equal(getProtectedPathBlock("bash", "echo harmless", paths, "/project"), undefined);
});

function fakeToolContext({ hasUI = true, choice = "yes" } = {}) {
  const state = { prompts: 0, notifications: [] };
  const theme = { fg: (_color, text) => text };
  return {
    state,
    context: {
      cwd: "/project",
      hasUI,
      ui: {
        notify: (message, level) => state.notifications.push({ message, level }),
        setToolsExpanded() {},
        getToolsExpanded: () => false,
        custom: async (factory) => {
          state.prompts++;
          let result;
          factory({ requestRender() {} }, theme, { matches: () => false }, (value) => { result = value; });
          result = choice;
          return result;
        },
      },
    },
  };
}

test("tool-call policy lets ordinary Bash commands pass without prompting", async () => {
  const { config } = parseGuardianConfig({ permissionGate: { patterns: ["danger"] }, protectedPaths: { paths: [] } });
  const handler = createToolCallHandler(config);
  const { context, state } = fakeToolContext();
  assert.equal(await handler({ type: "tool_call", toolCallId: "call_test", toolName: "bash", input: { command: "echo hello" } }, context), undefined);
  assert.equal(state.prompts, 0);
});

test("tool-call policy allows a dangerous Bash command only after affirmative confirmation", async () => {
  const { config } = parseGuardianConfig({ permissionGate: { patterns: ["danger"] }, protectedPaths: { paths: [] } });
  const handler = createToolCallHandler(config);
  const { context, state } = fakeToolContext({ choice: "yes" });
  assert.equal(await handler({ type: "tool_call", toolCallId: "call_test", toolName: "bash", input: { command: "run danger" } }, context), undefined);
  assert.equal(state.prompts, 1);
});

test("tool-call policy blocks a rejected or canceled dangerous Bash command", async () => {
  for (const choice of ["no", null]) {
    const { config } = parseGuardianConfig({ permissionGate: { patterns: ["danger"] }, protectedPaths: { paths: [] } });
    const handler = createToolCallHandler(config);
    const { context } = fakeToolContext({ choice });
    const result = await handler({ type: "tool_call", toolCallId: "call_test", toolName: "bash", input: { command: "run danger" } }, context);
    assert.equal(result.block, true);
    assert.match(result.reason, /blocked by user/i);
  }
});

test("RPC dangerous Bash approval uses a supported dialog", async () => {
  const config = parseGuardianConfig({ permissionGate: { patterns: ["danger"] }, protectedPaths: { paths: [] } }).config;
  const event = { type: "tool_call", toolCallId: "rpc", toolName: "bash", input: { command: "danger" } };
  let dialogs = 0;
  const ctx = { cwd: "/project", mode: "rpc", hasUI: true, ui: {
    custom: async () => { throw new Error("RPC does not support custom UI"); },
    select: async () => { dialogs++; return "Yes"; },
  } };
  assert.equal(await createToolCallHandler(config)(event, ctx), undefined);
  assert.equal(dialogs, 1);
  ctx.ui.select = async () => undefined;
  assert.equal((await createToolCallHandler(config)(event, ctx)).block, true);
  ctx.ui.select = async () => { throw new Error("RPC frontend unavailable"); };
  assert.equal((await createToolCallHandler(config)(event, ctx)).block, true);
});

test("tool-call policy honors permissionGate.blockWithoutUI", async () => {
  const blocked = parseGuardianConfig({ permissionGate: { patterns: ["danger"], blockWithoutUI: true }, protectedPaths: { paths: [] } }).config;
  const allowed = parseGuardianConfig({ permissionGate: { patterns: ["danger"], blockWithoutUI: false }, protectedPaths: { paths: [] } }).config;
  const event = { type: "tool_call", toolCallId: "call_test", toolName: "bash", input: { command: "run danger" } };
  assert.equal((await createToolCallHandler(blocked)(event, fakeToolContext({ hasUI: false }).context)).block, true);
  assert.equal(await createToolCallHandler(allowed)(event, fakeToolContext({ hasUI: false }).context), undefined);
});

test("tool-call policy blocks protected file paths and notifies the user", async () => {
  const { config } = parseGuardianConfig({ permissionGate: { patterns: ["danger"] } });
  const handler = createToolCallHandler(config);
  const { context, state } = fakeToolContext();
  const result = await handler({ type: "tool_call", toolCallId: "call_test", toolName: "read", input: { path: ".env" } }, context);
  assert.equal(result.block, true);
  assert.match(result.reason, /\.env/);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].level, "warning");
});

test("protected Bash paths block before dangerous-command prompts", async () => {
  const { config } = parseGuardianConfig({
    permissionGate: { patterns: ["\\.env"] },
    protectedPaths: { paths: [{ path: ".env", deny: ["bash"] }] },
  });
  const handler = createToolCallHandler(config);
  const { context, state } = fakeToolContext();
  const result = await handler({ type: "tool_call", toolCallId: "call_test", toolName: "bash", input: { command: "cat .env" } }, context);
  assert.equal(result.block, true);
  assert.equal(state.prompts, 0);
});

function sessionEntry(role) {
  return { type: "message", message: { role } };
}

function fakeSessionContext({ hasUI = true, confirmed = true, entries = [] } = {}) {
  const state = { confirmations: [] };
  return {
    state,
    context: {
      hasUI,
      ui: {
        confirm: async (title, message) => {
          state.confirmations.push({ title, message });
          return confirmed;
        },
      },
      sessionManager: { getEntries: () => entries, getBranch: () => entries },
    },
  };
}

test("pending session work means a user message after the most recent assistant", () => {
  assert.equal(hasPendingUserWork([sessionEntry("user"), sessionEntry("assistant")]), false);
  assert.equal(hasPendingUserWork([sessionEntry("user"), sessionEntry("assistant"), sessionEntry("toolResult")]), false);
  assert.equal(hasPendingUserWork([sessionEntry("assistant"), sessionEntry("user")]), true);
  assert.equal(hasPendingUserWork([]), false);
});

test("session-before-switch confirms clear and cancels when rejected", async () => {
  const config = parseGuardianConfig(undefined).config;
  const handler = createSessionBeforeSwitchHandler(config);
  const event = { type: "session_before_switch", reason: "new" };
  const accepted = fakeSessionContext();
  assert.equal(await handler(event, accepted.context), undefined);
  assert.equal(accepted.state.confirmations.length, 1);
  const rejected = fakeSessionContext({ confirmed: false });
  assert.deepEqual(await handler(event, rejected.context), { cancel: true });
});

test("session-before-switch confirms resume only when there is pending user work", async () => {
  const config = parseGuardianConfig(undefined).config;
  const handler = createSessionBeforeSwitchHandler(config);
  const event = { type: "session_before_switch", reason: "resume" };
  const pending = fakeSessionContext({ entries: [sessionEntry("assistant"), sessionEntry("user")] });
  assert.equal(await handler(event, pending.context), undefined);
  assert.equal(pending.state.confirmations.length, 1);
  const completed = fakeSessionContext({ entries: [sessionEntry("user"), sessionEntry("assistant")] });
  assert.equal(await handler(event, completed.context), undefined);
  assert.equal(completed.state.confirmations.length, 0);
});

test("session switch ignores unanswered messages on abandoned branches", async () => {
  const config = parseGuardianConfig(undefined).config;
  const { context, state } = fakeSessionContext({ confirmed: false });
  context.sessionManager.getEntries = () => [sessionEntry("user"), sessionEntry("assistant"), sessionEntry("user")];
  context.sessionManager.getBranch = () => [sessionEntry("user"), sessionEntry("assistant")];
  assert.equal(await createSessionBeforeSwitchHandler(config)({ type: "session_before_switch", reason: "resume" }, context), undefined);
  assert.equal(state.confirmations.length, 0);
  context.sessionManager.getBranch = () => [sessionEntry("assistant"), sessionEntry("user")];
  assert.deepEqual(await createSessionBeforeSwitchHandler(config)({ type: "session_before_switch", reason: "resume" }, context), { cancel: true });
});

test("session-before-fork confirms and cancels when rejected", async () => {
  const config = parseGuardianConfig(undefined).config;
  const handler = createSessionBeforeForkHandler(config);
  const event = { type: "session_before_fork", entryId: "entry-123", position: "at" };
  const rejected = fakeSessionContext({ confirmed: false });
  assert.deepEqual(await handler(event, rejected.context), { cancel: true });
  assert.equal(rejected.state.confirmations.length, 1);
});

test("session confirmation flags disable their corresponding prompts", async () => {
  const config = parseGuardianConfig({
    confirmDestructive: { clearSession: false, switchWithUnsavedWork: false, forkSession: false },
  }).config;
  const beforeSwitch = createSessionBeforeSwitchHandler(config);
  const beforeFork = createSessionBeforeForkHandler(config);
  const clear = fakeSessionContext();
  const resume = fakeSessionContext({ entries: [sessionEntry("user")] });
  const fork = fakeSessionContext();
  assert.equal(await beforeSwitch({ type: "session_before_switch", reason: "new" }, clear.context), undefined);
  assert.equal(await beforeSwitch({ type: "session_before_switch", reason: "resume" }, resume.context), undefined);
  assert.equal(await beforeFork({ type: "session_before_fork", entryId: "entry", position: "at" }, fork.context), undefined);
  assert.equal(clear.state.confirmations.length + resume.state.confirmations.length + fork.state.confirmations.length, 0);
});

test("configured session actions block without UI unless explicitly opted out", async () => {
  const blockConfig = parseGuardianConfig(undefined).config;
  const allowConfig = parseGuardianConfig({ confirmDestructive: { blockWithoutUI: false } }).config;
  const switchEvent = { type: "session_before_switch", reason: "new" };
  const forkEvent = { type: "session_before_fork", entryId: "entry", position: "at" };
  assert.deepEqual(await createSessionBeforeSwitchHandler(blockConfig)(switchEvent, fakeSessionContext({ hasUI: false }).context), { cancel: true });
  assert.deepEqual(await createSessionBeforeForkHandler(blockConfig)(forkEvent, fakeSessionContext({ hasUI: false }).context), { cancel: true });
  assert.equal(await createSessionBeforeSwitchHandler(allowConfig)(switchEvent, fakeSessionContext({ hasUI: false }).context), undefined);
  assert.equal(await createSessionBeforeForkHandler(allowConfig)(forkEvent, fakeSessionContext({ hasUI: false }).context), undefined);
});

test("message-end guard is enabled by default and preserves malformed-call filtering", async () => {
  const config = parseGuardianConfig(undefined).config;
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-"));
  try {
    const handler = createMessageEndHandler(config);
    const replacement = await handler({ type: "message_end", message: assistantWith([toolCall("call_bad", "")]) }, {
      cwd,
      sessionManager: { getSessionId: () => "session-test" },
      ui: { notify() {} },
    });
    assert.equal(replacement.message.stopReason, "stop");
    assert.equal(replacement.message.content.some((block) => block.type === "toolCall"), false);
    assert.equal(existsSync(join(cwd, "err", "guardian.jsonl")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disabling malformed-call filtering leaves assistant messages and JSONL untouched", async () => {
  const config = parseGuardianConfig({ dropMalformedToolCalls: false }).config;
  const cwd = await mkdtemp(join(tmpdir(), "opl-guardian-"));
  const message = assistantWith([toolCall("call_bad", "")]);
  try {
    const replacement = await createMessageEndHandler(config)({ type: "message_end", message }, {
      cwd,
      sessionManager: { getSessionId: () => "session-test" },
      ui: { notify() {} },
    });
    assert.equal(replacement, undefined);
    assert.equal(existsSync(join(cwd, "err", "guardian.jsonl")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
