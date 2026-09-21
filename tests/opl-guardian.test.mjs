import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  buildIncidentRecord,
  guardAssistantMessage,
  isMalformedToolCall,
} from "../extensions/opl-guardian/guardian.ts";
import { appendIncident, guardMessageEnd } from "../extensions/opl-guardian/index.ts";

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
