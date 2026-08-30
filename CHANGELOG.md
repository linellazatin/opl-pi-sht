# Changelog

## [0.1.9] - 2026-08-30

### Added
- `configs/opl-simplebench.json.sample`: camelCase `researchSearchProvider` (`ddgs` or `searxng`), `researchSearchUrl`, `researchMaxResults`, `llamaServerUrl`, and `llamagputopUrl`. `--llama-server` and `--llamagputop` are boolean opt-ins using those configured URLs; `--test-all` includes the benchmark-local research-artifact task and writes a `result.json`/`research.md`/`page.html` bundle.
- `opl-simplebench --llama-server` (tool `llama_server`): writes `summary.serverStats` from configured direct llama-server `/props` + `/metrics` without changing LiteLLM inference. `modelConfig` = ctx, slots, temp, top-k/p, min-p, repeat, spec-type (null for build-only fields: ngl, flash-attn, threads, batch, kv-k/v, n-max, draft-kv); `modelStats` = prefill/gen/session-avg tok/s and speculative acceptance from the before/after `/metrics` delta.
- `opl-simplebench --llamagputop` (tool `llamagputop`): treats configured `/stats` as authoritative, fills `serverStats` config/stats without matching Pi's selected model, and records the served ID as `modelConfig.model`; raw responses are excluded. On `/stats` failure, `/health` is checked for diagnostics only.

### Changed
- `/stats` is authoritative for llamagputop `model`, `spec-type`, and `reasoning`, replacing `/props` placeholder values such as `none`.
- llama-server capture is opt-in; inference endpoint and sampling unchanged. `/metrics` deltas are server-wide cumulative telemetry (not per-request); response usage stays authoritative. Probe errors go to `serverStats.errors` and never fail the run; `/props` and `/stats` are never stored raw.

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
