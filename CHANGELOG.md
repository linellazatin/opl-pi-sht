# Changelog

## [0.1.5] - 2026-08-24

### Added
- `opl-ctxtrim`: new extension that trims verbose context-mode `ctx_*` tool-schema descriptions on outbound provider requests via the `before_provider_request` hook, without modifying the third-party context-mode package. Supports OpenAI Responses, OpenAI Chat Completions, and Bedrock Converse payload shapes; preserves tool names, schema structure, required fields, enums, defaults, bounds, and strict flags; fails open for unknown formats and uncovered `ctx_*` tools.
- `opl-ctxtrim`: documented measured savings against context-mode v1.0.169 (11 tools, 28,019 -> 9,152 serialized bytes, 67.3% reduction, ~4,700-6,300 estimated tokens saved per provider request).

### Changed
- Root `README.md`, `install.sh`, and `package.json` now include `opl-ctxtrim` (nine extensions total).

### Tests
- Added `tests/opl-ctxtrim.test.ts` covering all supported provider shapes, non-`ctx_*` preservation, unknown-format and unknown-tool fail-open behavior, input immutability, retained purge warnings, unchanged validation keywords, single-handler registration, and an integration measurement against the installed context-mode server.

## [0.1.4] - 2026-08-23

### Added
- `opl-simplebench`: added six execution-backed coding-lite tasks in disposable directories, with restricted file/search/edit/test tools, hidden verification, coding metrics, and separate coding results in artifacts.
- `opl-simplebench`: added `--coding-lite`, `--test-all`, and matching LLM-callable options; `--test-all` runs the baseline suite plus coding-lite and composes with `--all`.

### Changed
- `opl-simplebench`: Ollama chat handling now forwards native tool definitions and captures streamed tool calls for coding-lite runs.
- `opl-simplebench`: coding-lite file inspection now returns recoverable tool errors for missing paths instead of aborting the task.
- `opl-simplebench`: coding-lite task records now live in artifact `tests[]`; recommendations include coding-lite as a fourth capability category.

### Tests
- Added fixture isolation, path traversal, public/hidden verification, and coding-mode argument coverage.

## [0.1.3] - 2026-08-23

### Changed
- `opl-simplebench`: default runs now leave sampling and reasoning to the provider/model; `--thinking-max` requests explicit maximum reasoning for OpenAI-compatible providers and direct Bedrock models that advertise max thinking in Pi metadata.
- `opl-simplebench`: direct Bedrock max-thinking runs delegate model-family request construction to Pi's Bedrock adapter, instead of duplicating adaptive and budget-based Claude reasoning rules.
- `opl-simplebench`: artifacts now record requested/effective thinking mode, logical level, and whether model metadata came from the active context or scoped registry.

### Tests
- Added metadata-gated Bedrock max-thinking resolution coverage and retained provider-default/OpenAI-compatible mode checks.

## [0.1.2] - 2026-08-23

### Hotfix
- `opl-simplebench`: restored instruction-following report rendering by replacing the undefined `reportInstructionScore` call with the tested `formatInstructionScore` formatter.

## [0.1.1] - 2026-08-23

### Added
- `opl-simplebench`: added model benchmark, evaluates fixed reasoning, JSON instruction-following, and tool-call generation cases across different providers

### Changed
- All extension helper, functional, and smoke checks now use Bun's named-test
- Smoke bundles run with Bun's Node target

### Tests
- Added `opl-simplebench` coverage for artifact opt-out, cwd artifacts, benchmark fixtures/scoring, provider usage extraction, and aggregate metric behavior.

## [0.1.0] - 2026-08-22

### Changed
- Standardized all extension READMEs around commands/flags/shortcuts, features, configuration, and architecture.
- Centralized every active-mode visual setting in `opl-modes.json`; added complete tracked appearances for `off` and `execute`.
- `opl-input`: resolves Bash > published mode appearance > hardcoded fallback; removed legacy mode appearance settings.
- `opl-init`: workspace-aware crawling, foreign-rule ingestion, bounded directory/member traversal, and explicit truncation reporting.
- `opl-modes`: execute-handoff control with `allowExecute`, functional custom `allowPlanComplete`, merged review mode, and write-limited research mode.
- `opl-footer`: reads `appearance.modeColor` with a hardcoded `muted` fallback; removed `colors.modeIndicator`.
- `opl-footer`: shows latest settled user-prompt-to-completion turnaround beside cumulative LLM time.

### Tests
- Expanded functional tests for `/init` crawling, input style resolution, modes, footer helpers, todo config loading, and webaccess helpers; all suites remain wired into `npm test`.

## [0.0.3] - 2026-08-22

### Changed
- `opl-init`: workspace-aware crawling and foreign agent-rule ingestion.
- `opl-input`: fixed custom-mode color resolution and extracted testable styling helpers.
- `opl-footer`: added last settled user-prompt-to-completion turnaround time.
- `opl-modes`: added `allowExecute`, functional custom `allowPlanComplete`, review mode, research mode, and explicit restrictive-mode tool documentation.

### Tests
- Added functional fixture coverage for init crawling, input styling, mode helpers, footer helpers, todo config loading, and webaccess utilities.

## [0.0.2] - 2026-08-21

### Changed
- `opl-footer`: session/performance statistics rows.
- `opl-modes`: unified mode-manager documentation aligned to commands, flags, custom modes, and model overrides.
