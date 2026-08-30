# opl-simplebench

Auditable Pi model benchmark for reasoning, JSON instruction following, and tool-call generation. It supports Ollama, OpenAI-compatible providers such as LiteLLM and OpenRouter, and Amazon Bedrock Converse.

## Commands, flags, and tool calls

```text
/simplebench
/simplebench <model>
/simplebench <model> [--no-artifact] [--thinking-max]
/simplebench <model> --coding-lite
/simplebench <model> --test-all
/simplebench <model> --llama-server
/simplebench <model> --llamagputop
/simplebench <model> --test-all
/simplebench --all [--no-artifact]
/simplebench --all --test-all
/simplebench --help
/simplebench --clear-cache
```

The LLM-callable tool is `simplebench`:

```ts
simplebench({ model: "global.openai.gpt-5.6-terra" })
simplebench({ model: "global.openai.gpt-5.6-terra", no_artifact: true })
simplebench({ model: "global.openai.gpt-5.6-terra", thinking_max: true })
simplebench({ model: "global.openai.gpt-5.6-terra", coding_lite: true })
simplebench({ model: "global.openai.gpt-5.6-terra", test_all: true })
```

`--no-artifact` and `no_artifact: true` suppress the JSON file. Default runs use the provider's sampling and reasoning defaults and write one JSON report per model to Pi's current working directory. `--thinking-max` and `thinking_max: true` request `reasoning_effort: "max"` for OpenAI-compatible providers, or Pi's model-aware Bedrock max-thinking path for direct Bedrock models that advertise `reasoning: true` and `thinkingLevelMap.max`. Other providers reject that mode rather than silently using defaults.

## Extension features

- Cache-bypassing by default: OpenAI-compatible requests (LiteLLM, OpenRouter, etc.) send `cache: {"no-cache": true}` so a proxy-level response cache never serves results. A benchmark must measure real inference; without this, identical prompts across runs return cached responses instantly and the proxy logs show 200s while the backend server stays idle.

- Twenty fixed reasoning prompts, one strict JSON instruction test, and one chained tool-call test.
- Six opt-in execution-backed coding tasks in disposable directories (`--coding-lite`).
- `--test-all` runs baseline, coding-lite, and the live research-artifact task; `--all` still selects every Ollama model.
- `--llama-server` (`llama_server: true`) captures configured direct llama-server `/props` and `/metrics` without changing inference routing, so it works with a LiteLLM proxy.
- `--llamagputop` (`llamagputop: true`) captures configured llama.cpp `/stats` metadata independently of the inference provider; its served model ID is authoritative.
- Provider-default sampling and reasoning by default, with explicit `--thinking-max` for OpenAI-compatible proxies and metadata-gated direct Bedrock models.
- Full JSON artifacts containing exact prompts, responses, scores, errors, per-test timing, provider usage, and returned tool calls.
- Aggregate request count, retry count, tool-call count, token totals where returned by the provider, output tok/s where calculable, and average/median/P95 latency.
- Provider API keys from `models.json` (`$VAR`/`${VAR}` expansion), environment variables, or Pi `auth.json`.
- Amazon Bedrock Converse calls with SigV4 and AWS CLI credential export for assume-role/SSO profiles.
- Category-based recommendations, avoiding a contradictory `WEAK` label when reasoning is moderate but JSON and tool-use tests pass.

## How to use it

### Benchmark the selected model

```text
/simplebench
```

### Benchmark a named model

```text
/simplebench global.openai.gpt-5.6-terra
```

### Keep responses off disk

```text
/simplebench global.openai.gpt-5.6-terra --no-artifact
```

Use this in sensitive environments. The terminal summary still reports category outcomes and aggregate metrics.

### Benchmark every available Ollama model

```text
/simplebench --all
```

`--all` is intentionally limited to Ollama discovery. It writes one artifact per model unless `--no-artifact` is set.

### Research artifact in `--test-all`

`--test-all` runs a benchmark-local agent workflow after coding-lite. Its prompt requires the model to call `web_search`, call `read_skill` for minimalist UI guidance, write `research.md` with a concise synthesis and a `## Sources` section linking returned URLs, and write a responsive editorial `page.html`. The HTML must use semantic `<main>` content and viewport metadata, with restrained colors and readable type, no gradients, and no heavy shadows. `web_search` uses `researchSearchProvider` and `researchSearchUrl` from `opl-simplebench.json`: DDGS calls `/search/text`; SearXNG calls `/search`. This is benchmark-local tool evidence, not an invocation of the separately installed `opl-webaccess` extension or the Pi skill runtime. `STRONG` requires every tool/file/citation/rubric check.

### Inspect a result

A normal run prints an absolute artifact path. The JSON contains the original prompt, complete model response, extraction/evaluation information, timings, usage values, errors, and aggregate metrics. Fields unavailable from a provider are `null`, never estimates. Artifacts record requested and effective thinking mode, logical level, metadata source, and `benchmark.suite` (`baseline`, `coding-lite`, or `test-all`). Standalone coding-lite artifacts contain only coding records in `tests[]` and use a coding-specific recommendation in Pi output.

When coding-lite is enabled, each coding task is recorded as a `kind: "coding"` entry in `tests[]` with public/hidden verification and edit-loop details. Coding task records are not duplicated in `summary`; baseline aggregate metrics remain in `summary.metrics`.

### Configured metadata (`--llama-server`, `--llamagputop`)

Copy `configs/opl-simplebench.json.sample` to `~/.pi/agent/configs/opl-simplebench.json`. It uses camelCase fields: `llamaServerUrl`, `llamagputopUrl`, `researchSearchProvider`, `researchSearchUrl`, and `researchMaxResults`. `--llama-server` captures `GET /props` and `/metrics` from configured `llamaServerUrl`; inference remains on the configured provider route, including LiteLLM. `--llamagputop` captures configured `llamagputopUrl` stats.

`serverStats` is omitted entirely for runs without the flag. Its shape:

```json
{
  "summary": {
    "serverStats": {
      "modelConfig": { "model": "Qwen3.5-9B-UD-Q5_K_XL", "ctx": 131072, "ngl": null, "flash-attn": null, "threads": null, "batch": null, "slots": 1, "kv-k/v": null, "temp": 0.6, "top-k": 20, "top-p": 0.95, "min-p": 0, "repeat": 1, "spec-type": "none", "n-max": null, "draft-kv": null },
      "modelStats": { "prefill": null, "gen": null, "session-avg": null, "reasoning": "none", "draft-accepted-p": null, "draft-accepted-tok": null },
      "errors": []
    }
  }
}
```

- `modelConfig` starts with `/props`; when `--llamagputop` is also supplied, `/stats` is authoritative for `model`, `spec-type`, and any fields it provides that were unavailable from `/props`. `ngl`, `flash-attn`, `threads`, `batch`, `kv-k/v`, `n-max`, and `draft-kv` stay `null` only when neither source exposes them.
- `modelStats` uses `/metrics` deltas for completed-window throughput and speculative counters, then `/stats` overrides its `reasoning` and fills other unavailable values. `/metrics` values are tokens/second; `draft-accepted-p` is the speculative acceptance percentage and `draft-accepted-tok` is accepted draft tokens per verification step.
- `/metrics` counters are server-wide cumulative telemetry. Under concurrent traffic the deltas are not isolated to this benchmark, and they are `null` when the required counters or a positive elapsed time are unavailable. Per-request usage in `tests[]` and `summary.metrics` remains the authoritative benchmark measurement.
- Probe failures are recorded in `serverStats.errors` and reported as a warning; they never fail the benchmark. `/props` is never stored raw, so the chat template and local model path are excluded.

#### `--llamagputop`: configured llama.cpp stats

`--llamagputop` fetches the configured server's normalized snapshot and fills null `serverStats.modelConfig` and `modelStats` fields. `modelConfig.model` records the actual served model ID returned by `/stats`, such as `gemma-4-E4B-it-Q8_0`. The endpoint can be given as `/stats` or its host root. No match against Pi's selected model is performed: the declared llamagputop endpoint is the source of truth.

The stats endpoint is metadata-only and does not change inference routing. Its served model identity, `spec-type`, and `reasoning` values take precedence over `/props`/`/metrics` placeholders when both sources are enabled. If `/stats` is unavailable, the collector checks sibling `/health` only to distinguish endpoint failure from an unhealthy collector; health data is not stored. Raw responses are never written, and all probe errors go to `serverStats.errors`.

## Artifacts and privacy

Baseline and coding-lite artifacts are written to `process.cwd()` as JSON. `--test-all` writes a bundle:

```text
simplebench--test-all-<sanitized-model>-<thinking>-<UTC-timestamp>/
  result.json
  research.md
  page.html

simplebench--<suite>-<sanitized-model>-<thinking>-<UTC-timestamp>.json

The default suite is named `3ptest`, so examples are `simplebench--test-all-<model>-max-<UTC-timestamp>.json` and `simplebench--3ptest-<model>-default-<UTC-timestamp>.json`.
```

They deliberately preserve benchmark prompts and model responses for auditability. They never include credentials, Authorization headers, AWS credentials, cookies, or provider authentication payloads. Use `--no-artifact` if storing responses is not appropriate.

An artifact write error does not invalidate an otherwise completed benchmark; Simplebench reports it as a warning.

## Benchmark methodology

### Reasoning

Twenty deterministic prompts cover arithmetic, logic, causal reasoning, comparison, physical/common sense, and analogies. A result records the expected answer, extracted answer, extraction method, and heuristic reasoning evidence.

`STRONG` means a correct answer with detected reasoning evidence; `MODERATE` means a correct answer; `WEAK` and `FAIL` are incorrect answers with or without detected evidence. This is a lightweight regression benchmark, not a comprehensive intelligence evaluation.

### Instruction following

The model must emit valid JSON with the required schema and values. The artifact records the complete output and schema result.

### Tool usage

The model receives weather and calculation tools. For OpenAI-compatible and Ollama providers, Simplebench validates expected tool names and arguments, executes deterministic local results, and requires the final answer to use both results. For local llama-server evaluation, start with `--jinja` and a tool-aware chat template; models or templates that cannot call tools receive a benchmark failure rather than a compatibility workaround. Direct Bedrock keeps its existing single-request tool-call check.

### Coding lite

Coding-lite is the execution-backed coding-agent suite. It runs model-directed edits in temporary directories. The model can list, search, read, write, and run the fixture's public tests, but cannot execute arbitrary commands, access the real repository, read hidden verification code, or use the network. The host runs hidden verification after the model stops.

The six tasks cover a boundary bug, input validation, cross-file debugging, behavior-preserving cleanup, a CLI flag, and a complete edit-and-verify loop. A task passes only when hidden verification succeeds and no unrelated files were changed.

Use `--coding-lite` for coding tasks only. Use `--test-all` to run the existing reasoning, instruction, and tool-format tests plus coding-lite. Use `--all --test-all` to run the complete suite for every discovered Ollama model.

### Recommendation policy

The recommendation is based on the three displayed categories:

| Result | Recommendation |
|---|---|
| Strong reasoning, JSON pass, tool pass | STRONG |
| Moderate reasoning, JSON pass, tool pass | GOOD |
| Any two categories pass | USABLE |
| One category passes | LIMITED |
| No category passes | WEAK |

## Provider authentication

### LiteLLM and OpenAI-compatible proxies

Configure a provider API key in `models.json` as a literal value or a `$VAR`/`${VAR}` reference. Simplebench expands the reference before making the request. An invalid LiteLLM key can surface as a misleading database-related proxy error; verify the resolved key before changing the proxy database configuration.

### OpenRouter

Simplebench uses, in order, a configured provider key, `OPENROUTER_API_KEY`, then Pi's stored `auth.json` API key. A `models.json` provider entry containing only `modelOverrides` does not replace OpenRouter's built-in base URL.

### Amazon Bedrock

Simplebench derives the region from the selected model's Bedrock base URL, signs default Converse requests with SigV4, and does not send sampling overrides. For `--thinking-max`, it uses Pi's Bedrock adapter and resolved model metadata rather than duplicating model-family thinking rules. The selected model must advertise `reasoning: true` and non-null `thinkingLevelMap.max`; otherwise Simplebench fails before sending a benchmark request. It resolves credentials from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` first, otherwise it runs:

```text
aws configure export-credentials --profile "$AWS_PROFILE"
```

AWS CLI v2 is therefore required when the selected profile uses SSO or an assume-role chain.

## Troubleshooting

| Symptom | Likely cause and action |
|---|---|
| LiteLLM returns `No connected db.` | Usually invalid/missing proxy authentication, not a database requirement. Check the resolved provider key. |
| OpenRouter returns 401 | Set `OPENROUTER_API_KEY`, configure the provider key, or authenticate Pi so `auth.json` has an API key. |
| Bedrock says credentials are unavailable | Run `aws configure export-credentials --profile "$AWS_PROFILE"` and resolve profile login/role issues first. |
| Bedrock rejects `--thinking-max` | The selected model does not advertise max thinking in Pi metadata, or the provider rejected its model-specific reasoning request. |
| Artifact is absent | Check the report for `--no-artifact` or an artifact-write warning; the file is written to Pi's cwd. |
| Token or TTFT values are null | The provider response did not expose authoritative usage/timing values. |

## Architecture

```text
index.ts       Pi registration, command parsing, tool schema
benchmark.ts   provider adapters and benchmark orchestration
llama-server.ts direct llama-server /props and /metrics capture
tests.ts       benchmark fixtures
scoring.ts     extraction and scoring
metrics.ts     request/usage aggregation
artifact.ts    cwd JSON artifact writer
report.ts      terminal output and recommendation policy
types.ts       shared benchmark types
util/          local configuration, formatting, debugging, and provider helpers
```

The extension is self-contained under `extensions/opl-simplebench/`, ready to copy into the `opl-pi-sht` extension stack after local verification.
