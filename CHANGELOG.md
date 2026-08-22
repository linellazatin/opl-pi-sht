# Changelog

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
