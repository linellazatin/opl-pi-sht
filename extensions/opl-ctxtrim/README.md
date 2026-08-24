# opl-ctxtrim

Trims the verbose `ctx_*` tool descriptions that the third-party [context-mode](https://github.com/mksglu/context-mode) MCP bridge injects into every provider request. It edits only the serialized outbound payload through Pi's documented `before_provider_request` hook, so the installed context-mode package and its tool execution are never modified.

## Commands, tools, and configuration

No commands, tools, or configuration. Loading the extension is the entire interface.

## What it does

context-mode registers eleven `ctx_*` tools whose descriptions carry multi-paragraph "Think-in-Code" prose, `WHEN`/`WHEN NOT` sections, and worked examples. Those descriptions are serialized into the tool schema on **every** provider request. `opl-ctxtrim` replaces each known tool's top-level description with a concise equivalent and shortens nested JSON Schema parameter descriptions to their first sentence.

Preserved exactly: tool names, execution routing, schema structure, `required`, `enum`, `default`, numeric bounds, and strict-mode flags. Only human-readable `description` prose changes.

Supported provider payload shapes:

- OpenAI Responses / Anthropic / Google: `{ name, description, parameters }`
- OpenAI Chat Completions / Mistral: `{ function: { name, description, parameters } }`
- Amazon Bedrock Converse: `toolConfig.tools[].toolSpec`

Any unrecognized payload shape, any non-`ctx_*` tool, and any `ctx_*` tool not in the built-in description map are returned unchanged (fail open). This means a future context-mode release that adds or renames a tool is left untouched at runtime until the extension is updated; the test suite flags such tools for review.

## Token savings

### Reproducible schema measurement

The test suite queries the installed context-mode **v1.0.169** server (11 `ctx_*` tools), serializes its real `tools/list` result as an OpenAI Responses tool array, and compares bytes before and after trimming:

| Schema state | Bytes | Change from original |
|---|---:|---:|
| Original context-mode tools | 28,019 | — |
| Current `opl-ctxtrim` output | 9,152 | **18,867 fewer (67.3%)** |
| Hypothetical empty descriptions, schemas retained | 4,683 | 23,336 fewer (83.3%) |

The final row is a ceiling, not a recommended configuration. Current replacements retain compact tool guidance and parameter descriptions; empty descriptions would remove another 4,469 bytes but make tool selection and argument construction less reliable. The remaining 4,683 bytes are mostly required schema structure, parameter names, types, enums, bounds, and `required` fields.

Run `npm run test:opl-ctxtrim` to regenerate the first two rows. It also reports a rough 3-4 bytes-per-token estimate of 4,717-6,289 tokens per request. Treat that as a byte heuristic, not billing data.

### Observed provider accounting

Fresh `/init` sessions on `litellm-proxy/gpt-5.6-terra` supplied a more useful real-world check. `cacheWrite` is the provider-reported initial cached prompt prefix; `input: 2` is only the small uncached request tail.

| Configuration | Repository | `cacheWrite` | Cache-write cost |
|---|---|---:|---:|
| ctxtrim off, Ponytail full | piper-tts-reader | 22,148 | $0.060907 |
| ctxtrim off, Ponytail full | openpi-memory | 22,229 | $0.061130 |
| ctxtrim on, Ponytail full | opl-pi-sht | 19,822 | $0.054511 |
| ctxtrim on, Ponytail off | openpi-memory | **16,774** | **$0.046129** |

The two untrimmed repositories were within 81 tokens (0.37%), despite different crawls. The observations indicate:

- `opl-ctxtrim` reduced a fresh initial request by about **2.3k provider-accounted tokens (10.5-10.8%)**. This comparison spans different repositories, so it is indicative rather than laboratory-controlled.
- With ctxtrim enabled, turning Ponytail full mode off removed another **3,048 tokens (15.4%)** in the available cross-repository comparison.
- In the same `openpi-memory` repository, moving from ctxtrim off/Ponytail full to ctxtrim on/Ponytail off saved **5,455 tokens (24.5%)** and **$0.015001** on the initial cache write. This is the combined effect, not an attribution split.

Savings apply to every provider request that carries the tool schema, including tool-follow-up turns. Exact token counts and costs vary by provider tokenizer, cache policy, repository crawl, loaded context files, system prompts, and skills.

### Other initial-prompt overhead

`opl-ctxtrim` only trims known context-mode tool-schema descriptions. It does not remove context-mode's routing anchor, active-memory injection, tool results, indexed search results, Pi's base prompt, project guides, or skills.

In the local setup used for the observations above:

- Ponytail full mode appended **5,252 bytes / 876 words** on every `before_agent_start`; disabling it produced the measured 3,048-token additional reduction above. `lite` is 5,225 bytes, so it is not a meaningful token-saving mode.
- Pi's Superpowers catalog contributed 14 names/descriptions totaling **2,168 bytes**. Its full 138.6 KB of skill instructions is loaded on demand, not in the initial prompt.
- The project `AGENTS.md` guide was **4,270 bytes / 500 words**. It is useful repository context, but shortening it is a quality tradeoff.
- `opl-modes` injects only the active mode's prompt. Its default and this measured session were `off`, so its configured chat, plan, review, and research prompts added nothing.

Removing or lazily exposing entire `ctx_*` tools could save more than description trimming, but makes those tools unavailable to the model. The extension intentionally preserves the complete tool set and all JSON Schema semantics.

## Architecture

```text
index.ts   before_provider_request handler; CTX_DESCRIPTIONS map;
           provider-shape detection; description-only trimming.
```

Exports `trimPayload`, `CTX_DESCRIPTIONS`, and `shortenParamDescription` for testing. The extension is self-contained and dependency-free.
