import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { section, ok, fail, warn, info, msHuman, truncate, sanitizeForReport } from "./util/format";
import { getOllamaBaseUrl, detectProvider } from "./util/providers";
import { debugLog } from "./util/debug";
import { CONFIG, WEATHER_TOOL_DEFINITION, getEffectiveConfig, type ChatFn } from "./util/config";
import { branding as sharedBranding, formatInstructionScore, formatTestSummary, recommendation } from "./report";
import { writeArtifact } from "./artifact";
import { aggregateMetrics, emptyMetrics, metricsFromChat } from "./metrics";
import { REASONING_TESTS, MULTISTEP_INSTRUCTION, CALC_TOOL_DEFINITION } from "./tests";
import { scoreReasoning, averageScore } from "./scoring";
import type { SimplebenchOptions, TestRecord } from "./types";

type BenchmarkModel = { id: string; provider?: string; api?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };
type BenchmarkContext = { model?: BenchmarkModel; getScopedModels?: () => ReadonlyArray<{ model: BenchmarkModel }> };

type ThinkingMode = { requested: "default" | "max"; effective: "provider-default" | "openai-reasoning-effort" | "pi-bedrock-reasoning"; level: "max" | null };

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
  return async (model, messages, _options) => {
    const chatFn = useStreaming ? ollamaChatStream : ollamaChat;
    const startedAt = new Date().toISOString();
    const result = await chatFn(model, messages);
    return {
      content: result.response?.message?.content || "",
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
  const body: any = { model, messages, stream: false, ...(Object.keys(options).length ? { options } : {}) };
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
  const body: any = { model, messages, stream: true, ...(Object.keys(options).length ? { options } : {}) };
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
          if (parsed.done) done = true;
        } catch (err) { debugLog("simplebench", "skipped malformed JSON chunk in streaming response", err); }
      }
    }

    const elapsedMs = Date.now() - start;

    if (!messageContent.trim() && !thinkingContent.trim()) {
      throw new Error("Empty streaming response from Ollama");
    }

    const response = {
      message: {
        content: messageContent,
        thinking: thinkingContent,
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
  expectedAnswer: string;
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
    const parsed = JSON.parse(result.content.trim());
    const schemaValid = !!(parsed.name && parsed.can_count === true && parsed.sum === 42 && parsed.language && parsed.colors?.length === 3 && parsed.timestamp);
    if (schemaValid) return { pass: true, score: "STRONG", output: JSON.stringify(parsed), schemaValid, elapsedMs: Date.now() - start, metrics };
    if (parsed.name && parsed.sum === 42) return { pass: true, score: "MODERATE", output: JSON.stringify(parsed), schemaValid: false, elapsedMs: Date.now() - start, metrics };
    return { pass: false, score: "WEAK", output: JSON.stringify(parsed), schemaValid: false, elapsedMs: Date.now() - start, metrics };
  } catch (e: any) {
    return { pass: false, score: "FAIL", output: e.message, schemaValid: false, elapsedMs: Date.now() - start, metrics: emptyMetrics() };
  }
}

async function testToolUsageExtended(chatFn: ChatFn, model: string): Promise<{ pass: boolean; score: string; toolCalls: string[]; response: string; elapsedMs: number; metrics: ReturnType<typeof emptyMetrics> }> {
  try {
    const result = await chatFn(model, [{ role: "system", content: "Use tools when needed." }, { role: "user", content: "What's weather in Tokyo and calculate 15*24?" }], { tools: [WEATHER_TOOL_DEFINITION, CALC_TOOL_DEFINITION] });
    const toolCalls = result.toolCalls || [];
    const hasWeather = toolCalls.some((t: any) => t.function?.name === "get_weather");
    const hasCalc = toolCalls.some((t: any) => t.function?.name === "calculate");
    let score = "FAIL";
    if (hasWeather && hasCalc && toolCalls.length >= 2) score = "STRONG";
    else if (hasWeather || hasCalc) score = "MODERATE";
    else if (toolCalls.length > 0) score = "WEAK";
    return { pass: toolCalls.length > 0, score, toolCalls: toolCalls.map((t: any) => t.function?.name || "?"), response: result.content, elapsedMs: result.elapsedMs, metrics: metricsFromChat(result) };
  } catch (e: any) {
    return { pass: false, score: "ERROR", toolCalls: [], response: e.message, elapsedMs: 0, metrics: emptyMetrics() };
  }
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

  lines.push(sharedBranding);
  lines.push(section(`MODEL: ${model}`));
  lines.push(info(`Provider: ${providerInfo.name} (${providerInfo.kind})`));
  lines.push(info(`Thinking: ${thinking.effective}`));

  // Create chat functions for different test types
  // Use provider-appropriate chat functions
  const chatFn = makeChatFn(providerInfo, thinking, resolvedModel.model);
  const toolChatFn = providerInfo.kind === "ollama" ? makeOllamaToolChatFn()
    : providerInfo.kind === "bedrock" ? makeChatFn(providerInfo, thinking, resolvedModel.model)
    : makeOpenAiChatFn(providerInfo.baseUrl || ollamaBase(), providerInfo.apiKey, thinking.effective === "openai-reasoning-effort");

  // Progress notification helper — safe to call even without a TUI context
  const progress = (msg: string) => ctx?.ui?.notify?.(msg, "info");

  // 1. Extended Reasoning test
  lines.push(section("REASONING TEST (EXTENDED)"));
  lines.push(info(`Testing ${REASONING_TESTS.length} reasoning puzzles...`));
  const reasoning = await testReasoningExtended(chatFn, model, progress);

  for (const r of reasoning.results) {
    const passMark = r.pass ? "✅" : "❌";
    const scoreLabel = r.score === "STRONG" ? ok : r.score === "MODERATE" ? warn : r.score === "WEAK" ? warn : fail;
    lines.push(scoreLabel(`${passMark} ${r.name} (${r.category}): ${r.score} - expected "${r.expectedAnswer}", got "${r.answer}"${r.details ? ` [${r.details}]` : ""}`));
  }
  lines.push(ok(`Average score: ${reasoning.score}`));

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
  const tools = await testToolUsageExtended(toolChatFn, model);
  lines.push(info(`Time: ${msHuman(tools.elapsedMs)}`));
  if (tools.score === "STRONG" || tools.score === "MODERATE") lines.push(ok(`Tool calls: ${tools.toolCalls.join(", ")} (${tools.score})`));
  else lines.push(fail(`Tool calls: ${tools.toolCalls.length > 0 ? tools.toolCalls.join(", ") : "none"} (${tools.score})`));
  lines.push(info(`Response: ${sanitizeForReport(tools.response)}`));

  const totalMs = Date.now() - totalStart;
  const artifactTests: TestRecord[] = reasoning.results.map(r => ({ id: r.name, kind: "reasoning", category: r.category, prompt: r.prompt, response: r.response, expectedAnswer: r.expectedAnswer, extractedAnswer: r.answer, score: r.score, passed: r.pass, error: r.error || null, metrics: r.metrics }));
  artifactTests.push({ id: "instruction_following", kind: "instructions", prompt: MULTISTEP_INSTRUCTION, response: instructions.output, score: instructions.score, passed: instructions.pass, error: instructions.score === "FAIL" ? instructions.output : null, metrics: instructions.metrics });
  artifactTests.push({ id: "tool_usage", kind: "tools", prompt: "What's weather in Tokyo and calculate 15*24?", response: tools.response, score: tools.score, passed: tools.pass, error: tools.score === "ERROR" ? tools.response : null, metrics: tools.metrics });
  const aggregate = aggregateMetrics(artifactTests);
  let artifactPath: string | null = null;
  if (options.writeArtifact) {
    try {
      artifactPath = writeArtifact({ schemaVersion: 1, benchmark: { name: "opl-simplebench", model, provider: providerInfo.name, providerKind: providerInfo.kind, thinking: { ...thinking, modelMetadataSource: resolvedModel.source }, startedAt: new Date(totalStart).toISOString(), finishedAt: new Date().toISOString(), wallTimeMs: totalMs, artifactEnabled: true }, tests: artifactTests, summary: { reasoning: { score: reasoning.score, passed: reasoning.results.filter(r => r.pass).length, total: reasoning.results.length }, instructions: instructions.score, tools: tools.score, metrics: aggregate } });
    } catch (e: any) { lines.push(warn(`Artifact could not be written: ${e?.message || e}`)); }
  }
  
  const reasoningPassed = reasoning.results.filter(r => r.pass).length;
  const reasoningTotal = reasoning.results.length;
  const instructionPassed = instructions.pass ? 1 : 0;
  const toolPassed = tools.pass ? 1 : 0;
  const totalPassed = reasoningPassed + instructionPassed + toolPassed;
  const totalTests = reasoningTotal + 1 + 1;
  
  lines.push(...formatTestSummary([
    { name: "Reasoning", pass: reasoning.score === "STRONG" || reasoning.score === "MODERATE", score: reasoning.score },
    { name: "Instructions", pass: instructions.pass, score: instructions.score },
    { name: "Tool Usage", pass: tools.pass, score: tools.score },
  ], totalMs));
  
  lines.push("");
  lines.push(info(`Detailed: Reasoning ${reasoningPassed}/${reasoningTotal} tests passed, Instructions ${instructionPassed}/1, Tool Usage ${toolPassed}/1`));
  const categoryRecommendation = recommendation(reasoning.score, instructions.pass, tools.pass);
  lines.push(section("RECOMMENDATION"));
  lines.push(categoryRecommendation.label === "WEAK" ? fail(`${model} is ${categoryRecommendation.label}`) : ok(`${model} is ${categoryRecommendation.label}`));
  lines.push(info(artifactPath ? `Artifact: ${artifactPath}` : "Artifact: disabled (--no-artifact)"));
  return lines.join("\n");
}

/**
 * Main entry point: always runs the extended test.
 */
async function testModel(model: string, ctx?: any, options?: SimplebenchOptions): Promise<string> {
  return testModelExtended(model, ctx, options);
}

return { getOllamaModels, testModel };
}
