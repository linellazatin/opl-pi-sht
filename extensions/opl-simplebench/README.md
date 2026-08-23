# opl-simplebench

Auditable Pi model benchmark for reasoning, JSON instruction following, and tool-call generation. It supports Ollama, OpenAI-compatible providers such as LiteLLM and OpenRouter, and Amazon Bedrock Converse.

## Commands, flags, and tool calls

```text
/simplebench
/simplebench <model>
/simplebench <model> [--no-artifact] [--thinking-max]
/simplebench --all [--no-artifact]
/simplebench --help
/simplebench --clear-cache
```

The LLM-callable tool is `simplebench`:

```ts
simplebench({ model: "global.openai.gpt-5.6-terra" })
simplebench({ model: "global.openai.gpt-5.6-terra", no_artifact: true })
simplebench({ model: "global.openai.gpt-5.6-terra", thinking_max: true })
```

`--no-artifact` and `no_artifact: true` suppress the JSON file. Default runs use the provider's sampling and reasoning defaults and write one JSON report per model to Pi's current working directory. `--thinking-max` and `thinking_max: true` request `reasoning_effort: "max"` for OpenAI-compatible providers, or Pi's model-aware Bedrock max-thinking path for direct Bedrock models that advertise `reasoning: true` and `thinkingLevelMap.max`. Other providers reject that mode rather than silently using defaults.

## Extension features

- Cache-bypassing by default: OpenAI-compatible requests (LiteLLM, OpenRouter, etc.) send `cache: {"no-cache": true}` so a proxy-level response cache never serves results. A benchmark must measure real inference; without this, identical prompts across runs return cached responses instantly and the proxy logs show 200s while the backend server stays idle.

- Twenty fixed reasoning prompts, one strict JSON instruction test, and one chained tool-call test.
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

### Inspect a result

A normal run prints an absolute artifact path. The JSON contains the original prompt, complete model response, extraction/evaluation information, timings, usage values, errors, and aggregate metrics. Fields unavailable from a provider are `null`, never estimates. Artifacts record requested and effective thinking mode, logical level, and whether model metadata came from the active Pi context or scoped model registry.

## Artifacts and privacy

Artifacts are written to `process.cwd()` and named:

```text
simplebench-<sanitized-model>-<UTC-timestamp>.json
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

The model receives weather and calculation tools. Simplebench validates expected tool names and minimally inspects arguments. It does **not** execute model-requested tools or judge a final answer based on tool output.

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
tests.ts       benchmark fixtures
scoring.ts     extraction and scoring
metrics.ts     request/usage aggregation
artifact.ts    cwd JSON artifact writer
report.ts      terminal output and recommendation policy
types.ts       shared benchmark types
util/          local configuration, formatting, debugging, and provider helpers
```

The extension is self-contained under `extensions/opl-simplebench/`, ready to copy into the `opl-pi-sht` extension stack after local verification.
