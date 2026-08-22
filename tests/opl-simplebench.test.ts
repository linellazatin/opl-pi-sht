import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { parseCommandArgs } from "../extensions/opl-simplebench/index";
import { artifactFileName, writeArtifact } from "../extensions/opl-simplebench/artifact";
import { recommendation } from "../extensions/opl-simplebench/report";
import { aggregateMetrics, metricsFromChat, usageFromRaw, emptyMetrics } from "../extensions/opl-simplebench/metrics";
import { scoreReasoning } from "../extensions/opl-simplebench/scoring";
import { REASONING_TESTS, MULTISTEP_INSTRUCTION } from "../extensions/opl-simplebench/tests";

test("parses no-artifact for named and all-model runs", () => {
  assert.deepEqual(parseCommandArgs("global.openai.gpt-5.6-terra --no-artifact"), {
    model: "global.openai.gpt-5.6-terra", allModels: false, writeArtifact: false,
  });
  assert.deepEqual(parseCommandArgs("--all --no-artifact"), {
    model: undefined, allModels: true, writeArtifact: false,
  });
});

test("writes artifacts in the current working directory", () => {
  assert.match(artifactFileName("global.openai.gpt-5.6-terra", new Date("2026-08-23T12:00:00Z")), /^simplebench-global\.openai\.gpt-5\.6-terra-2026-08-23T12-00-00Z\.json$/);
  const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "simplebench-test-"));
  try {
    process.chdir(temp);
    const output = writeArtifact({ schemaVersion: 1, benchmark: { name: "opl-simplebench", model: "test/model", provider: "test", providerKind: "test", startedAt: "", finishedAt: "", wallTimeMs: 0, artifactEnabled: true }, tests: [], summary: {} });
    assert.equal(fs.realpathSync(path.dirname(output)), fs.realpathSync(temp));
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).benchmark.model, "test/model");
  } finally {
    process.chdir(cwd);
    fs.rmSync(temp, { recursive: true });
  }
});

test("keeps benchmark fixtures and extracted scorer available to the runner", () => {
  assert.equal(REASONING_TESTS.length, 20);
  assert.match(MULTISTEP_INSTRUCTION, /valid JSON object/);
  assert.deepEqual(scoreReasoning("The answer is 8 because the snail climbs.", "8"), {
    answer: "8", extractionMethod: "expected-substring", matchedWords: ["because"], score: "STRONG", passed: true,
  });
});

test("extracts OpenAI, Bedrock, and Ollama authoritative usage", () => {
  assert.deepEqual(usageFromRaw({ usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }), { inputTokens: 5, outputTokens: 10, totalTokens: 15, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 } }), { inputTokens: 4, outputTokens: 8, totalTokens: 12, outputTokensPerSecond: null });
  assert.deepEqual(usageFromRaw({ prompt_eval_count: 3, eval_count: 6, eval_duration: 2_000_000_000 }), { inputTokens: 3, outputTokens: 6, totalTokens: 9, outputTokensPerSecond: 3 });
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


