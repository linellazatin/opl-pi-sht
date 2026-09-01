import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { section, ok, fail, warn, info, msHuman, truncate, sanitizeForReport } from "./util/format";
import { getOllamaBaseUrl, detectProvider } from "./util/providers";
import { debugLog } from "./util/debug";
import { CONFIG, WEATHER_TOOL_DEFINITION, buildToolResultMessages, getEffectiveConfig, readTestConfig, type ChatFn, type ChatMessage } from "./util/config";
import { branding as sharedBranding, codingRecommendation, formatInstructionScore, formatTestSummary, recommendation } from "./report";
import { writeArtifact, writeArtifactBundle } from "./artifact";
import { aggregateMetrics, emptyMetrics, mergeRequestMetrics, metricsFromChat } from "./metrics";
import { REASONING_TESTS, MULTISTEP_INSTRUCTION, CALC_TOOL_DEFINITION } from "./tests";
import { CODING_LITE_TASKS, runCodingTask } from "./coding";
import { runGroundedResearchTask, runResearchArtifactTask, searchConfiguredResearch } from "./research";
import { scoreReasoning, averageScore } from "./scoring";
import { applyLlamagputop, applyLlamagputopModelStats, buildServerStats, fetchLlamaServerMetrics, fetchLlamaServerProps, fetchLlamagputopHealth, fetchLlamagputopStats, type ServerStats } from "./llama-server";
import type { SimplebenchOptions, TestRecord } from "./types";

type BenchmarkModel = { id: string; provider?: string; api?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };
type BenchmarkContext = { model?: BenchmarkModel; getScopedModels?: () => ReadonlyArray<{ model: BenchmarkModel }> };

type ThinkingMode = { requested: "default" | "max"; effective: "provider-default" | "openai-reasoning-effort" | "pi-bedrock-reasoning"; level: "max" | null };

export function buildToolContinuationMessages(initial: ChatMessage[], assistantContent: string, calls: any[], results: string[]): ChatMessage[] {
  return [...initial, ...buildToolResultMessages(assistantContent, calls, results)];
}

export function hasOllamaAssistantOutput(content: string, thinking: string, toolCalls: any[]): boolean {
  return !!(content.trim() || thinking.trim() || toolCalls.length);
}

export function resolveBenchmarkModel(ctx: BenchmarkContext | undefined, modelId: string): { model: BenchmarkModel | undefined; source: "active-context" | "scoped-model" | null } {
  if (ctx?.model && (ctx.model.id === modelId || `${ctx.model.provider}/${ctx.model.id}` === modelId)) return { model: ctx.model, source: "active-context" };
  const model = ctx?.getScopedModels?.().find(({ model }) => model.id === modelId || `${model.provider}/${model.id}` === modelId)?.model;
  return { model, source: model ? "scoped-model" : null };
}

export function resolveThinkingMode(providerInfo: { kind: string; apiMode?: string }, model: BenchmarkModel | undefined, thinkingMax: boolean): ThinkingMode {
  if (!thinkingMax) return { requested: "default", effective: "provider-default", level: null };
  if (providerInfo.apiMode === "openai-completions") return { requested: "max", effective: "openai-reasoning-effort", level: "max" };
  if (providerInfo.kind === "bedrock") {
    if (!model?.reasoning || !model.thinkingLevelMap?.max) throw new Error("The selected Bedrock model does not advertise max thinking");
    return { requested: "max", effective: "pi-bedrock-reasoning", level: "max" };
  }
  throw new Error("--thinking-max is supported only for OpenAI-compatible and direct Bedrock models");
}

export function isValidInstructionOutput(output: string): boolean {
  try {
    const parsed = JSON.parse(output.trim());
    return !!parsed && !Array.isArray(parsed) && typeof parsed === "object"
      && Object.keys(parsed).length === 3
      && parsed.operation === "status"
      && parsed.requestId === "bench-42"
      && parsed.ok === true;
  } catch {
    return false;
  }
}

export function openAiThinkingOptions(thinkingMax: boolean): Record<string, string> {
  return thinkingMax ? { reasoning_effort: "max" } : {};
}

export function createBenchmark() {
// Use effective config (user overrides merged with defaults)
const effectiveConfig = getEffectiveConfig();

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Get the current Ollama base URL.
 * Re-reads on every call so /ollama-sync changes take effect immediately.
 */
function ollamaBase(): string {
  return getOllamaBaseUrl();
}

/**
 * Sleep for the configured test delay to avoid rate limiting.
 */
async function rateLimitDelay(): Promise<void> {
  if (effectiveConfig.TEST_DELAY_MS > 0) {
    await new Promise(r => setTimeout(r, effectiveConfig.TEST_DELAY_MS));
  }
}

// ── ChatFn wrappers ──────────────────────────────────────────────────

/**
 * Create a chat function for Ollama API.
 */
function makeOllamaChatFn(useStreaming = true): ChatFn {
  return async (model, messages, options) => {
    const chatFn = useStreaming ? ollamaChatStream : ollamaChat;
    const startedAt = new Date().toISOString();
    const result = await chatFn(model, messages, options ?? {});
    return {
      content: result.response?.message?.content || "",
      toolCalls: result.response?.message?.tool_calls,
      elapsedMs: result.elapsedMs,
      raw: result.response,
      requestCount: result.requestCount,
      retryCount: result.retryCount,
      startedAt,
      finishedAt: new Date().toISOString(),
      timeToFirstTokenMs: result.timeToFirstTokenMs,
    };
  };
}

/**
 * Create a chat function for OpenAI-compatible API (OpenRouter, OpenAI, etc.).
 */
function makeOpenAiChatFn(baseUrl: string, apiKey?: string, thinkingMax = false): ChatFn {
  return async (model, messages, options) => {
    const tools = (options?.tools as any[] | undefined) || undefined;
    const body: any = {
      model,
      messages,
      stream: false,
      cache: { "no-cache": true }, // bypass LiteLLM proxy response cache — benchmarks must measure real inference
      ...openAiThinkingOptions(thinkingMax),
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.function?.name || t.name,
          description: t.function?.description || t.description,
          parameters: t.function?.parameters || t.parameters,
        },
      }));
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TEST_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - start;
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "unknown error");
        throw new Error(`OpenAI API returned ${res.status}: ${truncate(errorText, 200)}`);
      }

      const parsed = await res.json();
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content || "";
      const toolCalls = choice?.message?.tool_calls;
      return {
        content,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        elapsedMs,
        raw: parsed,
      };
    } catch (e: any) {
      clearTimeout(timeoutId);
      throw e;
    }
  };
}

/**
 * Resolve AWS credentials: env vars first, then the AWS CLI
 * (`aws configure export-credentials`), which handles static keys,
 * assume-role chains (source_profile + role_arn), and SSO.
 * # ponytail: requires AWS CLI v2; cached per process
 */
let _awsCredsCache: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null | undefined;
function resolveAwsCredentials(): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null {
  if (_awsCredsCache !== undefined) return _awsCredsCache;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    _awsCredsCache = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
    return _awsCredsCache;
  }
  try {
    const prof = process.env.AWS_PROFILE || "default";
    const out = require("node:child_process")
      .execSync(`aws configure export-credentials --profile ${prof}`, { timeout: 15000 })
      .toString();
    const c = JSON.parse(out);
    if (c.AccessKeyId && c.SecretAccessKey) {
      _awsCredsCache = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
      return _awsCredsCache;
    }
  } catch { /* aws CLI missing or profile unresolvable */ }
  _awsCredsCache = null;
  return null;
}

/** Minimal SigV4 signer for a POST to the Bedrock Converse API. */
function sigv4Headers(
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  host: string, urlPath: string, body: string, region: string,
): Record<string, string> {
  const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data).digest();
  const sha256hex = (data: string) => crypto.createHash("sha256").update(data).digest("hex");

  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const lowerHeaders: Record<string, string> = { "content-type": "application/json", host, "x-amz-date": amzDate };
  if (creds.sessionToken) lowerHeaders["x-amz-security-token"] = creds.sessionToken;
  const signedHeadersList = Object.keys(lowerHeaders).sort();
  const canonicalHeaders = signedHeadersList.map(h => `${h}:${lowerHeaders[h]}\n`).join("");

  // ponytail: encodeURIComponent over-encodes slightly vs AWS's uri-encode, accepted by Converse in practice
  const canonicalRequest = ["POST", urlPath, "", canonicalHeaders, signedHeadersList.join(";"), sha256hex(body)].join("\n");
  const scope = `${dateStamp}/${region}/bedrock/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  let k = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  k = hmac(k, region); k = hmac(k, "bedrock"); k = hmac(k, "aws4_request");
  const signature = crypto.createHmac("sha256", k).update(stringToSign).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeadersList.join(";")}, Signature=${signature}`,
  };
  if (creds.sessionToken) headers["X-Amz-Security-Token"] = creds.sessionToken;
  return headers;
}

/**
 * Chat function for amazon-bedrock via the Converse API (SigV4-signed).
 */
function makeBedrockChatFn(providerInfo: { region?: string }): ChatFn {
  return async (model, messages, options) => {
    const creds = resolveAwsCredentials();
    if (!creds) throw new Error("AWS credentials not found — set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or ~/.aws/credentials");
    const region = providerInfo.region || process.env.AWS_REGION || "us-east-1";
    const host = `bedrock-runtime.${region}.amazonaws.com`;

    const system = messages.filter(m => m.role === "system").map(m => ({ text: m.content }));
    const converse: any = {
      ...(system.length ? { system } : {}),
      messages: messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: [{ text: m.content }] })),
    };
    const tools = (options?.tools as any[] | undefined) || undefined;
    if (tools?.length) {
      converse.toolConfig = {
        tools: tools.map(t => ({
          toolSpec: {
            name: t.function?.name || t.name,
            description: t.function?.description || t.description || "",
            inputSchema: { json: t.function?.parameters || t.parameters || { type: "object", properties: {} } },
          },
        })),
      };
    }
    const body = JSON.stringify(converse);
    const urlPath = `/model/${encodeURIComponent(model)}/converse`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TEST_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(`https://${host}${urlPath}`, {
        method: "POST",
        headers: sigv4Headers(creds, host, urlPath, body, region),
        body,
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - start;
      if (!res.ok) {
        const errorText = await res.text().catch(() => "unknown error");
        throw new Error(`Bedrock API returned ${res.status}: ${truncate(errorText, 200)}`);
      }
      const parsed = await res.json();
      const blocks = parsed?.output?.message?.content || [];
      const content = blocks.map((b: any) => b.text || "").join("");
      const toolCalls = blocks.filter((b: any) => b.toolUse).map((b: any) => ({
        function: { name: b.toolUse.name, arguments: b.toolUse.input ?? {} },
      }));
      return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, elapsedMs, raw: parsed };
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e.name === "AbortError") throw new Error(`Bedrock API timed out after ${msHuman(CONFIG.TOOL_TEST_TIMEOUT_MS)}`);
      throw e;
    }
  };
}

function makePiBedrockThinkingChatFn(modelConfig: BenchmarkModel): ChatFn {
  return async (_model, messages, options) => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/bedrock-converse-stream");
    const systemPrompt = messages.filter(m => m.role === "system").map(m => m.content).join("\n") || undefined;
    const tools = (options?.tools as any[] | undefined)?.map(tool => ({
      name: tool.function?.name || tool.name,
      description: tool.function?.description || tool.description || "",
      parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
    }));
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const stream = streamSimple(modelConfig as any, {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: messages.filter(m => m.role !== "system") as any,
      ...(tools?.length ? { tools } : {}),
    }, { reasoning: "max" });
    const message: any = await stream.result();
    const content = (message.content || []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
    const toolCalls = (message.content || []).filter((block: any) => block.type === "toolCall").map((block: any) => ({
      function: { name: block.name, arguments: block.arguments },
    }));
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, elapsedMs: Date.now() - start, raw: message, startedAt, finishedAt: new Date().toISOString() };
  };
}

/**
 * Create the appropriate chat function based on provider type.
 */
function makeChatFn(providerInfo: { kind: string; name: string; baseUrl?: string; region?: string; apiKey?: string; apiMode?: string }, thinking: ThinkingMode, modelConfig: BenchmarkModel | undefined): ChatFn {
  if (providerInfo.kind === "ollama") return makeOllamaChatFn();
  if (providerInfo.kind === "bedrock") return thinking.effective === "pi-bedrock-reasoning" && modelConfig
    ? makePiBedrockThinkingChatFn(modelConfig)
    : makeBedrockChatFn(providerInfo);
  const baseUrl = providerInfo.baseUrl || ollamaBase();
  return makeOpenAiChatFn(baseUrl, providerInfo.apiKey, thinking.effective === "openai-reasoning-effort");
}

function makeOllamaToolChatFn(): ChatFn {
  return async (model, messages, options) => {
    const tools = (options?.tools as any[] | undefined) || undefined;
    const body: any = {
      model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TEST_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(`${ollamaBase()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - start;
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "unknown error");
        throw new Error(`Ollama API returned ${res.status}: ${truncate(errorText, 200)}`);
      }

      const text = await res.text();
      if (!text.trim()) throw new Error("Empty response from Ollama");
      const parsed = JSON.parse(text);
      const toolCalls = parsed?.message?.tool_calls;
      const content = parsed?.message?.content || "";
      return {
        content,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        elapsedMs,
        raw: parsed,
      };
    } catch (e: any) {
      clearTimeout(timeoutId);
      throw e;
    }
  };
}

// ── Ollama Chat Functions ─────────────────────────────────────────────

async function ollamaChat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: Record<string, unknown> = {},
  timeoutMs = CONFIG.DEFAULT_TIMEOUT_MS,
  retries = CONFIG.MAX_RETRIES
): Promise<{ response: any; elapsedMs: number }> {
  const { tools, ...generationOptions } = options as any;
  const body: any = { model, messages, stream: false, ...(tools ? { tools } : {}), ...(Object.keys(generationOptions).length ? { options: generationOptions } : {}) };
  const url = `${ollamaBase()}/api/chat`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - start;

      if (!res.ok) {
        const errorText = await res.text().catch(() => "unknown error");
        throw new Error(`Ollama API returned ${res.status}: ${truncate(errorText, 200)}`);
      }

      const text = await res.text();
      if (!text.trim()) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`Empty response from Ollama after ${attempt + 1} attempt(s)`);
      }
      const parsed = JSON.parse(text);
      return { response: parsed, elapsedMs };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "AbortError") {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`Ollama API timed out after ${msHuman(timeoutMs)}`);
      }
      if (attempt < retries && (
        msg.includes("Empty response") || msg.includes("ECONNREFUSED") ||
        msg.includes("ECONNRESET") || msg.includes("fetch failed")
      )) {
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error("Unreachable");
}

async function ollamaChatStream(
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: Record<string, unknown> = {},
  timeoutMs = CONFIG.DEFAULT_TIMEOUT_MS,
): Promise<{ response: any; elapsedMs: number }> {
  const { tools, ...generationOptions } = options as any;
  const body: any = { model, messages, stream: true, ...(tools ? { tools } : {}), ...(Object.keys(generationOptions).length ? { options: generationOptions } : {}) };
  const url = `${ollamaBase()}/api/chat`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "unknown error");
      throw new Error(`Ollama API returned ${res.status}: ${truncate(errorText, 200)}`);
    }

    if (!res.body) {
      throw new Error("Ollama streaming response has no body");
    }

    let messageContent = "";
    let thinkingContent = "";
    const toolCalls: any[] = [];
    let done = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line: string) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) messageContent += parsed.message.content;
          if (parsed.message?.thinking) thinkingContent += parsed.message.thinking;
          if (parsed.message?.tool_calls) toolCalls.push(...parsed.message.tool_calls);
          if (parsed.done) done = true;
        } catch (err) { debugLog("simplebench", "skipped malformed JSON chunk in streaming response", err); }
      }
    }

    const elapsedMs = Date.now() - start;

    if (!hasOllamaAssistantOutput(messageContent, thinkingContent, toolCalls)) {
      throw new Error("Empty streaming response from Ollama");
    }

    const response = {
      message: {
        content: messageContent,
        thinking: thinkingContent,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        role: "assistant",
      },
      done: true,
    };

    return { response, elapsedMs };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Ollama API timed out after ${msHuman(timeoutMs)}`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Extended Test Functions ───────────────────────────────────────────

interface ReasoningTestResult {
  name: string;
  category: string;
  prompt: string;
  response: string | null;
  error?: string;
  elapsedMs: number;
  metrics: ReturnType<typeof emptyMetrics>;
  score: string;
  answer: string;
  expectedAnswer: string | string[];
  pass: boolean;
  details?: string;
}
type ProgressFn = (msg: string) => void;

async function testReasoningExtended(chatFn: ChatFn, model: string, onProgress?: ProgressFn): Promise<{ score: string; scores: string[]; answers: string[]; results: ReasoningTestResult[] }> {
  const results: ReasoningTestResult[] = [];
  const total = REASONING_TESTS.length;
  for (let i = 0; i < total; i++) {
    const test = REASONING_TESTS[i];
    onProgress?.(`[1/3] Reasoning ${i + 1}/${total}: ${test.name} (${test.category})...`);
    try {
      const requestedAt = new Date().toISOString();
      const result = await chatFn(model, [{ role: "user", content: test.prompt }]);
      const msg = result.content.trim();
      const scored = scoreReasoning(msg, test.expectedAnswer);
      const answer = scored.answer;
      results.push({ name: test.name, category: test.category, prompt: test.prompt, response: msg, elapsedMs: result.elapsedMs, metrics: metricsFromChat({ ...result, startedAt: result.startedAt ?? requestedAt, finishedAt: result.finishedAt ?? new Date().toISOString() }), score: scored.score, answer, expectedAnswer: test.expectedAnswer, pass: scored.pass, details: scored.details });
      onProgress?.(`[1/3] Reasoning ${i + 1}/${total}: ${test.name} → ${scored.score}`);
    } catch (e: any) {
      results.push({ name: test.name, category: test.category, prompt: test.prompt, response: null, error: e?.message || String(e), elapsedMs: 0, metrics: emptyMetrics(), score: "ERROR", answer: "?", expectedAnswer: test.expectedAnswer, pass: false });
      onProgress?.(`[1/3] Reasoning ${i + 1}/${total}: ${test.name} → ERROR`);
    }
    // Delay between reasoning tests to avoid rate limiting (skip after last test)
    if (i < total - 1) await rateLimitDelay();
  }
  return { score: averageScore(results.map(r => r.score)), scores: results.map(r => r.score), answers: results.map(r => r.answer), results };
}

async function testInstructionFollowingExtended(chatFn: ChatFn, model: string): Promise<{ pass: boolean; score: string; output: string; schemaValid: boolean; elapsedMs: number; metrics: ReturnType<typeof emptyMetrics> }> {
  const start = Date.now();
  try {
    const result = await chatFn(model, [{ role: "user", content: MULTISTEP_INSTRUCTION }]);
    const metrics = metricsFromChat({ ...result, startedAt: result.startedAt ?? new Date(start).toISOString(), finishedAt: result.finishedAt ?? new Date().toISOString() });
    const output = result.content.trim();
    const schemaValid = isValidInstructionOutput(output);
    return { pass: schemaValid, score: schemaValid ? "STRONG" : "FAIL", output, schemaValid, elapsedMs: Date.now() - start, metrics };
  } catch (e: any) {
    return { pass: false, score: "FAIL", output: e.message, schemaValid: false, elapsedMs: Date.now() - start, metrics: emptyMetrics() };
  }
}

function canonicalizeExpression(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").replace(/[×x·∗]/g, "*").replace(/^\(+/, "").replace(/\)+$/, "").replace(/=+$/, "");
}

function canonicalizeLocation(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z]+/g, " ");
}

async function testToolUsageExtended(chatFn: ChatFn, model: string, useToolResultMessages = true): Promise<{ pass: boolean; score: string; toolCalls: string[]; response: string; elapsedMs: number; metrics: ReturnType<typeof emptyMetrics> }> {
  try {
    const tools = [WEATHER_TOOL_DEFINITION, CALC_TOOL_DEFINITION];
    const started = Date.now();
    const initialMessages = [{ role: "system", content: "Use the available tools, then answer using their results." }, { role: "user", content: "What's weather in Tokyo and calculate 15*24?" }];
    const first = await chatFn(model, initialMessages, { tools });
    const calls = first.toolCalls || [];
    const toolNames = calls.map((t: any) => t.function?.name || "?");
    const results = calls.map((call: any) => {
      const fn = call.function || call;
      let args: any = {};
      try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch { return { name: fn.name, result: "INVALID_ARGUMENTS" }; }
      if (fn.name === "get_weather" && canonicalizeLocation(args.location).split(" ").includes("tokyo")) return { name: fn.name, result: "Tokyo: clear, 22C" };
      if (fn.name === "calculate" && canonicalizeExpression(args.expression) === "15*24") return { name: fn.name, result: "360" };
      return { name: fn.name, result: "INVALID_ARGUMENTS" };
    });
    const validWeather = results.some(r => r.name === "get_weather" && r.result !== "INVALID_ARGUMENTS");
    const validCalc = results.some(r => r.name === "calculate" && r.result === "360");
    if (!calls.length) return { pass: false, score: "FAIL", toolCalls: toolNames, response: first.content, elapsedMs: Date.now() - started, metrics: metricsFromChat(first) };
    if (!useToolResultMessages) {
      return { pass: false, score: "FAIL", toolCalls: toolNames, response: first.content, elapsedMs: Date.now() - started, metrics: metricsFromChat(first) };
    }
    const followup = await chatFn(model, buildToolContinuationMessages(initialMessages, first.content, calls, results.map(result => result.result)), { tools });
    const finalText = `${followup.content || ""}`.toLowerCase();
    const synthesized = finalText.includes("360") && (finalText.includes("tokyo") || finalText.includes("22"));
    const score = validWeather && validCalc && synthesized ? "STRONG" : validWeather || validCalc ? "MODERATE" : "WEAK";
    return { pass: validWeather && validCalc && synthesized, score, toolCalls: toolNames, response: followup.content, elapsedMs: Date.now() - started, metrics: mergeRequestMetrics([metricsFromChat({ ...first, toolCalls: calls }), metricsFromChat({ ...followup, toolCalls: [] })]) };
  } catch (e: any) {
    return { pass: false, score: "ERROR", toolCalls: [], response: e.message, elapsedMs: 0, metrics: emptyMetrics() };
  }
}

async function testCodingLite(chatFn: ChatFn, model: string, onProgress?: (message: string) => void): Promise<{ results: Awaited<ReturnType<typeof runCodingTask>>[]; passed: number; total: number }> {
  const results = [] as Awaited<ReturnType<typeof runCodingTask>>[];
  for (let index = 0; index < CODING_LITE_TASKS.length; index += 1) {
    const task = CODING_LITE_TASKS[index];
    const prefix = `[${index + 1}/${CODING_LITE_TASKS.length}] coding-lite: [${task.id}]`;
    onProgress?.(`${prefix} starting...`);
    const result = await runCodingTask(chatFn, model, task, {
      onProgress: message => onProgress?.(`${prefix} ${message.slice(task.id.length + 2)}`),
    });
    results.push(result);
    onProgress?.(`${prefix} agent turn → ${result.passed ? "passed" : "failed"}`);
  }
  return { results, passed: results.filter(result => result.passed).length, total: results.length };
}

function codingTestRecords(coding: Awaited<ReturnType<typeof testCodingLite>>): TestRecord[] {
  return coding.results.map(result => {
    const task = CODING_LITE_TASKS.find(candidate => candidate.id === result.id)!;
    return {
      id: result.id,
      kind: "coding" as const,
      category: "coding-lite",
      prompt: task.prompt,
      response: null,
      score: result.passed ? (result.efficiency ?? "STRONG") : "FAIL",
      passed: result.passed,
      error: result.error,
      metrics: result.metrics,
      coding: { publicPassed: result.publicPassed, hiddenPassed: result.hiddenPassed, verifiedAfterEdit: result.verifiedAfterEdit, unrelatedFiles: result.unrelatedFiles, toolCalls: result.toolCalls, turns: result.turns, efficiency: result.efficiency },
    };
  });
}

// ── get models to test ─────────────────────────────────────────────────

async function getOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m: any) => m.name).filter(Boolean);
  } catch (err) { debugLog("simplebench", "failed to list Ollama models", err); return []; }
}

function getCurrentModel(ctx: any): string | undefined {
  return ctx.model?.id;
}

// ── Extended Test Runner ───────────────────────────────────────────────

async function testModelExtended(model: string, ctx?: any, options: SimplebenchOptions = { allModels: false, writeArtifact: true }): Promise<string> {
  const lines: string[] = [];
  const totalStart = Date.now();
  const providerInfo = ctx ? detectProvider(ctx) : { kind: "ollama" as const, name: "ollama" };
  const resolvedModel = resolveBenchmarkModel(ctx, model);
  const thinking = resolveThinkingMode(providerInfo, resolvedModel.model, options.thinkingMax === true);
  const suite = options.testAll ? "test-all" : options.codingLite ? "coding-lite" : "baseline";

  // Direct llama-server probes are separate from the provider route. This is
  // intentional: --llamagputop also works when inference goes through LiteLLM.
  const benchConfig = readTestConfig();
  const captureEnabled = options.llamaServer === true || options.llamagputop === true;
  const llamaBaseUrl = benchConfig.llamaServerUrl || "";
  const llamaErrors: string[] = [];
  let llamaProps: Awaited<ReturnType<typeof fetchLlamaServerProps>> | null = null;
  let llamaMetricsBefore: Record<string, number> = {};
  if (options.llamaServer) {
    if (!llamaBaseUrl) llamaErrors.push("llamaServerUrl is not configured in opl-simplebench.json");
    else llamaProps = await fetchLlamaServerProps(llamaBaseUrl);
    if (llamaProps?.error) llamaErrors.push(llamaProps.error);
    if (llamaBaseUrl) {
      const before = await fetchLlamaServerMetrics(llamaBaseUrl);
      if (before.error) llamaErrors.push(before.error);
      llamaMetricsBefore = before.metrics;
    }
  }
  async function captureServerStats(): Promise<ServerStats | undefined> {
    if (!captureEnabled) return undefined;
    const errors = [...llamaErrors];
    let stats = buildServerStats(llamaProps?.info ?? null, llamaMetricsBefore, {}, errors);
    if (options.llamaServer && llamaBaseUrl) {
      const after = await fetchLlamaServerMetrics(llamaBaseUrl);
      if (after.error) errors.push(after.error);
      stats = buildServerStats(llamaProps?.info ?? null, llamaMetricsBefore, after.metrics, errors);
    }
    if (options.llamagputop) {
      const topUrl = benchConfig.llamagputopUrl;
      if (!topUrl) errors.push("llamagputopUrl is not configured in opl-simplebench.json");
      const external = topUrl ? await fetchLlamagputopStats(topUrl) : null;
      if (external?.error) {
        errors.push(external.error);
        if (external.unavailable) {
          const healthError = await fetchLlamagputopHealth(topUrl!);
          if (healthError) errors.push(healthError);
        }
      }
      if (external?.info) {
        stats.modelConfig = applyLlamagputop(stats.modelConfig, external.info.modelConfig);
        stats.modelStats = applyLlamagputopModelStats(stats.modelStats, external.info.modelStats);
      }
    }
    lines.push(errors.length
      ? warn(`serverStats captured with warnings (${errors.join("; ")})`)
      : info("serverStats captured"));
    return stats;
  }

  lines.push(sharedBranding);
  lines.push(section(`MODEL: ${model}`));
  lines.push(info(`Provider: ${providerInfo.name} (${providerInfo.kind})`));
  lines.push(info(`Thinking: ${thinking.effective}`));
  lines.push(info(`Suite: ${suite}`));

  // Create chat functions for different test types
  // Use provider-appropriate chat functions
  const chatFn = makeChatFn(providerInfo, thinking, resolvedModel.model);
  const toolChatFn = providerInfo.kind === "ollama" ? makeOllamaToolChatFn()
    : providerInfo.kind === "bedrock" ? makeChatFn(providerInfo, thinking, resolvedModel.model)
    : makeOpenAiChatFn(providerInfo.baseUrl || ollamaBase(), providerInfo.apiKey, thinking.effective === "openai-reasoning-effort");

  // Progress notification helper — safe to call even without a TUI context
  const progress = (msg: string) => ctx?.ui?.notify?.(msg, "info");
  let codingSummary: Awaited<ReturnType<typeof testCodingLite>> | null = null;
  let researchGrounded: Awaited<ReturnType<typeof runGroundedResearchTask>> | null = null;
  let researchArtifact: Awaited<ReturnType<typeof runResearchArtifactTask>> | null = null;

  if (options.codingLite || options.testAll) {
    lines.push(section("CODING-LITE TEST"));
    lines.push(info(`Testing ${CODING_LITE_TASKS.length} execution-backed coding tasks...`));
    codingSummary = await testCodingLite(chatFn, model, progress);
    for (const result of codingSummary.results) {
      const eff = result.passed ? `${result.efficiency} (${result.turns} turn${result.turns !== 1 ? "s" : ""})` : "FAIL";
      lines.push(result.passed ? ok(`✓ ${result.id}: ${eff}`) : fail(`✗ ${result.id}: ${eff} (${result.error || "hidden verification failed"})`));
    }
    lines.push(info(`Coding Lite: ${codingSummary.passed}/${codingSummary.total} passed — ${codingSummary.results.filter(r => r.efficiency === "STRONG").length} STRONG, ${codingSummary.results.filter(r => r.efficiency === "MODERATE").length} MODERATE, ${codingSummary.results.filter(r => r.efficiency === "WEAK").length} WEAK`));
    if (options.codingLite && !options.testAll) {
      const totalMs = Date.now() - totalStart;
      let artifactPath: string | null = null;
      const serverStats = await captureServerStats();
      if (options.writeArtifact) {
        try { artifactPath = writeArtifact({ schemaVersion: 1, benchmark: { name: "opl-simplebench", suite, model, provider: providerInfo.name, providerKind: providerInfo.kind, thinking: { ...thinking, modelMetadataSource: resolvedModel.source }, startedAt: new Date(totalStart).toISOString(), finishedAt: new Date().toISOString(), wallTimeMs: totalMs, artifactEnabled: true }, tests: codingTestRecords(codingSummary), summary: { coding: { passed: codingSummary.passed, total: codingSummary.total, efficiency: { strong: codingSummary.results.filter(r => r.efficiency === "STRONG").length, moderate: codingSummary.results.filter(r => r.efficiency === "MODERATE").length, weak: codingSummary.results.filter(r => r.efficiency === "WEAK").length, fail: codingSummary.results.filter(r => r.efficiency === "FAIL").length } }, ...(serverStats ? { serverStats } : {}) } }); }
        catch (e: any) { lines.push(warn(`Artifact could not be written: ${e?.message || e}`)); }
      }
      const effCounts = { strong: codingSummary.results.filter(r => r.efficiency === "STRONG").length, moderate: codingSummary.results.filter(r => r.efficiency === "MODERATE").length, weak: codingSummary.results.filter(r => r.efficiency === "WEAK").length };
      const codingOverall = codingRecommendation(codingSummary.passed, codingSummary.total);
      lines.push(section("CODING-LITE RECOMMENDATION"));
      lines.push(codingOverall.label === "WEAK" ? fail(`${model} is ${codingOverall.label} (${codingOverall.passed}/${codingOverall.total} passed — ${effCounts.strong} STRONG, ${effCounts.moderate} MODERATE, ${effCounts.weak} WEAK)`) : ok(`${model} is ${codingOverall.label} (${codingOverall.passed}/${codingOverall.total} passed — ${effCounts.strong} STRONG, ${effCounts.moderate} MODERATE, ${effCounts.weak} WEAK)`));
      lines.push(info(artifactPath ? `Artifact: ${artifactPath}` : "Artifact: disabled (--no-artifact)"));
      return lines.join("\n");
    }
  }

  if (options.testAll) {
    lines.push(section("GROUNDED RESEARCH TEST"));
    lines.push(info("Testing fixed source cards, claim citations, minimalist UI guidance, and file artifacts..."));
    researchGrounded = await runGroundedResearchTask(toolChatFn, model, { onProgress: message => progress(`[1/1] ${message}`) });
    lines.push(researchGrounded.passed ? ok(`Grounded research: ${researchGrounded.score}`) : fail(`Grounded research: ${researchGrounded.score} (${researchGrounded.error})`));
  }
  if (options.researchLive) {
    lines.push(section("LIVE RESEARCH SMOKE TEST"));
    lines.push(info("Testing configured live search and artifact workflow; this does not affect recommendation..."));
    researchArtifact = await runResearchArtifactTask(toolChatFn, model, { search: query => searchConfiguredResearch(query, benchConfig), onProgress: message => progress(`[live] ${message}`) });
    lines.push(researchArtifact.passed ? ok(`Live research: ${researchArtifact.score}`) : fail(`Live research: ${researchArtifact.score} (${researchArtifact.error})`));
  }

  // 1. Closed-answer contract test
  lines.push(section("CLOSED-ANSWER CONTRACT TEST"));
  lines.push(info(`Testing ${REASONING_TESTS.length} deterministic answer and final-line contracts...`));
  const reasoning = await testReasoningExtended(chatFn, model, progress);

  for (const r of reasoning.results) {
    const passMark = r.pass ? "✅" : "❌";
    const scoreLabel = r.score === "STRONG" ? ok : r.score === "MODERATE" ? warn : r.score === "WEAK" ? warn : fail;
    lines.push(scoreLabel(`${passMark} ${r.name} (${r.category}): ${r.score} - expected "${r.expectedAnswer}", got "${r.answer}"${r.details ? ` [${r.details}]` : ""}`));
  }
  lines.push(ok(`Closed-answer contract score: ${reasoning.score}`));

  // 2. Extended Instruction Following test
  progress("[2/3] Instruction following test...");
  lines.push(section("INSTRUCTION FOLLOWING TEST (EXTENDED)"));
  lines.push(info("Testing multi-step JSON schema compliance..."));
  await rateLimitDelay();
  const instructions = await testInstructionFollowingExtended(chatFn, model);
  lines.push(info(`Time: ${msHuman(instructions.elapsedMs)}`));
  lines.push(formatInstructionScore(instructions));
  lines.push(info(`Output: ${instructions.output}`));

  // 3. Extended Tool Usage test
  progress("[3/3] Tool usage test...");
  lines.push(section("TOOL USAGE TEST (EXTENDED)"));
  lines.push(info("Testing chained tool calls..."));
  await rateLimitDelay();
  const tools = await testToolUsageExtended(toolChatFn, model, providerInfo.kind !== "bedrock");
  lines.push(info(`Time: ${msHuman(tools.elapsedMs)}`));
  if (tools.score === "STRONG" || tools.score === "MODERATE") lines.push(ok(`Tool calls: ${tools.toolCalls.join(", ")} (${tools.score})`));
  else lines.push(fail(`Tool calls: ${tools.toolCalls.length > 0 ? tools.toolCalls.join(", ") : "none"} (${tools.score})`));
  lines.push(info(`Response: ${sanitizeForReport(tools.response)}`));

  const totalMs = Date.now() - totalStart;
  const artifactTests: TestRecord[] = reasoning.results.map(r => ({ id: r.name, kind: "reasoning", category: r.category, prompt: r.prompt, response: r.response, expectedAnswer: r.expectedAnswer, extractedAnswer: r.answer, score: r.score, passed: r.pass, error: r.error || null, metrics: r.metrics }));
  artifactTests.push({ id: "instruction_following", kind: "instructions", prompt: MULTISTEP_INSTRUCTION, response: instructions.output, score: instructions.score, passed: instructions.pass, error: instructions.score === "FAIL" ? instructions.output : null, metrics: instructions.metrics });
  artifactTests.push({ id: "tool_usage", kind: "tools", prompt: "What's weather in Tokyo and calculate 15*24?", response: tools.response, score: tools.score, passed: tools.pass, error: tools.score === "ERROR" ? tools.response : null, metrics: tools.metrics });
  artifactTests.push(...(codingSummary ? codingTestRecords(codingSummary) : []));
  if (researchGrounded) artifactTests.push({ id: researchGrounded.id, kind: "research-grounded", category: "research-grounded", prompt: "Research supplied urban-tree source cards and cite each required claim.", response: null, score: researchGrounded.score, passed: researchGrounded.passed, error: researchGrounded.error, metrics: researchGrounded.metrics, research: { toolCalls: researchGrounded.toolCalls, files: Object.keys(researchGrounded.files) } });
  if (researchArtifact) artifactTests.push({ id: researchArtifact.id, kind: "research-live", category: "research-live", prompt: "Research benefits of urban trees and write research.md and page.html.", response: null, score: researchArtifact.score, passed: researchArtifact.passed, error: researchArtifact.error, metrics: researchArtifact.metrics, research: { toolCalls: researchArtifact.toolCalls, files: Object.keys(researchArtifact.files) } });
  const aggregate = aggregateMetrics(artifactTests.filter(test => test.kind !== "coding"));
  let artifactPath: string | null = null;
  const serverStats = await captureServerStats();
  if (options.writeArtifact) {
    try {
      const artifact = { schemaVersion: 1 as const, benchmark: { name: "opl-simplebench" as const, suite, model, provider: providerInfo.name, providerKind: providerInfo.kind, thinking: { ...thinking, modelMetadataSource: resolvedModel.source }, startedAt: new Date(totalStart).toISOString(), finishedAt: new Date().toISOString(), wallTimeMs: totalMs, artifactEnabled: true }, tests: artifactTests, summary: { reasoning: { score: reasoning.score, passed: reasoning.results.filter(r => r.pass).length, total: reasoning.results.length }, instructions: instructions.score, tools: tools.score, ...(codingSummary ? { coding: { passed: codingSummary.passed, total: codingSummary.total, efficiency: { strong: codingSummary.results.filter(r => r.efficiency === "STRONG").length, moderate: codingSummary.results.filter(r => r.efficiency === "MODERATE").length, weak: codingSummary.results.filter(r => r.efficiency === "WEAK").length, fail: codingSummary.results.filter(r => r.efficiency === "FAIL").length } } } : {}), ...(researchGrounded ? { researchGrounded: researchGrounded.score } : {}), ...(researchArtifact ? { researchLive: researchArtifact.score } : {}), metrics: aggregate, ...(serverStats ? { serverStats } : {}) } };
      artifactPath = researchGrounded ? writeArtifactBundle(artifact, researchGrounded.files) : writeArtifact(artifact);
    } catch (e: any) { lines.push(warn(`Artifact could not be written: ${e?.message || e}`)); }
  }
  
  const reasoningPassed = reasoning.results.filter(r => r.pass).length;
  const reasoningTotal = reasoning.results.length;
  const instructionPassed = instructions.pass ? 1 : 0;
  const toolPassed = tools.pass ? 1 : 0;
  const totalPassed = reasoningPassed + instructionPassed + toolPassed;
  const totalTests = reasoningTotal + 1 + 1;
  
  const summaryTests = [
    { name: "Closed-answer contract", pass: reasoning.score === "STRONG" || reasoning.score === "MODERATE", score: reasoning.score },
    { name: "Instructions", pass: instructions.pass, score: instructions.score },
    { name: "Tool Usage", pass: tools.pass, score: tools.score },
    ...(codingSummary ? [{ name: "Coding Lite", pass: codingSummary.passed >= Math.ceil(codingSummary.total / 2), score: `${codingSummary.passed}/${codingSummary.total} (${codingSummary.results.filter(r => r.efficiency === "STRONG").length}× STRONG)` }] : []),
    ...(researchGrounded ? [{ name: "Grounded Research", pass: researchGrounded.passed, score: researchGrounded.score }] : []),
    ...(researchArtifact ? [{ name: "Live Research", pass: researchArtifact.passed, score: researchArtifact.score }] : []),
  ];
  lines.push(...formatTestSummary(summaryTests, totalMs));
  
  lines.push("");
  lines.push(info(`Detailed: Closed-answer contract ${reasoningPassed}/${reasoningTotal} tests passed, Instructions ${instructionPassed}/1, Tool Usage ${toolPassed}/1${codingSummary ? `, Coding Lite ${codingSummary.passed}/${codingSummary.total}` : ""}${researchGrounded ? `, Grounded Research ${researchGrounded.score}` : ""}${researchArtifact ? `, Live Research ${researchArtifact.score}` : ""}`));
  const categoryRecommendation = recommendation(reasoning.score, instructions.pass, tools.pass, codingSummary ? { ...codingSummary, efficiency: { strong: codingSummary.results.filter(r => r.efficiency === "STRONG").length, moderate: codingSummary.results.filter(r => r.efficiency === "MODERATE").length, weak: codingSummary.results.filter(r => r.efficiency === "WEAK").length, fail: codingSummary.results.filter(r => r.efficiency === "FAIL").length } } : undefined);
  lines.push(section("RECOMMENDATION"));
  lines.push(categoryRecommendation.label === "WEAK" ? fail(`${model} is ${categoryRecommendation.label}`) : ok(`${model} is ${categoryRecommendation.label}`));
  if (codingSummary) lines.push(info(`Coding Lite contribution: ${codingSummary.passed}/${codingSummary.total} tasks`));
  lines.push(info(artifactPath ? `Artifact: ${artifactPath}` : "Artifact: disabled (--no-artifact)"));
  return lines.join("\n");
}

/**
 * Main entry point: always runs the extended test.
 */
async function testModel(model: string, ctx?: any, options?: SimplebenchOptions): Promise<string> {
  return testModelExtended(model, ctx, options);
}

return { getOllamaModels, testModel, testToolUsageExtended };
}
