import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { parseCommandArgs } from "../extensions/opl-simplebench/index";
import { buildToolContinuationMessages, createBenchmark, hasOllamaAssistantOutput, openAiThinkingOptions, resolveBenchmarkModel, resolveThinkingMode } from "../extensions/opl-simplebench/benchmark";
import { artifactFileName, writeArtifact } from "../extensions/opl-simplebench/artifact";
import { codingRecommendation, formatInstructionScore, recommendation } from "../extensions/opl-simplebench/report";
import { aggregateMetrics, mergeRequestMetrics, metricsFromChat, usageFromRaw, emptyMetrics } from "../extensions/opl-simplebench/metrics";
import { scoreReasoning } from "../extensions/opl-simplebench/scoring";
import { REASONING_TESTS, MULTISTEP_INSTRUCTION } from "../extensions/opl-simplebench/tests";
import { CODING_LITE_TASKS, createCodingTaskDir, resolveCodingPath, runCodingTask, runCodingVerifier } from "../extensions/opl-simplebench/coding";

test("parses artifact and thinking-max benchmark modes", () => {
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --no-artifact"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: false, thinkingMax: false, codingLite: false, testAll: false,
  });
  assert.deepEqual(parseCommandArgs("--all --no-artifact"), {
    model: undefined, allModels: true, writeArtifact: false, thinkingMax: false, codingLite: false, testAll: false,
  });
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --thinking-max"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: true, thinkingMax: true, codingLite: false, testAll: false,
  });
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --coding-lite"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: true, thinkingMax: false, codingLite: true, testAll: false,
  });
  assert.deepEqual(parseCommandArgs("--all --test-all"), {
    model: undefined, allModels: true, writeArtifact: true, thinkingMax: false, codingLite: false, testAll: true,
  });
});

test("leaves OpenAI-compatible sampling at provider defaults unless thinking max is requested", () => {
  assert.deepEqual(openAiThinkingOptions(false), {});
  assert.deepEqual(openAiThinkingOptions(true), { reasoning_effort: "max" });
});

test("resolves Bedrock max thinking from Pi model metadata", () => {
  const active = { id: "anthropic.claude-opus-4-8", provider: "amazon-bedrock", api: "bedrock-converse-stream", reasoning: true, thinkingLevelMap: { max: "max" } };
  assert.deepEqual(resolveBenchmarkModel({ model: active }, active.id), { model: active, source: "active-context" });
  assert.deepEqual(resolveBenchmarkModel({ getScopedModels: () => [{ model: active }] }, `amazon-bedrock/${active.id}`), { model: active, source: "scoped-model" });
  assert.deepEqual(resolveThinkingMode({ kind: "bedrock" }, active, true), {
    requested: "max", effective: "pi-bedrock-reasoning", level: "max",
  });
  assert.throws(() => resolveThinkingMode({ kind: "bedrock" }, { ...active, thinkingLevelMap: {} }, true), /does not advertise max thinking/);
});

test("writes artifacts in the current working directory", () => {
  assert.equal(artifactFileName("global.openai.gpt-5.6-terra", "test-all", "max", new Date("2026-08-23T12:00:00Z")), "simplebench--test-all-global.openai.gpt-5.6-terra-max-2026-08-23T12-00-00Z.json");
  assert.equal(artifactFileName("global.openai.gpt-5.6-terra", "baseline", "default", new Date("2026-08-23T12:00:00Z")), "simplebench--3ptest-global.openai.gpt-5.6-terra-default-2026-08-23T12-00-00Z.json");
  const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "simplebench-test-"));
  try {
    process.chdir(temp);
    const output = writeArtifact({ schemaVersion: 1, benchmark: { name: "opl-simplebench", model: "test/model", provider: "test", providerKind: "test", thinking: { requested: "default", effective: "provider-default", level: null, modelMetadataSource: null }, startedAt: "", finishedAt: "", wallTimeMs: 0, artifactEnabled: true }, tests: [], summary: {} });
    const artifact = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(fs.realpathSync(path.dirname(output)), fs.realpathSync(temp));
    assert.equal(artifact.benchmark.model, "test/model");
    assert.deepEqual(artifact.benchmark.thinking, { requested: "default", effective: "provider-default", level: null, modelMetadataSource: null });
  } finally {
    process.chdir(cwd);
    fs.rmSync(temp, { recursive: true });
  }
});

test("does not overwrite an artifact created within the same second", () => {
  const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "simplebench-artifact-"));
  const artifact = { schemaVersion: 1 as const, benchmark: { name: "opl-simplebench" as const, model: "test/model", provider: "test", providerKind: "test", thinking: { requested: "default" as const, effective: "provider-default" as const, level: null, modelMetadataSource: null }, startedAt: "", finishedAt: "", wallTimeMs: 0, artifactEnabled: true }, tests: [], summary: {} };
  try {
    process.chdir(temp);
    assert.notEqual(writeArtifact(artifact), writeArtifact(artifact));
  } finally {
    process.chdir(cwd);
    fs.rmSync(temp, { recursive: true });
  }
});

test("keeps benchmark fixtures and extracted scorer available to the runner", () => {
  assert.equal(REASONING_TESTS.length, 20);
  assert.match(MULTISTEP_INSTRUCTION, /valid JSON object/);
  assert.deepEqual(scoreReasoning("The answer is 8 because the snail climbs.", "8"), {
    answer: "8", extractionMethod: "expected-substring", matchedWords: ["because"], score: "STRONG", pass: true,
  });
});

test("uses the pass property consumed by the reasoning runner", () => {
  assert.equal(scoreReasoning("The answer is 8 because it reaches the top.", "8").pass, true);
});

test("uses unambiguous and alternate-valid reasoning fixtures", () => {
  const rooster = REASONING_TESTS.find(test => test.name === "commonsense");
  const code = REASONING_TESTS.find(test => test.name === "code_simplify");
  const analogy = REASONING_TESTS.find(test => test.name === "analogy_2");
  assert.match(rooster?.prompt ?? "", /Can a rooster lay an egg/);
  assert.equal(rooster?.expectedAnswer, "no");
  assert.match(code?.prompt ?? "", /value will x have/);
  assert.equal(code?.expectedAnswer, "15");
  assert.deepEqual(analogy?.expectedAnswer, ["boot", "sock"]);
  assert.equal(scoreReasoning("ANSWER: Sock", analogy?.expectedAnswer ?? "").pass, true);
  assert.equal(scoreReasoning("That premise is not possible.", "no").pass, false);
});

test("canonicalizes compass directions for direct result inspection", () => {
  assert.equal(scoreReasoning("ANSWER: W", "west").answer, "west");
  assert.equal(scoreReasoning("I am facing east.", "east").pass, true);
  assert.equal(scoreReasoning("ANSWER: south", "west").pass, false);
});

test("extracts OpenAI, Bedrock, and Ollama authoritative usage", () => {
  assert.deepEqual(usageFromRaw({ usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }), { inputTokens: 5, outputTokens: 10, totalTokens: 15, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 } }), { inputTokens: 4, outputTokens: 8, totalTokens: 12, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ prompt_eval_count: 3, eval_count: 6, eval_duration: 2_000_000_000 }), { inputTokens: 3, outputTokens: 6, totalTokens: 9, outputTokensPerSecond: 3 });
});

test("keeps tool-only Ollama responses and accumulates multi-turn metrics", () => {
  assert.equal(hasOllamaAssistantOutput("", "", [{ function: { name: "list_files" } }]), true);
  assert.equal(hasOllamaAssistantOutput("", "", []), false);
  const merged = mergeRequestMetrics([
    metricsFromChat({ elapsedMs: 10, raw: { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }, toolCalls: [{ function: { name: "list_files" } }] }),
    metricsFromChat({ elapsedMs: 20, raw: { usage: { prompt_tokens: 8, completion_tokens: 11, total_tokens: 19 } } }),
  ]);
  assert.deepEqual(merged, { ...merged, requestCount: 2, wallTimeMs: 30, inputTokens: 13, outputTokens: 18, totalTokens: 31, toolCalls: [{ name: "list_files", arguments: undefined }] });
});

test("renders an instruction-score line", () => {
  assert.match(formatInstructionScore({ pass: true, score: "STRONG", schemaValid: true }), /Instruction following: STRONG \(schema valid\)/);
  assert.match(formatInstructionScore({ pass: false, score: "FAIL", schemaValid: false }), /Instruction following: FAIL \(schema invalid\)/);
});

test("includes coding-lite as a recommendation category when present", () => {
  assert.deepEqual(recommendation("MODERATE", true, true, { passed: 4, total: 6 }), { label: "GOOD", passed: 4, total: 4 });
  assert.deepEqual(recommendation("MODERATE", true, true, { passed: 0, total: 6 }), { label: "USABLE", passed: 3, total: 4 });
});

test("scores standalone coding-lite runs independently", () => {
  assert.deepEqual(codingRecommendation(6, 6), { label: "STRONG", passed: 6, total: 6 });
  assert.deepEqual(codingRecommendation(4, 6), { label: "GOOD", passed: 4, total: 6 });
  assert.deepEqual(codingRecommendation(2, 6), { label: "USABLE", passed: 2, total: 6 });
});

test("aggregates complete request metrics without treating unavailable tokens as zero", () => {
  const first = metricsFromChat({ elapsedMs: 10, raw: { usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }, requestCount: 2, retryCount: 1, startedAt: "a", finishedAt: "b" });
  const second = { ...emptyMetrics(), wallTimeMs: 30, timeToAnswerMs: 30, toolCalls: [{ name: "calculate", arguments: { expression: "15*24" } }] };
  const aggregate = aggregateMetrics([
    { id: "one", kind: "reasoning" as const, prompt: "", response: "", score: "STRONG", passed: true, error: null, metrics: first },
    { id: "two", kind: "tools" as const, prompt: "", response: "", score: "ERROR", passed: false, error: "failed", metrics: second },
  ]);
  assert.deepEqual(aggregate.requests, { total: 3, successful: 1, failed: 1, retries: 1 });
  assert.deepEqual(aggregate.toolCalls, { total: 1, byName: { calculate: 1 } });
  assert.equal(aggregate.totalTokens, null);
  assert.equal(aggregate.latency.averageMs, 20);
});

test("builds strict llama-server tool-result history with matching IDs", () => {
  const messages = buildToolContinuationMessages(
    [{ role: "system", content: "Use tools." }, { role: "user", content: "Get Tokyo weather and calculate 15*24." }],
    "",
    [
      { id: "weather01", function: { name: "get_weather", arguments: { location: "Tokyo" } } },
      { function: { name: "calculate", arguments: { expression: "15*24" } } },
    ],
    ["Tokyo: clear, 22C", "360"],
  );

  assert.equal(messages.length, 5);
  assert.deepEqual(messages[2], {
    role: "assistant", content: "", tool_calls: [
      { id: "weather01", function: { name: "get_weather", arguments: { location: "Tokyo" } } },
      { id: "toolcall2", function: { name: "calculate", arguments: { expression: "15*24" } } },
    ],
  });
  assert.deepEqual(messages.slice(3), [
    { role: "tool", tool_call_id: "weather01", content: "Tokyo: clear, 22C" },
    { role: "tool", tool_call_id: "toolcall2", content: "360" },
  ]);
  assert.equal(messages.some(message => message.role === "user" && message.content.includes("Tokyo: clear")), false);
});

test("completes the baseline tool loop with strict llama-server message roles", async () => {
  let turns = 0;
  const result = await createBenchmark().testToolUsageExtended(async (_model, messages, options) => {
    turns += 1;
    if (turns === 1) {
      assert.equal((options?.tools as unknown[])?.length, 2);
      return { content: "", elapsedMs: 1, toolCalls: [
        { id: "weather01", function: { name: "get_weather", arguments: { location: "Tokyo" } } },
        { id: "calc00001", function: { name: "calculate", arguments: { expression: "15*24" } } },
      ] };
    }
    assert.equal((options?.tools as unknown[])?.length, 2);
    assert.equal(messages[2].role, "assistant");
    assert.equal(messages[2].tool_calls?.length, 2);
    assert.deepEqual(messages.slice(3).map(message => message.role), ["tool", "tool"]);
    assert.deepEqual(messages.slice(3).map(message => message.tool_call_id), ["weather01", "calc00001"]);
    return { content: "Tokyo is clear and 22C. 15 multiplied by 24 is 360.", elapsedMs: 1 };
  }, "strict-local-model");
  assert.equal(turns, 2);
  assert.equal(result.score, "STRONG");
  assert.equal(result.pass, true);
});

test("defines six isolated coding-lite fixtures", () => {
  assert.equal(CODING_LITE_TASKS.length, 6);
  assert.equal(new Set(CODING_LITE_TASKS.map(task => task.id)).size, 6);
});

test("keeps coding-lite file operations inside the task directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simplebench-coding-path-"));
  try {
    assert.equal(resolveCodingPath(root, "src/example.js"), path.join(root, "src/example.js"));
    assert.throws(() => resolveCodingPath(root, "../outside.js"), /outside the coding task/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("runs public and hidden coding-lite verification independently", () => {
  const task = CODING_LITE_TASKS[0];
  const root = createCodingTaskDir(task);
  try {
    assert.equal(runCodingVerifier(task, root, "public").passed, true);
    assert.equal(runCodingVerifier(task, root, "hidden").passed, false);
    fs.writeFileSync(path.join(root, "src", "sum.mjs"), "export function sumInclusive(start, end) { let total = 0; for (let value = start; value <= end; value += 1) total += value; return total; }\n");
    assert.equal(runCodingVerifier(task, root, "hidden").passed, true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("emits coding progress while the model turn is running", async () => {
  const progress: string[] = [];
  await runCodingTask(async () => ({ content: "finished", elapsedMs: 1 }), "test-model", CODING_LITE_TASKS[0], { onProgress: message => progress.push(message) });
  assert.ok(progress.some(message => message.includes("agent turn 1")));
});

test("continues coding-lite with assistant tool calls followed by tool results", async () => {
  let turn = 0;
  const result = await runCodingTask(async (_model, messages) => {
    turn += 1;
    if (turn === 1) return { content: "", elapsedMs: 1, toolCalls: [{ function: { name: "list_files", arguments: "{}" } }] };
    assert.equal(messages[2].role, "assistant");
    assert.equal(messages[2].tool_calls?.length, 1);
    assert.deepEqual(messages.slice(3).map(message => message.role), ["tool"]);
    assert.match(messages[3].content, /TOOL_RESULT list_files:/);
    assert.match(messages[3].tool_call_id || "", /^[A-Za-z0-9]{9}$/);
    return { content: "done", elapsedMs: 1 };
  }, "strict-local-model", CODING_LITE_TASKS[0]);
  assert.equal(turn, 2);
  assert.equal(result.turns, 2);
});

test("recovers from malformed coding-tool arguments and tracks every turn", async () => {
  let turn = 0;
  const result = await runCodingTask(async (_model, messages) => {
    turn += 1;
    if (turn === 1) return { content: "", elapsedMs: 1, raw: { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, toolCalls: [{ function: { name: "read_file", arguments: "{" } }] };
    assert.match(messages.at(-1)?.content || "", /invalid JSON arguments/);
    return { content: "done", elapsedMs: 1, raw: { usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } } };
  }, "test-model", CODING_LITE_TASKS[0]);
  assert.equal(turn, 2);
  assert.equal(result.metrics.requestCount, 2);
  assert.equal(result.metrics.outputTokens, 8);
  assert.equal(result.metrics.toolCalls[0]?.name, "read_file");
});

test("returns recoverable errors when a coding agent searches a missing path", async () => {
  let turn = 0;
  const result = await runCodingTask(async (_model, _messages, _options) => {
    turn += 1;
    if (turn === 1) return { content: "", elapsedMs: 1, toolCalls: [{ function: { name: "search_files", arguments: JSON.stringify({ query: "format", path: "test" }) } }] };
    return { content: "done", elapsedMs: 1 };
  }, "test-model", CODING_LITE_TASKS.find(task => task.id === "safe-refactor")!);
  assert.equal(result.turns, 2);
  assert.ok(!result.error?.includes("ENOENT"));
});
