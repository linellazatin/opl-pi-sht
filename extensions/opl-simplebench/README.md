# opl-simplebench

Auditable Pi model benchmark for reasoning, JSON instruction following, and tool-call generation. It supports Ollama, OpenAI-compatible providers such as LiteLLM and OpenRouter, and Amazon Bedrock Converse.

## Commands, flags, and tool calls

```text
/simplebench
/simplebench <model>
/simplebench <model> --no-artifact
/simplebench --all [--no-artifact]
/simplebench --help
/simplebench --clear-cache
```

The LLM-callable tool is `simplebench`:

```ts
simplebench({ model: "global.openai.gpt-5.6-terra" })
simplebench({ model: "global.openai.gpt-5.6-terra", no_artifact: true })
```

`--no-artifact` and `no_artifact: true` suppress the JSON file. Default runs write one JSON report per model to Pi's current working directory.

## Extension features

- Twenty fixed reasoning prompts, one strict JSON instruction test, and one chained tool-call test.
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

A normal run prints an absolute artifact path. The JSON contains the original prompt, complete model response, extraction/evaluation information, timings, usage values, errors, and aggregate metrics. Fields unavailable from a provider are `null`, never estimates.

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

Simplebench derives the region from the selected model's Bedrock base URL, signs Converse requests with SigV4, and does not send unsupported sampling fields. It resolves credentials from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` first, otherwise it runs:

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
| Bedrock rejects a sampling field | The model may not support it; Simplebench sends only max tokens to Converse. |
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
