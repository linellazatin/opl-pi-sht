# opl-pi-sht Repository Guide

## What this is

A private Pi coding-agent extension kit packaged as a Git-installable Pi package. Extension directories and config files use the `opl-` prefix; established Pi-facing commands and tool names remain compatible, including `/init`, `/chat`, `/plan`, `/execute`, `/todos`, `todo`, and `questionnaire`.

## Commands

- `npm test` runs all ten extension suites.
- `npm run test:opl-<name>` runs one suite: `browser`, `ctxtrim`, `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, `webaccess`, or `simplebench`.
- Tests use Bun. Focused suites test helpers where applicable, then bundle the chosen extension through `tests/extension-smoke.test.mjs` with `OPL_EXTENSION`.
- `./install.sh` copies all extensions and tracked `.json` configs into `~/.pi/agent`; `./install.sh --link` creates non-destructive symlinks. `--only` selects extensions; choosing `opl-footer`, `opl-input`, or `opl-modes` installs the complete UI bundle.
- Set `PI_AGENT_DIR` to install outside `$HOME/.pi/agent`.

There are no build, lint, or typecheck scripts.

## Architecture

Each `extensions/opl-*/index.ts` is independently loadable through the root `pi.extensions` glob. `opl-modes` is the only owner of active-tool selection and published mode appearance; `opl-input` and `opl-footer` consume that state. Preserve compatibility identifiers such as `mode-switcher`, `chat-mode`, and `plan-mode`.

`opl-browser` is a single lazy Playwright dispatcher. `opl-webaccess` supplies provider-backed search and readable URL/PDF extraction. `opl-ctxtrim` only trims known context-mode schema descriptions, preserves all schema fields, and fails open for unknown payloads. `opl-init` generates fingerprinted `AGENTS.md` files. `opl-simplebench` contains provider runners, scoring, artifacts, direct llama-server metadata, llamagputop stats, coding tasks, and a benchmark-local research-artifact workflow.

## Configuration and installation

`configs/` holds working configs plus samples. All configuration is standard JSON: no comments or trailing commas except intentional `_comment` properties. Keep credentials out of tracked files.

`opl-modes.json` owns active-mode appearance and the shared read-only Bash policy. Its top-level `bashPatterns` applies to chat and plan unless a mode deliberately diverges.

Copy `configs/opl-simplebench.json.sample` to `~/.pi/agent/configs/opl-simplebench.json` for optional live adapters. Its camelCase fields include `researchSearchProvider` (`ddgs` or `searxng`), `researchSearchUrl`, `researchMaxResults`, `llamaServerUrl`, and `llamagputopUrl`. `--test-all` includes the benchmark-local research artifact; `--llama-server` and `--llamagputop` are boolean opt-ins using configured URLs. Simplebench retains legacy timeout compatibility with `simplebench-config.json`.

`opl-webaccess` and `opl-browser` have nested runtime dependencies for checkout installs; install them in their extension directories. Browser additionally needs `npx playwright install chromium`.

## Testing and operational quirks

Smoke tests do not exercise live TUI behavior, provider credentials, network providers, extraction, or real model interactions. `opl-webaccess` has no standalone implemented test command; use the root suite.

Copy installation overwrites matching destinations; link mode skips existing files and directories. Footer timing is session-ephemeral. Mode and todo state reconstruct from session history or branches. Simplebench writes ordinary suites as JSON; `--test-all` writes a result bundle containing `result.json`, `research.md`, and `page.html`.

## Key files

- `install.sh`: installer and UI-bundle selection.
- `tests/extension-smoke.test.mjs`: shared entrypoint smoke runner.
- `configs/`: portable config examples and samples.
- `extensions/opl-modes/`: mode registry, policy, plan lifecycle, and shared state.
- `extensions/opl-simplebench/`: benchmark orchestration, artifact output, research, llama metadata, and scoring.
- `extensions/opl-browser/`, `extensions/opl-webaccess/`: external runtime integrations.
- `extensions/opl-footer/segments/`: one module per footer cell.
- `research/`: measured design assessments; use as background, not as a runtime dependency.
<!-- opl-init:fp 8632a0f1b14dd140 -->