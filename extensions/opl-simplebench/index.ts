import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./util/debug";
import { detectProvider } from "./util/providers";
import { readTestConfig, TOOL_SUPPORT_CACHE_PATH, type ModelTestUserConfig, type RunSequenceProfile } from "./util/config";
import type { SimplebenchOptions } from "./types";
import { createBenchmark } from "./benchmark";

export function parseCommandArgs(args: string): SimplebenchOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const tagToken = tokens.find(token => token.startsWith("--tag="));
  let tag: string | undefined;
  if (tagToken) {
    tag = tagToken.slice("--tag=".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new Error(`--tag must be a single word (letters, digits, dot, dash, underscore): got "${tag}"`);
  }
  const seqToken = tokens.find(token => token === "--sequence" || token.startsWith("--sequence="));
  let sequence: boolean | string | undefined;
  if (seqToken) {
    if (seqToken === "--sequence") sequence = true;
    else {
      sequence = seqToken.slice("--sequence=".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sequence)) throw new Error(`--sequence= must name a single word (letters, digits, dot, dash, underscore): got "${seqToken.slice("--sequence=".length)}"`);
    }
  }
  return { model: tokens.find(token => !token.startsWith("--")), allModels: tokens.includes("--all"), writeArtifact: !tokens.includes("--no-artifact"), thinkingMax: tokens.includes("--thinking-max"), codingLite: tokens.includes("--coding-lite"), testAll: tokens.includes("--test-all"), researchLive: tokens.includes("--research-live"), llamaServer: tokens.includes("--llama-server"), llamagputop: tokens.includes("--llamagputop"), ...(tag ? { tag } : {}), ...(tokens.includes("--3ptest") ? { threePTest: true } : {}), ...(sequence ? { sequence } : {}) };
}

export interface ResolvedRunSequence { profile: string; runs: Array<{ entry: string; options: SimplebenchOptions }>; pauseMs: number; llamaMetrics: boolean }

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Expand one configured runSequence profile into per-iteration benchmark options. Throws on disabled/invalid configuration. */
export function resolveRunSequence(userConfig: ModelTestUserConfig, name?: string): ResolvedRunSequence {
  const rs = userConfig.runSequence;
  if (!rs?.enabled) throw new Error("runSequence is not enabled in opl-simplebench.json");
  const profiles: RunSequenceProfile[] = [];
  if (Array.isArray(rs.sequence) && rs.sequence.length > 0) profiles.push({ name: "", iterations: rs.sequence });
  for (const profile of rs.sequences ?? []) {
    if (typeof profile?.name !== "string" || !PROFILE_NAME_RE.test(profile.name)) throw new Error(`runSequence profile name must be a single word (letters, digits, dot, dash, underscore): got ${JSON.stringify(profile?.name)}`);
    if (!Array.isArray(profile.iterations) || profile.iterations.length === 0) throw new Error(`runSequence profile "${profile.name}" needs a non-empty iterations array`);
    if (profiles.some(known => known.name === profile.name)) throw new Error(`duplicate runSequence profile name: "${profile.name}"`);
    profiles.push(profile);
  }
  const label = (p: RunSequenceProfile) => p.name || "(legacy)";
  if (profiles.length === 0) throw new Error("runSequence needs a non-empty sequence array or sequences list");
  let chosen: RunSequenceProfile | undefined;
  if (name) chosen = profiles.find(p => p.name === name);
  else if (profiles.length === 1) chosen = profiles[0];
  if (!chosen) throw new Error(name ? `unknown runSequence profile "${name}"; available: ${profiles.map(label).join(", ")}` : `--sequence needs a profile name; available: ${profiles.map(label).join(", ")}`);
  const pauseMs = chosen.pauseMs ?? rs.pauseMs ?? 0;
  if (typeof pauseMs !== "number" || !Number.isFinite(pauseMs) || pauseMs < 0) throw new Error(`runSequence.pauseMs must be a non-negative number: got ${JSON.stringify(chosen.pauseMs ?? rs.pauseMs)}`);
  const llamaMetrics = (chosen.llamaMetrics ?? rs.llamaMetrics) === true;
  const runs = chosen.iterations.map((entry: string) => {
    const tokens = String(entry).trim().split(/\s+/);
    if (tokens.includes("--all")) throw new Error(`runSequence entry cannot contain --all: "${entry}"`);
    if (tokens.some(token => token === "--sequence" || token.startsWith("--sequence="))) throw new Error(`runSequence entry cannot contain --sequence: "${entry}"`);
    return { entry: String(entry), options: parseCommandArgs(`${entry}${llamaMetrics ? " --llama-server --llamagputop" : ""}`) };
  });
  return { profile: chosen.name, runs, pauseMs, llamaMetrics };
}

export default function (pi: ExtensionAPI) {
  const { getOllamaModels, testModel } = createBenchmark();
// ── Register /simplebench command ─────────────────────────────────────────

pi.registerCommand("simplebench", {
  description: "Benchmark a model with auditable closed-answer, instruction, and tool-use tests.",
  getArgumentCompletions: async (prefix) => {
    try {
      const models = await getOllamaModels();
      return models.map(m => ({ value: m, label: m, description: `Test ${m}` }))
        .filter(m => m.label.startsWith(prefix));
    } catch (err) { debugLog("simplebench", "failed to get model completions", err); return []; }
  },
  handler: async (args, ctx) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("simplebench requires TUI mode", "error");
      return;
    }

    let parsedArgs: SimplebenchOptions;
    try {
      parsedArgs = parseCommandArgs(args);
    } catch (e: any) {
      ctx.ui.notify(e?.message || String(e), "error");
      return;
    }
    const arg = args.trim();

    if (arg === "--help") {
      ctx.ui.notify(
        "🔍 Simplebench Extension\n\n" +
        "📋 Usage:\n" +
        "  /simplebench [model] [--no-artifact] [--thinking-max] [--llama-server] - Test current or specific model\n" +
        "  /simplebench [model] --coding-lite - Run coding tasks only\n" +
        "  /simplebench [model] --test-all - Run baseline, coding, and deterministic grounded research\n" +
        "  /simplebench [model] --research-live - Add live-search integration smoke test\n" +
        "  /simplebench [model] --tag=<word> - Label the run (single word; added to benchmark.tag and the artifact name)\n" +
        "  /simplebench [model] --3ptest - Run the default baseline suite explicitly\n" +
        "  /simplebench [model] --sequence[=<name>] - Run a templated multi-iteration sequence profile from opl-simplebench.json (runSequence.sequences; bare --sequence needs exactly one profile; per-entry --tag, llamaMetrics and pauseMs supported, profile values override the block ones; the outer --tag is ignored)\n" +
        "  /simplebench --all --test-all - Run complete suite for all Ollama models\n" +
        "  /simplebench --clear-cache - Clear tool support cache\n",
        "info"
      );
      return;
    }

    if (arg === "--clear-cache") {
      try {
        const fs = require("node:fs");
        if (fs.existsSync(TOOL_SUPPORT_CACHE_PATH)) {
          fs.unlinkSync(TOOL_SUPPORT_CACHE_PATH);
          ctx.ui.notify("Tool support cache cleared successfully", "info");
        } else {
          ctx.ui.notify("No cache file found to clear", "info");
        }
      } catch (err) {
        ctx.ui.notify("Could not clear cache", "error");
      }
      return;
    }

    if (parsedArgs.sequence) {
      const requested = typeof parsedArgs.sequence === "string" ? parsedArgs.sequence : undefined;
      let resolved: ResolvedRunSequence;
      try {
        resolved = resolveRunSequence(readTestConfig(), requested);
      } catch (e: any) {
        ctx.ui.notify(e?.message || String(e), "error");
        return;
      }
      const sequenceModel = parsedArgs.model || ctx.model?.id;
      if (!sequenceModel) {
        ctx.ui.notify("No model specified and no model currently selected", "error");
        return;
      }
      ctx.ui.notify(`Running ${resolved.runs.length}-iteration sequence${resolved.profile ? ` "${resolved.profile}"` : ""} (llamaMetrics ${resolved.llamaMetrics ? "on" : "off"}, pause ${resolved.pauseMs / 1000}s): ${resolved.runs.map(r => r.entry).join(" | ")}...`, "info");
      let completed = 0;
      for (let i = 0; i < resolved.runs.length; i++) {
        if (i > 0 && resolved.pauseMs > 0) {
          ctx.ui.notify(`Cooling down ${resolved.pauseMs / 1000}s before iteration ${i + 1}/${resolved.runs.length}...`, "info");
          await new Promise(resolve => setTimeout(resolve, resolved.pauseMs));
        }
        const { entry, options } = resolved.runs[i];
        const model = options.model || sequenceModel;
        ctx.ui.notify(`Iteration ${i + 1}/${resolved.runs.length} (${entry}) on ${model}...`, "info");
        try {
          const report = await testModel(model, ctx, { ...options, model });
          completed += 1;
          pi.sendMessage({
            customType: "simplebench-report",
            content: report,
            display: true,
            details: { model, timestamp: new Date().toISOString() },
          });
        } catch (e: any) {
          ctx.ui.notify(`Iteration ${i + 1} (${entry}) failed: ${e.message}`, "error");
        }
      }
      ctx.ui.notify(`Sequence done: ${completed}/${resolved.runs.length} iterations completed`, "info");
      return;
    }

    if (parsedArgs.allModels) {
      const providerInfo = detectProvider(ctx);
      if (providerInfo.kind !== "ollama") {
        ctx.ui.notify(`--all is only supported for Ollama models. Current provider: ${providerInfo.name} (${providerInfo.kind})`, "error");
        return;
      }

      ctx.ui.notify("Testing all models — this will take a while...", "info");
      let models: string[];
      try {
        models = await getOllamaModels();
      } catch (err) {
        debugLog("simplebench", "failed to list Ollama models for --all", err);
        ctx.ui.notify("Could not list Ollama models", "error");
        return;
      }

      if (models.length === 0) {
        ctx.ui.notify("No models found in Ollama", "error");
        return;
      }

      for (const model of models) {
        ctx.ui.notify(`Testing ${model}...`, "info");
        try {
          const report = await testModel(model, ctx, parsedArgs);
          pi.sendMessage({
            customType: "simplebench-report",
            content: report,
            display: true,
            details: { model, timestamp: new Date().toISOString() },
          });
        } catch (e: any) {
          ctx.ui.notify(`Failed to test ${model}: ${e.message}`, "error");
        }
      }
      ctx.ui.notify(`Done testing ${models.length} models`, "info");
      return;
    }

    const model = parsedArgs.model || ctx.model?.id;
    if (!model) {
      ctx.ui.notify("No model specified and no model currently selected", "error");
      return;
    }

    ctx.ui.notify(`Testing ${model}...`, "info");
    try {
      const report = await testModel(model, ctx, parsedArgs);
      pi.sendMessage({
        customType: "simplebench-report",
        content: report,
        display: true,
        details: { model, timestamp: new Date().toISOString() },
      });
    } catch (e: any) {
      let errorMessage = "Model test failed";
      if (e.message) {
        errorMessage += `: ${e.message}`;
      }
      ctx.ui.notify(errorMessage, "error");
    }
  },
});

// ── Register simplebench tool (LLM-callable) ─────────────────────────

pi.registerTool({
  name: "simplebench",
  label: "Simplebench",
  description: "Benchmark a model's reasoning, instruction following, and tool-call generation. Writes an audit JSON artifact by default.",
  promptSnippet: "simplebench - benchmark a model with an optional JSON artifact",
  promptGuidelines: [
    "When the user asks to test or evaluate a model, call simplebench with the model name.",
  ],
  parameters: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model name to test. If omitted, tests the current model." },
      no_artifact: { type: "boolean", description: "If true, do not write the detailed JSON audit artifact to the current working directory." },
      thinking_max: { type: "boolean", description: "Request maximum reasoning on an OpenAI-compatible provider or a direct Bedrock model that advertises max thinking. Omit to use provider defaults." },
      coding_lite: { type: "boolean", description: "Run only the six execution-backed coding tasks in disposable directories." },
      test_all: { type: "boolean", description: "Run the existing baseline, coding-lite, and deterministic grounded research tests." },
      research_live: { type: "boolean", description: "Run configured live-search research as an integration smoke test; it does not affect recommendation." },
      llama_server: { type: "boolean", description: "Capture /props and /metrics from configured llamaServerUrl. Inference routing is unchanged." },
      llamagputop: { type: "boolean", description: "Capture configured llamagputopUrl /stats. The declared endpoint is authoritative; no Pi model match is required." },
      tag: { type: "string", description: "Optional single-word label (letters, digits, dot, dash, underscore). Stored under benchmark.tag and prefixed onto the artifact file or bundle name." },
    },
  } as any,
  execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
    const params = _params as any;
    if (params?.tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(params.tag))) {
      return {
        content: [{ type: "text", text: "--tag must be a single word (letters, digits, dot, dash, underscore)" }],
        details: undefined,
        isError: true,
      } as AgentToolResult;
    }
    const options: SimplebenchOptions = { model: params?.model as string | undefined, allModels: false, writeArtifact: params?.no_artifact !== true, thinkingMax: params?.thinking_max === true, codingLite: params?.coding_lite === true, testAll: params?.test_all === true, researchLive: params?.research_live === true, llamaServer: params?.llama_server === true, llamagputop: params?.llamagputop === true, ...(params?.tag ? { tag: String(params.tag) } : {}) };
    const model = options.model || ctx.model?.id;
    if (!model) {
      return {
        content: [{ type: "text", text: "No model currently selected to test." }],
        details: undefined,
        isError: true,
      } as AgentToolResult;
    }
    try {
      const report = await testModel(model, ctx, options);
      return {
        content: [{ type: "text", text: report }],
        details: undefined,
        isError: false,
      } as AgentToolResult;
    } catch (e: any) {
      let errorMessage = "Model test failed";
      if (e.message) {
        errorMessage += `: ${e.message}`;
      }
      
      return {
        content: [{ type: "text", text: errorMessage }],
        details: undefined,
        isError: true,
      } as AgentToolResult;
    }
  },
});
}
