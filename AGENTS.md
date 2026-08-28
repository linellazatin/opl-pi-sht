# opl-pi-sht Repository Guide

## What this is

A portable collection of Pi coding-agent extensions and standard-JSON configuration examples. Repository directories and configuration files use the `opl-` prefix, while established Pi-facing commands and tool names remain compatible: `/init`, `/chat`, `/plan`, `/mode`, `/execute`, `/todos`, `todo`, and `questionnaire`.

## Commands

- `npm test` runs all ten extension suites.
- `npm run test:opl-<name>` runs one suite: `browser`, `ctxtrim`, `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, `webaccess`, or `simplebench`.
- Tests use Bun's test runner. Each suite runs its focused functional test where available, then bundles the selected entrypoint through `tests/extension-smoke.test.mjs` using `OPL_EXTENSION`.
- `./install.sh` copies all extensions and configs to `~/.pi/agent`; `./install.sh --link` creates non-destructive symlinks.
- `./install.sh --only`/`-o` selects extensions. Selecting `opl-footer`, `opl-input`, or `opl-modes` installs the complete UI bundle.
- Set `PI_AGENT_DIR` to install outside `$HOME/.pi/agent`.

There are no build, lint, or typecheck scripts.

## Architecture

Each `extensions/opl-*/` directory is independently loadable and documents its own interface. `opl-modes` owns built-in/custom mode definitions, plan lifecycle, tool/Bash restrictions, lazy tool loading (`lazyTools` + the `load_tools` tool), persisted mode state, and active-mode appearance. `opl-input` and `opl-footer` consume that published appearance state. Preserve compatibility identifiers such as `mode-switcher`, `chat-mode`, and `plan-mode`, because existing sessions depend on them.

`opl-init` generates fingerprinted repository `AGENTS.md` guides. `opl-simplebench` provides standalone model benchmarking, metrics, scoring, reports, and artifacts. `opl-webaccess` provides provider-backed search, readable URL/PDF extraction, and session-stored result retrieval. `opl-browser` drives Chromium via Playwright through a single action-based `browser` tool (navigate, snapshot, interact, console/network capture, evaluate, screenshot), returning handle+preview for large output; it replaces the chrome-devtools MCP server. `opl-todo` stores branch-aware tasks in session tool results. `opl-questionnaire` provides an interactive model-invoked choice UI. `opl-ctxtrim` trims only known context-mode `ctx_*` schema descriptions in outbound provider payloads; it must preserve every schema field and fail open for unknown payloads or tools.

## Configuration and installation

`configs/` holds tracked working configs (`opl-footer`, `opl-input`, `opl-modes`, `opl-todo`, `opl-webaccess`) plus six `.sample` files (`opl-browser`, `opl-footer`, `opl-input`, `opl-modes`, `opl-todo`, `opl-webaccess`); install selected files as `~/.pi/agent/configs/opl-*.json`. Configuration is standard JSON: do not add comments or trailing commas except intentional `_comment` properties. `opl-init`, `opl-questionnaire`, and `opl-ctxtrim` have no config file at all. `opl-simplebench` is not configured through `configs/`: it maintains its own `simplebench-config.json`, `tool_support.json`, and `simplebench-history.json` under dedicated state directories (see `extensions/opl-simplebench/util/config.ts`).

`opl-modes.json` is the canonical owner of active-mode appearance. Its per-mode `appearance` values style `opl-input` and the unified footer mode label. Its top-level `bashPatterns` is the shared read-only Bash policy for chat and plan; use nested per-mode patterns only for deliberate divergence.

Keep provider credentials out of tracked files. `opl-webaccess` reads keys from configured environment-variable names and requires local dependencies:

```bash
cd extensions/opl-webaccess
npm install
```

`opl-browser` requires Playwright and a Chromium binary:

```bash
cd extensions/opl-browser
npm install
npx playwright install chromium
```

## Testing and operational quirks

Smoke tests do not exercise live TUI behavior, network providers, credentials, HTML/PDF extraction, or model interactions. `extensions/opl-webaccess/package.json` has no implemented standalone test command; use the root suite.

Copy installation overwrites matching destinations. Link installation skips existing files and directories. Footer timing is session-ephemeral; mode state and todo state are reconstructed from session history or branches.

## Key files

- `install.sh`: copy/link installer and UI-bundle selection.
- `tests/extension-smoke.test.mjs`: shared static smoke runner.
- `configs/`: portable external configuration examples.
- `extensions/opl-init/index.ts`: crawl, fingerprint, and `/init` behavior.
- `extensions/opl-modes/`: mode registry, policy, plan lifecycle, and shared state.
- `extensions/opl-simplebench/`: benchmark orchestration, providers, metrics, scoring, reporting, and artifacts.
- `extensions/opl-footer/`: multi-row footer and session/performance metrics.
- `extensions/opl-webaccess/`: providers, extraction, PDF handling, and stored results.
- `extensions/opl-ctxtrim/index.ts`: outbound context-mode tool-schema description trimming.
- `extensions/opl-footer/segments/`: one module per footer cell (`cost`, `context`, `tokens`, `git`, `caveman`, ...) plus `theme.ts`, `icons.ts`, and `git-status.ts`.
- `research/`: measured token/caching economics and design assessments (`token-and-caching-economics.md`, `context-mode-assessment.md`, crawl-depth and harness-init studies) that justify the bounded-output and lazy-tool defaults.
- `images/`: README screenshots (`ss-*.png`); regenerate rather than hand-editing.
<!-- opl-init:fp 095120af08b6cc8d -->
