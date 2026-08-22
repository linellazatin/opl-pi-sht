import type { RequestMetrics, TestRecord } from "./types";

export function usageFromRaw(raw: any): Pick<RequestMetrics, "inputTokens" | "outputTokens" | "totalTokens" | "outputTokensPerSecond"> {
  const usage = raw?.usage;
  const inputTokens = usage?.prompt_tokens ?? usage?.inputTokens ?? raw?.prompt_eval_count ?? null;
  const outputTokens = usage?.completion_tokens ?? usage?.outputTokens ?? raw?.eval_count ?? null;
  const totalTokens = usage?.total_tokens ?? usage?.totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const evalDurationNs = raw?.eval_duration;
  const outputTokensPerSecond = outputTokens !== null && typeof evalDurationNs === "number" && evalDurationNs > 0
    ? outputTokens / (evalDurationNs / 1_000_000_000)
    : null;
  return { inputTokens, outputTokens, totalTokens, outputTokensPerSecond };
}

export function metricsFromChat(result: { elapsedMs: number; raw?: unknown; requestCount?: number; retryCount?: number; startedAt?: string; finishedAt?: string; timeToFirstTokenMs?: number | null; toolCalls?: any[] }): RequestMetrics {
  return {
    requestCount: result.requestCount ?? 1,
    retryCount: result.retryCount ?? 0,
    wallTimeMs: result.elapsedMs,
    timeToAnswerMs: result.elapsedMs,
    timeToFirstTokenMs: result.timeToFirstTokenMs ?? null,
    startedAt: result.startedAt ?? null,
    finishedAt: result.finishedAt ?? null,
    ...usageFromRaw(result.raw),
    toolCalls: (result.toolCalls ?? []).map((call: any) => ({
      name: call.function?.name ?? call.name ?? "?",
      arguments: call.function?.arguments ?? call.arguments,
    })),
  };
}

export function emptyMetrics(): RequestMetrics {
  return { requestCount: 1, retryCount: 0, wallTimeMs: 0, timeToAnswerMs: 0, timeToFirstTokenMs: null, startedAt: null, finishedAt: null, inputTokens: null, outputTokens: null, totalTokens: null, outputTokensPerSecond: null, toolCalls: [] };
}

export function aggregateMetrics(tests: TestRecord[]) {
  const values = tests.map(t => t.metrics.wallTimeMs).sort((a, b) => a - b);
  const knownTotal = (key: "inputTokens" | "outputTokens" | "totalTokens") => {
    const known = tests.map(t => t.metrics[key]).filter((value): value is number => value !== null);
    return known.length === tests.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const toolCallsByName: Record<string, number> = {};
  for (const test of tests) for (const call of test.metrics.toolCalls) toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
  const outputRateNumerator = tests.reduce((sum, test) => sum + (test.metrics.outputTokens ?? 0), 0);
  const outputRateDenominator = tests.reduce((sum, test) => sum + (test.metrics.outputTokensPerSecond && test.metrics.outputTokens ? test.metrics.outputTokens / test.metrics.outputTokensPerSecond : 0), 0);
  const percentile = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)] : 0;
  return {
    requests: { total: tests.reduce((sum, test) => sum + test.metrics.requestCount, 0), successful: tests.filter(test => !test.error).length, failed: tests.filter(test => !!test.error).length, retries: tests.reduce((sum, test) => sum + test.metrics.retryCount, 0) },
    toolCalls: { total: tests.reduce((sum, test) => sum + test.metrics.toolCalls.length, 0), byName: toolCallsByName },
    inputTokens: knownTotal("inputTokens"), outputTokens: knownTotal("outputTokens"), totalTokens: knownTotal("totalTokens"),
    outputTokensPerSecond: outputRateDenominator > 0 ? outputRateNumerator / outputRateDenominator : null,
    latency: { averageMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0, medianMs: values.length ? values[Math.floor(values.length / 2)] : 0, p95Ms: percentile, minMs: values[0] ?? 0, maxMs: values.at(-1) ?? 0 },
  };
}
