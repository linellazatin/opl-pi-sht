import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./util/debug";
import { detectProvider } from "./util/providers";
import { TOOL_SUPPORT_CACHE_PATH } from "./util/config";
import type { SimplebenchOptions } from "./types";
import { createBenchmark } from "./benchmark";

export function parseCommandArgs(args: string): SimplebenchOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  return { model: tokens.find(token => !token.startsWith("--")), allModels: tokens.includes("--all"), writeArtifact: !tokens.includes("--no-artifact"), thinkingMax: tokens.includes("--thinking-max"), codingLite: tokens.includes("--coding-lite"), testAll: tokens.includes("--test-all"), llamaServer: tokens.includes("--llama-server"), llamagputop: tokens.includes("--llamagputop") };
}

export default function (pi: ExtensionAPI) {
  const { getOllamaModels, testModel } = createBenchmark();
// ── Register /simplebench command ─────────────────────────────────────────

pi.registerCommand("simplebench", {
  description: "Benchmark a model with auditable reasoning, instruction, and tool-use tests.",
  detailedHelp: "\n\n🔍 Simplebench Extension\n\nThis extension tests AI models across multiple dimensions:\n• Reasoning: 20 diverse puzzles (logic, math, spatial, commonsense)\n• Tool Usage: Ability to use available tools effectively\n• Instruction Following: How well the model follows complex JSON instructions\n• Coding Lite: Six isolated, execution-backed coding tasks\n\n📋 Usage Examples:\n  /simplebench                    # Test current model\n  /simplebench <model>           # Test a specific model\n  /simplebench --all             # Test all Ollama models\n  /simplebench <model> --coding-lite # Run only coding tasks\n  /simplebench <model> --test-all # Run baseline plus coding tasks\n  /simplebench --all --test-all  # Run complete suite for every Ollama model\n  /simplebench <model> --thinking-max # Request max reasoning\n  /simplebench <model> --llama-server # Capture configured /props and /metrics\n  /simplebench <model> --llamagputop # Capture configured llama.cpp stats\n  /simplebench --help            # Show this help\n  /simplebench --clear-cache     # Clear tool support cache\n\nCoding tasks run in disposable directories and never access the user repository.\n",
  getArgumentCompletions: async (prefix) => {
    try {
      const models = await getOllamaModels();
      return models.map(m => ({ label: m, description: `Test ${m}` }))
        .filter(m => m.label.startsWith(prefix));
    } catch (err) { debugLog("simplebench", "failed to get model completions", err); return []; }
  },
  handler: async (args, ctx) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("simplebench requires TUI mode", "error");
      return;
    }

    const parsedArgs = parseCommandArgs(args);
    const arg = args.trim();

    if (arg === "--help") {
      ctx.ui.notify(
        "🔍 Simplebench Extension\n\n" +
        "📋 Usage:\n" +
        "  /simplebench [model] [--no-artifact] [--thinking-max] [--llama-server] - Test current or specific model\n" +
        "  /simplebench [model] --coding-lite - Run coding tasks only\n" +
        "  /simplebench [model] --test-all - Run baseline plus coding tasks\n" +
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
            display: { type: "content", content: report },
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
        display: { type: "content", content: report },
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
      test_all: { type: "boolean", description: "Run the existing baseline tests plus coding-lite." },
      llama_server: { type: "boolean", description: "Capture /props and /metrics from configured llamaServerUrl. Inference routing is unchanged." },
      llamagputop: { type: "boolean", description: "Capture configured llamagputopUrl /stats. The declared endpoint is authoritative; no Pi model match is required." },
    },
  } as any,
  execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
    const params = _params as any;
    const options: SimplebenchOptions = { model: params?.model as string | undefined, allModels: false, writeArtifact: params?.no_artifact !== true, thinkingMax: params?.thinking_max === true, codingLite: params?.coding_lite === true, testAll: params?.test_all === true, llamaServer: params?.llama_server === true, llamagputop: params?.llamagputop === true };
    const model = options.model || ctx.model?.id;
    if (!model) {
      return {
        content: [{ type: "text", text: "No model currently selected to test." }],
        isError: true,
      } as AgentToolResult;
    }
    try {
      const report = await testModel(model, ctx, options);
      return {
        content: [{ type: "text", text: report }],
        isError: false,
      } as AgentToolResult;
    } catch (e: any) {
      let errorMessage = "Model test failed";
      if (e.message) {
        errorMessage += `: ${e.message}`;
      }
      
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      } as AgentToolResult;
    }
  },
});
}
