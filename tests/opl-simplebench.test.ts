import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { parseCommandArgs } from "../extensions/opl-simplebench/index";
import { openAiThinkingOptions, resolveBenchmarkModel, resolveThinkingMode } from "../extensions/opl-simplebench/benchmark";
import { artifactFileName, writeArtifact } from "../extensions/opl-simplebench/artifact";
import { formatInstructionScore, recommendation } from "../extensions/opl-simplebench/report";
import { aggregateMetrics, metricsFromChat, usageFromRaw, emptyMetrics } from "../extensions/opl-simplebench/metrics";
import { scoreReasoning } from "../extensions/opl-simplebench/scoring";
import { REASONING_TESTS, MULTISTEP_INSTRUCTION } from "../extensions/opl-simplebench/tests";

test("parses artifact and thinking-max benchmark modes", () => {
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --no-artifact"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: false, thinkingMax: false,
  });
  assert.deepEqual(parseCommandArgs("--all --no-artifact"), {
    model: undefined, allModels: true, writeArtifact: false, thinkingMax: false,
  });
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --thinking-max"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: true, thinkingMax: true,
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
  assert.match(artifactFileName("global.openai.gpt-5.6-terra", new Date("2026-08-23T12:00:00Z")), /^simplebench-global\.openai\.gpt-5\.6-terra-2026-08-23T12-00-00Z\.json$/);
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

test("extracts OpenAI, Bedrock, and Ollama authoritative usage", () => {
  assert.deepEqual(usageFromRaw({ usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }), { inputTokens: 5, outputTokens: 10, totalTokens: 15, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 } }), { inputTokens: 4, outputTokens: 8, totalTokens: 12, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ prompt_eval_count: 3, eval_count: 6, eval_duration: 2_000_000_000 }), { inputTokens: 3, outputTokens: 6, totalTokens: 9, outputTokensPerSecond: 3 });
});

test("renders an instruction-score line", () => {
  assert.match(formatInstructionScore({ pass: true, score: "STRONG", schemaValid: true }), /Instruction following: STRONG \(schema valid\)/);
  assert.match(formatInstructionScore({ pass: false, score: "FAIL", schemaValid: false }), /Instruction following: FAIL \(schema invalid\)/);
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


