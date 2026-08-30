import { CONFIG } from "./util/config";

// ── llama-server metadata (opt-in via --llama-server) ──────────────────────
// Queries the direct llama-server management base URL for /props configuration
// and /metrics counters. All values unavailable from the running build are null.
// /metrics counters are server-wide cumulative telemetry, not per-request.

export interface ModelConfig {
  model: string | null;
  ctx: number | null;
  ngl: number | null;
  "flash-attn": boolean | null;
  threads: number | null;
  batch: number | null;
  slots: number | null;
  "kv-k/v": string | null;
  temp: number | null;
  "top-k": number | null;
  "top-p": number | null;
  "min-p": number | null;
  repeat: number | null;
  "spec-type": string | null;
  "n-max": number | null;
  "draft-kv": string | null;
}

export interface LlamaServerInfo {
  modelConfig: ModelConfig;
  reasoning: string | null;
}

export interface ModelStats {
  prefill: number | null;
  gen: number | null;
  "session-avg": number | null;
  reasoning: string | null;
  "draft-accepted-p": number | null;
  "draft-accepted-tok": number | null;
}

export interface ServerStats {
  modelConfig: ModelConfig;
  modelStats: ModelStats;
  errors: string[];
}

const NULL_CONFIG: ModelConfig = {
  model: null, ctx: null, ngl: null, "flash-attn": null, threads: null, batch: null,
  slots: null, "kv-k/v": null, temp: null, "top-k": null, "top-p": null,
  "min-p": null, repeat: null, "spec-type": null, "n-max": null, "draft-kv": null,
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) { const v = num(obj[key]); if (v !== null) return v; }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Sampling params arrive as float32 widened to float64 (e.g. 0.6 -> 0.6000000238).
function round4(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

export function normalizeLlamaServerProps(raw: unknown): LlamaServerInfo {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const dgs = (root.default_generation_settings && typeof root.default_generation_settings === "object"
    ? root.default_generation_settings : {}) as Record<string, unknown>;
  const params = (dgs.params && typeof dgs.params === "object" ? dgs.params : {}) as Record<string, unknown>;
  return {
    modelConfig: {
      model: str(root.model_alias) ?? str(root.model),
      ctx: num(dgs.n_ctx),
      // Only populated by builds that expose these directly; never inferred.
      ngl: firstNumber(root, ["n_gpu_layers", "ngl"]),
      "flash-attn": bool(root.flash_attn),
      threads: firstNumber(root, ["n_threads", "threads"]),
      batch: firstNumber(root, ["n_batch", "batch"]),
      slots: num(root.total_slots),
      "kv-k/v": str(root.kv_cache_type) ?? str(root["cache_type_k"]),
      temp: round4(num(params.temperature)),
      "top-k": num(params.top_k),
      "top-p": round4(num(params.top_p)),
      "min-p": round4(num(params.min_p)),
      repeat: round4(num(params.repeat_penalty)),
      "spec-type": str(params["speculative.types"]),
      "n-max": firstNumber(root, ["n_max", "n_ctx_max"]),
      "draft-kv": str(root.draft_cache_type),
    },
    reasoning: str(params.reasoning_format),
  };
}

export function parsePrometheusMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip labelled series (e.g. foo{position="0"}); we only need scalars.
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+([-+0-9.eE]+)$/.exec(trimmed);
    if (!match) continue;
    const value = Number(match[2]);
    // llama.cpp namespaces every metric as `llamacpp:<name>`; key on the bare name.
    if (Number.isFinite(value)) out[match[1].replace(/^llamacpp:/, "")] = value;
  }
  return out;
}

export function diffPrometheusMetrics(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(after)) out[key] = after[key] - (before[key] ?? 0);
  return out;
}

function rate(tokens: number | undefined, seconds: number | undefined): number | null {
  if (typeof tokens !== "number" || typeof seconds !== "number" || seconds <= 0) return null;
  return round2(tokens / seconds);
}

export function buildServerStats(
  props: LlamaServerInfo | null,
  before: Record<string, number>,
  after: Record<string, number>,
  errors: string[],
): ServerStats {
  const d = diffPrometheusMetrics(before, after);
  const promptTok = d.prompt_tokens_total;
  const promptSec = d.prompt_seconds_total;
  const genTok = d.tokens_predicted_total;
  const genSec = d.tokens_predicted_seconds_total;
  const draftTok = d.spec_decode_num_draft_tokens_total;
  const acceptedTok = d.spec_decode_num_accepted_tokens_total;
  const drafts = d.spec_decode_num_drafts_total;
  const sessionTok = typeof promptTok === "number" && typeof genTok === "number" ? promptTok + genTok : undefined;
  const sessionSec = typeof promptSec === "number" && typeof genSec === "number" ? promptSec + genSec : undefined;
  return {
    modelConfig: props ? props.modelConfig : { ...NULL_CONFIG },
    modelStats: {
      prefill: rate(promptTok, promptSec),
      gen: rate(genTok, genSec),
      "session-avg": rate(sessionTok, sessionSec),
      reasoning: props ? props.reasoning : null,
      "draft-accepted-p": typeof draftTok === "number" && draftTok > 0 && typeof acceptedTok === "number"
        ? round2((acceptedTok / draftTok) * 100) : null,
      "draft-accepted-tok": typeof drafts === "number" && drafts > 0 && typeof acceptedTok === "number"
        ? round2(acceptedTok / drafts) : null,
    },
    errors,
  };
}

// Strip a trailing /v1 (or /v1/) so /props and /metrics resolve against the root.
export function managementBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.TOOL_TEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLlamaServerProps(baseUrl: string): Promise<{ info: LlamaServerInfo | null; error: string | null }> {
  try {
    const text = await fetchText(`${managementBaseUrl(baseUrl)}/props`);
    return { info: normalizeLlamaServerProps(JSON.parse(text)), error: null };
  } catch (e: any) {
    return { info: null, error: `props: ${e?.message || String(e)}` };
  }
}

export async function fetchLlamaServerMetrics(baseUrl: string): Promise<{ metrics: Record<string, number>; error: string | null }> {
  try {
    const text = await fetchText(`${managementBaseUrl(baseUrl)}/metrics`);
    return { metrics: parsePrometheusMetrics(text), error: null };
  } catch (e: any) {
    return { metrics: {}, error: `metrics: ${e?.message || String(e)}` };
  }
}

export interface LlamagputopInfo {
  modelIds: string[];
  modelConfig: Partial<ModelConfig>;
  modelStats: Partial<ModelStats>;
}

function configValue(key: keyof ModelConfig, value: unknown): ModelConfig[typeof key] | undefined {
  if (key === "flash-attn") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (["on", "enabled", "true", "1"].includes(value.toLowerCase())) return true;
      if (["off", "disabled", "false", "0"].includes(value.toLowerCase())) return false;
    }
    return undefined;
  }
  if (key === "batch" && typeof value === "string") {
    const n = Number(value.split("/")[0]);
    return Number.isFinite(n) ? n : undefined;
  }
  if (["ctx", "ngl", "threads", "slots", "temp", "top-k", "top-p", "min-p", "repeat", "n-max"].includes(key)) {
    return num(value) ?? undefined;
  }
  return typeof value === "string" ? value : undefined;
}

const CONFIG_KEYS = Object.keys(NULL_CONFIG) as (keyof ModelConfig)[];

export function normalizeLlamagputopStats(raw: unknown): { info: LlamagputopInfo | null; error: string | null } {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const llama = (root.llama && typeof root.llama === "object" ? root.llama : {}) as Record<string, unknown>;
  const modelIds = [root.model, root.model_id, root.modelId, root.model_alias, llama.model, llama.model_id, llama.modelId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const modelConfig: Partial<ModelConfig> = modelIds[0] ? { model: modelIds[0] } : {};
  const rawConfig = (root.modelConfig && typeof root.modelConfig === "object" ? root.modelConfig : {}) as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = configValue(key, rawConfig[key]);
    if (value !== undefined) modelConfig[key] = value as never;
  }
  const modelStats: Partial<ModelStats> = {};
  const rawStats = (root.modelStats && typeof root.modelStats === "object" ? root.modelStats : {}) as Record<string, unknown>;
  for (const key of ["prefill", "gen", "session-avg", "draft-accepted-p", "draft-accepted-tok"] as const) {
    let value = num(rawStats[key]);
    if (key === "draft-accepted-p" && value !== null && value <= 1) value *= 100;
    if (value !== null) modelStats[key] = round2(value);
  }
  const reasoning = str(rawStats.reasoning) ?? str(llama.reasoning_format);
  if (reasoning !== null) modelStats.reasoning = reasoning;
  return { info: { modelIds, modelConfig, modelStats }, error: null };
}

export function applyLlamagputop(config: ModelConfig, stats: Partial<ModelConfig>): ModelConfig {
  const out = { ...config };
  for (const key of Object.keys(stats) as (keyof ModelConfig)[]) if ((key === "model" || key === "spec-type" || out[key] === null) && stats[key] !== null && stats[key] !== undefined) out[key] = stats[key] as never;
  return out;
}

export function applyLlamagputopModelStats(stats: ModelStats, incoming: Partial<ModelStats>): ModelStats {
  const out = { ...stats };
  for (const key of Object.keys(incoming) as (keyof ModelStats)[]) if ((key === "reasoning" || out[key] === null) && incoming[key] !== null && incoming[key] !== undefined) out[key] = incoming[key] as never;
  return out;
}

export function statsUrl(url: string): string {
  const value = url.trim().replace(/\/$/, "");
  return value.endsWith("/stats") ? value : `${value}/stats`;
}

export function healthUrl(url: string): string {
  return statsUrl(url).replace(/\/stats$/, "/health");
}

export async function fetchLlamagputopStats(url: string): Promise<{ info: LlamagputopInfo | null; error: string | null; unavailable: boolean }> {
  if (!url) return { info: null, error: "stats: no url", unavailable: true };
  try {
    const text = await fetchText(statsUrl(url));
    const result = normalizeLlamagputopStats(JSON.parse(text));
    return { ...result, unavailable: false };
  } catch (e: any) {
    return { info: null, error: `stats: ${e?.message || String(e)}`, unavailable: true };
  }
}

export async function fetchLlamagputopHealth(url: string): Promise<string | null> {
  try {
    await fetchText(healthUrl(url));
    return null;
  } catch (e: any) {
    return `health: ${e?.message || String(e)}`;
  }
}
