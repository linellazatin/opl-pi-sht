# Changelog

## [0.1.22] - 2026-09-20

### Security hardened

- **`opl-modes`**: the read-only Bash allowlist is now checked **per shell segment** instead of only against the start of the command line. `&&`, `||`, `;`, `|`, newlines, `$(...)`, backticks, and `<(`/`>(` each begin a segment and every segment must be safe-listed, so `cat f && node -e '...'`, `ls; python -c '...'`, `echo x && sed -i ...`, `cat "$(rm -rf /tmp/x)"`, and `sort -o out in` no longer ride the first command's allowance. Quoted string contents are ignored when locating segments, so `grep "a|b"` is still one command.
- **`opl-modes`**: destructive defaults are anchored to command position and matched per segment, so read-only commands that merely mention a dangerous word in an argument are allowed again (`du -sh`, `find . -name '*.sh'`, `ls cp/`, `cat mv.sh`, `git log --grep=rm`, `grep -rn 'touch' src`, `git branch -a`). `git branch -` tightened to `-[dDmM]`, `--delete`/`--exec`/`--exec-batch` now caught, `sort -o` and `<(`/`>(` substitution added. Obfuscation is still blocked: every pattern is tested against the command and each segment, raw and quote/backslash-stripped (`r"m"`, `-del"ete"`). 25 entries became 12; the `.sample` config and both `_comment` keys were updated to match.

### Fixed

- **`opl-footer`**: `applyColor()` and `resolveColorToRgb()` no longer propagate Pi's `Unknown theme color` throw. A bad token in `opl-footer.json` `colors`, in an `opl-modes` `appearance.modeColor`, or a malformed hex now renders that text uncolored instead of failing every footer render.
- **`opl-modes`**: only `plan` and `execute` publish a non-off `__planMode`, so entering a custom mode no longer makes the footer's legacy `plan_mode` segment report `Plan mode: ON`.
- **`opl-modes`**: `unrestrictedBash` is honored when **overriding a built-in mode** (`modes.chat.unrestrictedBash` etc.), not only for new custom modes; it previously merged silently into an unused field.
- **`opl-modes`**: a blank or partial `model` (`{ "provider": "", "id": "" }`, `{}`) is normalized to "no override" instead of warning `Model not found: /`, leaving the mode model in place, and skipping the restore of the previous model. Blank now behaves like omitting the key, so a blank `modes.off.model` lets `--model` and the configured default stand.
- **`opl-modes`**: mode entry snapshots the **active** tool set rather than every registered tool, and the restore/execute/session-restore paths use it too, so exiting a mode can no longer widen the set beyond what was active before it.
- **`opl-modes`**: the model restore point is persisted in the `mode-switcher` session entry, so `/reload` or `/resume` inside a mode restores the real pre-mode model instead of recording the mode's own model as the restore point.
- **`opl-input`**: the chat fallback style used `chatModeBorder`, which is not a Pi theme token, so chat's border and prefix rendered in the plain `border` color on built-in themes; now `borderAccent`. Configure `modes.chat.appearance` (or add the token to a custom theme) to keep your own color.
- **`opl-input`**: the mode `prefix` is clamped to one terminal cell; a wide `appearance.prefix` previously pushed the box border one cell past the editor width and misaligned continuation lines.
- Removed the dead `isSafeCommand()` helper (the handler had its own copy of the logic); `tests/opl-modes-helpers.test.mjs` gained segment, anchor, `unrestrictedBash`, blank-model, and restore-point persistence checks; `tests/opl-input-style.test.mjs` updated for the chat token.

### Added

- **`opl-modes`**: `modes.off.tools` pins the resting (OFF) tool set, so `load_tools`-escalated lazy tools (`subagent`, `browser`, `simplebench`, ...) can be kept out of normal mode deliberately instead of being available because OFF inherits everything.
- **`opl-modes`**: `/mode <name>` now accepts any registered mode, so config-defined modes (`/mode review`, `/mode research`) work like the picker entries; `execute` explains that it needs `/execute`, disabled modes report `enabled: false`, and the unknown-mode warning lists the real choices. Command description updated to `… · /mode <custom>`.
- **`opl-modes`**: a mode listing an unknown tool name now warns once per session (`modes.<name>.tools: unknown tool "x" is ignored by Pi`) instead of Pi silently shrinking the mode's tool set.
- **`opl-modes`**: the bundled `research` mode prompt tells the model to `load_tools` first when `subagent`/`subagent_wait`/`browser` are withheld by `lazyTools`, so the fan-out instructions are actually executable.

### Fixed

- **`opl-modes`**: ESC during execution no longer drops the session out of execute mode. `agent_end` auto-exit now checks the last assistant message's `stopReason`: an aborted turn keeps execute mode (resumable via `/execute`), while a completed turn that never called `plan_complete` still exits as before.
- **`opl-modes`**: `allowPlanComplete: true` on a custom mode with **no** `tools` list now activates `plan_complete` (it was allowed by the gate but never active, so the mode could not finish), and `withPlanComplete()` is applied on the session-restore path, so resume keeps the tool.
- **`opl-footer`**: `formatTokens()` lost two dead branches that returned the same string as their neighbours (`n < 10000` and `n < 10000000`); behaviour is unchanged and the boundaries are now asserted.
- **`opl-footer`**: the thinking-level fallback `thinkingLevelFromSession || pi.getThinkingLevel()` was unreachable because the reduce was seeded with the truthy string `"off"`, so a branch with no `thinking_level_change` entry displayed `off`. Seeding is now `null` and the live Pi level is used in that case.
- **`opl-footer`, `opl-input`, `opl-modes`**: three-digit hex (`#abc`) is expanded to `#aabbcc` in every color path (footer text, footer context-bar RGB, input borders/prefix, mode labels). Previously it rendered uncolored with a stray `\x1b[0m` reset in footer/input and plain text in modes.
- **`opl-modes`**: a plan name must contain a letter or digit. `sanitizePlanName()` accepted punctuation-only input (`"."`, `"--"`, `". ."`), which created `plan-.md` with an empty display title; those are now rejected like any other invalid name.
- **`opl-modes`**: removed the unused `resetRefineCount()` export from `state.ts` (never called; the refine count resets with the state transition itself).

## [0.1.21] - 2026-09-17

### Fixed
- **`opl-todo`**: a schema-rejected call (`details: {}`) crashed the TUI on every render and made the session unresumable; it also aborted `session_start` before the widget overlay mounted (no widget, dead `ctrl+alt+t`). All render/reconstruct paths now guard malformed results, missing or partial args, and empty lists.
- Added `tests/opl-todo-render.test.mjs` regression check (wired into `npm run test:opl-todo`).

## [0.1.20] - 2026-09-14

### Added
- `cacheReadSegment` (cache_read) & `cacheWriteSegment` (cache_write) text labels (e.g. *Read* 27.09M / *Write* 1.40M)
- **`/configure-opl`**: six-tab footer segment, separator, and reorder configurator with immediate apply.
- **`status` footer segment**: `Working`, `Waiting` during Pi tool execution, and `Ready` when the agent settles.

### Fixed
- **`opl-modes`**: serialize mode-model changes, fail safe on malformed per-mode Bash patterns, and honor explicit empty pattern overrides.
- **`opl-input`**: cleanup companion animation timers on editor replacement and session shutdown.

## [0.1.19] - 2026-09-13

### Security hardened

- **`opl-modes`**: destructive base now blocks `find -delete`/`-exec`, `truncate`, and `git clean`/`update-ref`/`tag -d`/`cherry-pick`/`revert`/`am`/`apply`; `env` and `printenv` are no longer safe-listed. Destructive checks run against a quote/backslash-stripped skeleton, so `r"m"` cannot dodge `\brm\b`.
  - updated config json sample, based from this fix so that defaults will have these for use
- **`opl-modes`**: `bashPatterns` is now the shared Bash base for every mode — custom modes inherit it by default and opt out with `unrestrictedBash: true`. Session restore fails closed (unknown modes fall back to normal, plan filenames with path separators or `..` are dropped).
- **`opl-browser`**: `navigate`/`new_page` accept http(s) only; screenshot paths are confined to the project directory.
- **`opl-webaccess`**: `fetch_content` is http(s)-only with a 10 MB cap and a 30s timeout; Gemini keys now travel in the `x-goog-api-key` header.
- `install.sh` copy mode sets `chmod 600` on installed configs.

## [0.1.18] - 2026-09-12

### Added
- **`opl-browser` structured extraction (`extract` action, extension v1.1.0)**: Readability + Turndown over the *rendered* (post-JS) DOM, optionally scoped to a CSS selector; runs after `click`/`fill`/`wait_for` to read the page in its interacted-with state.
  - Reuses the existing preview + `responseId` size gate — no new config keys or schema fields.
  - Selector-scoped extracts use raw turndown, skipping Readability: its whole-document candidate scoring mispicks inside small subtrees (found live on gcash.com `#about-gcash`, where five of six stat cards were dropped).
  - Complements `opl-webaccess`'s `fetch_content` (raw HTTP HTML only): static pages → `fetch_content`; rendered or interacted-with pages → `browser:extract`.
  - Pipeline intentionally duplicated from opl-webaccess (~30 lines) for per-extension install independence. Nested deps `@mozilla/readability`, `linkedom`, `turndown` are already root dependencies.

## [0.1.17] - 2026-09-11

### Added
- **Named `runSequence` profiles**: `sequences: [{ name, iterations, llamaMetrics?, pauseMs? }]`, run via `/simplebench --sequence=<name>`; a bare `--sequence` runs the only profile, otherwise fails listing names. Names are single words and unique; per-profile `llamaMetrics`/`pauseMs` override block defaults. The legacy flat `sequence` array still works as an anonymous `(legacy)` profile, but cannot be selected by name.

### Changed
- Sequence start notice now reports effective settings (`llamaMetrics on/off`, `pause Ns`), so inherited defaults are visible before the first run.

### Fixed
- All chat wrappers (OpenAI-compatible, Bedrock Converse, Ollama tool) stamp `startedAt`/`finishedAt`, fixing null timestamps in coding-lite, research, and tool-test records.

## [0.1.16] - 2026-09-03

### Added
- **`runSequence` template** for `/simplebench --sequence`: a config-driven multi-iteration benchmark protocol in `opl-simplebench.json`, e.g. a warm-up curve of `--coding-lite --tag=coldest` → `--3ptest --tag=colder` → `--coding-lite --tag=semiwarm` → `--test-all --research-live --tag=warm`. Each entry is a plain flag string with its own `--tag`; iterations run sequentially against the current (or passed) model, each writing its normal artifact, and a failed iteration does not abort the sequence.
  - `llamaMetrics: true` appends `--llama-server --llamagputop` to every entry so local server stats are captured per iteration without repeating flags.
  - `pauseMs` sleeps between iterations only (including after a failed one), keeping thermal/KV-cache cooldown consistent across the run.
  - `enabled` gates the flag; validation rejects disabled/empty sequences, negative `pauseMs`, invalid entry tags, and entries containing `--all` or `--sequence` before any run starts. The outer `--tag` is ignored during a sequence.
- **`--3ptest`** flag: the explicit form of the default baseline suite (reasoning, instruction following, tool calls). Pure alias; artifacts already named the baseline suite `3ptest`, so run behavior and filenames are unchanged.

## [0.1.15] - 2026-09-02

### Changed
- **`opl-footer` session_stats**: replaced redundant counters (turns/steps/mreq/mtool; turns and mreq were literally the same expression, steps and mtool near-identical) with `prompts · api calls · tool calls` 
  - `prompts` counts user messages
  - `api calls` counts completed assistant responses
  - `tool calls` counts emitted tool-call blocks
- Removed dead live counters (`turns`, `steps`, `modelRequests`, `modelToolCalls`) that the branch reconstruction had already superseded; timing accumulators are unchanged.

### Added
- **npm publishing**: published as `@openlines/opl-pi-sht`, so `pi install npm:@openlines/opl-pi-sht@0.1.15` works alongside the Git install (`pi install git:github.com/linellazatin/opl-pi-sht@v0.1.15`).

## [0.1.14] - 2026-09-02

### Fixed
- **`opl-init` reliability for smaller models**: `/init` now writes a deterministic fingerprinted baseline `AGENTS.md` before asking the model to refine it, so a Markdown-only response cannot leave the repository unchanged. The prompt explicitly requires a write-tool call and read-back verification.
- **`opl-init` fingerprint stability**: `AGENTS.md` is excluded from the Git status fingerprint, preventing the guide from becoming immediately stale after it is written.

## [0.1.13] - 2026-09-01

### Added
- **`--tag=<word>`** (`tag` tool parameter) for `/simplebench`: labels a run as `benchmark.tag` in the artifact, e.g. `simplebench-coldrun-coding-lite-<model>-<thinking>-<timestamp>.json`. Tags are restricted to a single word (letters, digits, dot, dash, underscore); invalid tags are rejected before the run starts.

## [0.1.12] - 2026-08-31

### Changed
- **Coding-lite pass** is correctness-only: hidden tests green and no unrelated files. `verifiedAfterEdit` (public tests after final edit) is reported but no longer required.
- **Numeric closed answers** match the expected value as the last numeric token on any line (backward scan), so trailing thinking-template remnants no longer fail correct answers. Word answers keep strict final-line matching.
- **Tool test** accepts canonical argument variants (`15*24`, `15 × 24`, `15x24`, `(15*24)`, `15*24=`) and locations such as `Tokyo, Japan`.

### Removed
- Dead legacy code from `opl-simplebench/util/config.ts`: unified reasoning/tool/instruction runners, tool-support cache, and test-history/regression store (grep-confirmed unused). The `--clear-cache` path is retained.

### Fixed
- Coding verifier failures keep only the thrown error line; the full `node --eval` source and tmp path are no longer embedded in artifacts.

## [0.1.11] - 2026-08-31

### Fixed
- Research prompt hardening on css declaration
- `cause_effect`, `relative_quantities`, `analogy_1`, `bat_and_ball`, `scale_weight`, and `commonsense` reasoning test prompts hardening for more deterministic response ask.

## [0.1.10] - 2026-08-30

### Changed
- **Closed-answer reasoning grading** evaluates only the normalized final non-empty response line. Prompts use one canonical answer; ambiguous alternatives and keyword-based “reasoning quality” scoring were removed.
- **Instruction following** requires the exact deterministic JSON object, rejecting Markdown fences, extra keys, and incorrect values.
- **Coding-lite completion** requires a passing public `run_tests` result after the final edit, in addition to hidden verification and allowed-file checks.
- Tool-completion tests no longer pass providers that cannot continue after tool results.
- **Research grading**: `--test-all` uses deterministic source cards and verifies exact inline claim citations. `--research-live` retains configured DDGS/SearXNG research as an integration smoke test that does not affect recommendation.
- **Closed-answer fixtures and reporting** now use canonical tokens/noun phrases or explicit choices, avoid optional articles and unconstrained specificity, and label their strict result as a closed-answer contract rather than broad reasoning capability.

### Fixed
- `instruction_following` no longer strips Markdown fences before JSON parsing; the JSON-only contract rejects them.

## [0.1.9] - 2026-08-30

### Added
- `configs/opl-simplebench.json.sample`: camelCase `researchSearchProvider` (`ddgs` or `searxng`), `researchSearchUrl`, `researchMaxResults`, `llamaServerUrl`, and `llamagputopUrl`. `--llama-server` and `--llamagputop` are boolean opt-ins using those configured URLs; `--test-all` includes the benchmark-local research-artifact task and writes a `result.json`/`research.md`/`page.html` bundle.
- `opl-simplebench --llama-server` (tool `llama_server`): writes `summary.serverStats` from configured direct llama-server `/props` + `/metrics` without changing LiteLLM inference. `modelConfig` = ctx, slots, temp, top-k/p, min-p, repeat, spec-type (null for build-only fields: ngl, flash-attn, threads, batch, kv-k/v, n-max, draft-kv); `modelStats` = prefill/gen/session-avg tok/s and speculative acceptance from the before/after `/metrics` delta.
- `opl-simplebench --llamagputop` (tool `llamagputop`): treats configured `/stats` as authoritative, fills `serverStats` config/stats without matching Pi's selected model, and records the served ID as `modelConfig.model`; raw responses are excluded. On `/stats` failure, `/health` is checked for diagnostics only.
- **Coding-lite efficiency scoring**: each task result now carries `efficiency: STRONG | MODERATE | WEAK | FAIL` based on turns used (1 = STRONG, 2–3 = MODERATE, 4–5 = WEAK, failed = FAIL). The `score` field in `tests[]` uses this grade. `summary.coding.efficiency` contains per-bucket counts. Recommendation uses efficiency-weighted coding score (STRONG=1.0, MODERATE=0.7, WEAK=0.4, FAIL=0, threshold 0.5).
- **Coding-lite single-shot mode**: each `CodingTaskFixture` now carries `inlinePrompt` with the buggy code embedded. Pass `singleShot: true` to `runCodingTask` for a no-tools, single-turn variant — pure model quality signal with no agent loop variance.
- **`inlinePrompt` for all six tasks**: `fix-off-by-one`, `validate-config`, `diagnose-cross-file`, `safe-refactor`, `cli-flag`, `verify-after-edit`.

### Changed
- `/stats` is authoritative for llamagputop `model`, `spec-type`, and `reasoning`, replacing `/props` placeholder values such as `none`.
- llama-server capture is opt-in; inference endpoint and sampling unchanged. `/metrics` deltas are server-wide cumulative telemetry (not per-request); response usage stays authoritative. Probe errors go to `serverStats.errors` and never fail the run; `/props` and `/stats` are never stored raw.
- **Coding-lite `maxTurns` default reduced from 12 to 5.** Tighter turn budget removes sampling-path variance and makes turn-to-solution a meaningful signal.
- **Efficiency thresholds recalibrated for 5-turn budget**: STRONG = 1–2 turns, MODERATE = 3–4 turns, WEAK = 5 turns (hit limit). With a 5-turn max, the minimum read→write→run sequence takes 3–4 turns; the old STRONG=1/MODERATE=2–3 thresholds were unreachable in agent-loop mode.
- **`safe-refactor` public test now exercises empty-string filtering.** Public verifier changed from `['a', 'b']` (original code already passes, model gets no signal) to include `['a', '', 'b']`, matching the hidden test. Without this, the model ran tests, saw green, and exhausted turns without ever adding the filter.
- **Coding-lite notify output** now shows per-task efficiency grade and turn count (`STRONG (1 turn)`, `MODERATE (2 turns)`, etc.) and a summary line with STRONG/MODERATE/WEAK counts.
- **Coding-lite artifact `summary`** now includes `summary.coding` with `passed`, `total`, and `efficiency` bucket counts.

### Fixed
- `animals_1` expected answer now accepts `water`, `ocean`, and `sea` (was `water` only; model answers `ocean`).
- `analogy_2` expected answer now accepts `boot`, `sock`, and `shoe` (was `boot`/`sock`; `shoe` is the direct analogue to `glove`).
- `cause_effect` expected answer now accepts `grows`, `grow`, and `germinate` (was `grows` only; stemming mismatch caused false failures).
- `fix-off-by-one` public verifier now tests correct inclusive behavior (`sumInclusive(1, 4) === 10`), removing the adversarial contradiction where fixing the bug caused the public test to fail.
- `instruction_following` now strips markdown fences before `JSON.parse`, matching the repair logic already in `util/config.ts`.

## [0.1.8] - 2026-08-28

### Added
- Pi package manifest loading only `extensions/*/index.ts`; Git installs install root runtime dependencies for browser and web access.
- Tag-triggered GitHub Release workflow: tests with Bun, extracts the matching changelog section, and creates the release. It does not publish to npm.

### Changed
- Root README documents `pi install git:github.com/linellazatin/opl-pi-sht@v0.1.8`, optional config copying, and the one-time Playwright Chromium setup.

### Fixed
- `opl-modes` tests no longer read ignored user configuration files in CI; appearance publication is tested with an in-memory custom mode instead.

## [0.1.7] - 2026-08-28

### Added
- Pi package manifest loading only `extensions/*/index.ts`; Git installs now install root runtime dependencies for browser and web access.
- Tag-triggered GitHub Release workflow: tests with Bun, extracts the matching changelog section, and creates the release. It does not publish to npm.

### Changed
- Root README documents `pi install git:github.com/linellazatin/opl-pi-sht@v0.1.7`, optional config copying, and the one-time Playwright Chromium setup.

## [0.1.6] - 2026-08-28

### Added
- `opl-browser`: Chromium automation via Playwright behind a single action-based `browser` tool (navigate, snapshot, screenshot, click, fill, hover, press, select, evaluate, console/network, page management). Large outputs return a preview + `responseId` (fetch via `action: "get"`); screenshots go to file. One reused browser per session. Replaces the chrome-devtools MCP. Needs `npm install` + `npx playwright install chromium`.
- `opl-modes`: `lazyTools` config — listed tools are withheld from the resting active set and enabled on demand via `load_tools`, keeping heavy schemas (`subagent`, `browser`, `simplebench`) out of the cached prefix. Activation is bounded by the current mode's policy; core built-ins, `plan_complete`, and `load_tools` are protected.

## [0.1.5] - 2026-08-24

### Added
- `opl-ctxtrim`: trims verbose context-mode `ctx_*` tool-schema descriptions on outbound requests (`before_provider_request` hook) for OpenAI Responses/Chat Completions and Bedrock Converse, without touching the context-mode package. Preserves names, structure, required fields, enums, defaults, bounds, strict flags; fails open on unknown formats/tools. Measured vs context-mode v1.0.169: 28,019 → 9,152 bytes (67.3%, ~4,700-6,300 tokens/request).

### Changed
- Root `README.md`, `install.sh`, `package.json` include `opl-ctxtrim` (nine extensions).

### Tests
- `tests/opl-ctxtrim.test.ts`: all provider shapes, non-`ctx_*` preservation, fail-open paths, input immutability, single-handler registration, and a live context-mode measurement.

## [0.1.4] - 2026-08-23

### Added
- `opl-simplebench`: six execution-backed coding-lite tasks (disposable dirs, restricted tools, hidden verification, coding metrics) with `--coding-lite`, `--test-all`, and matching LLM options; `--test-all` composes with `--all`.

### Changed
- `opl-simplebench`: Ollama chat forwards native tool defs and captures streamed tool calls; missing-path file inspection returns recoverable errors; coding-lite records live in artifact `tests[]` as a fourth recommendation category.

### Tests
- Fixture isolation, path traversal, public/hidden verification, coding-mode arguments.

## [0.1.3] - 2026-08-23

### Changed
- `opl-simplebench`: default runs leave sampling/reasoning to the provider; `--thinking-max` requests max reasoning for OpenAI-compatible providers and metadata-advertised direct Bedrock models (delegating Bedrock request construction to Pi's adapter). Artifacts record requested/effective thinking mode, level, and metadata source.

### Tests
- Metadata-gated Bedrock max-thinking resolution; retained provider-default/OpenAI-compatible checks.

## [0.1.2] - 2026-08-23

### Hotfix
- `opl-simplebench`: fixed instruction-following report rendering (`reportInstructionScore` → `formatInstructionScore`).

## [0.1.1] - 2026-08-23

### Added
- `opl-simplebench`: model benchmark for reasoning, JSON instruction-following, and tool-call generation across providers.

### Changed
- All helper/functional/smoke checks use Bun's named-test runner; smoke bundles target Node.

### Tests
- Artifact opt-out, cwd artifacts, fixtures/scoring, provider usage extraction, aggregate metrics.

## [0.1.0] - 2026-08-22

### Changed
- Standardized all extension READMEs (commands/flags, features, configuration, architecture).
- Centralized active-mode appearance in `opl-modes.json` (incl. `off`/`execute`); `opl-input` resolves Bash > mode appearance > fallback; `opl-footer` reads `appearance.modeColor` (fallback `muted`).
- `opl-init`: workspace-aware crawling, foreign-rule ingestion, bounded traversal, truncation reporting.
- `opl-modes`: `allowExecute`, functional custom `allowPlanComplete`, merged review mode, write-limited research mode.
- `opl-footer`: latest settled prompt-to-completion turnaround beside cumulative LLM time.

### Tests
- Expanded coverage for `/init` crawling, input style, modes, footer, todo config, webaccess.

## [0.0.3] - 2026-08-22

### Changed
- `opl-init`: workspace-aware crawling and foreign agent-rule ingestion.
- `opl-input`: fixed custom-mode color resolution; extracted testable styling helpers.
- `opl-footer`: last settled prompt-to-completion turnaround time.
- `opl-modes`: `allowExecute`, functional custom `allowPlanComplete`, review + research modes, restrictive-mode tool docs.

### Tests
- Fixture coverage for init crawling, input styling, mode helpers, footer helpers, todo config, webaccess.

## [0.0.2] - 2026-08-21

### Changed
- `opl-footer`: session/performance statistics rows.
- `opl-modes`: unified mode-manager docs (commands, flags, custom modes, model overrides).
