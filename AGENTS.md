# opl-pi-sht Repository Guide

## What this is

A portable collection of customized Pi coding-agent extensions and configuration examples. Repository directories and external config filenames use the `opl-` prefix, while established Pi-facing commands and tool names remain stable: `/init`, `/chat`, `/plan`, `/mode`, `/execute`, `/todos`, `todo`, and `questionnaire`.

## Commands

- `npm test` runs all seven extension smoke tests.
- `npm run test:opl-<name>` runs one smoke test. Names are `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, and `webaccess`.
- `./install.sh` copies all extensions and configs to `~/.pi/agent`.
- `./install.sh --link` creates non-destructive symlinks instead; `--only`/`-o` selects one or more extensions. Selecting any of `opl-footer`, `opl-input`, or `opl-modes` installs the complete UI bundle.
- Set `PI_AGENT_DIR` to install somewhere other than `$HOME/.pi/agent`.

There are no build, lint, or typecheck scripts. The smoke tests require Bun's bundler through `tests/extension-smoke.mjs`.

## Architecture

Each `extensions/opl-*/` directory is an independently loadable Pi extension with a README. `opl-modes` owns normal, chat, plan, execute, and custom modes, including read-only tool and Bash restrictions, plan files, and persisted mode state. `opl-input` and `opl-footer` consume its shared mode state. Preserve compatibility identifiers such as `mode-switcher`, `chat-mode`, and `plan-mode`; existing sessions depend on them.

`opl-init` exposes `/init`, crawls the target repository, and generates or updates a repository-specific `AGENTS.md` using a fingerprint marker. `opl-webaccess` provides multi-provider search, readable URL/PDF extraction, and session-stored result retrieval. `opl-todo` stores branch-aware todos in session tool results. `opl-questionnaire` provides an interactive model-invoked questionnaire.

## Configuration and installation

Tracked standard JSON examples and `.sample` files live in `configs/`. Install applicable files as `~/.pi/agent/configs/opl-*.json`. `opl-init` and `opl-questionnaire` have no external configuration. Do not add comments or trailing commas to JSON. Keep provider credentials out of tracked files; `opl-webaccess` reads API keys from configured environment-variable names.

Before using web access, install its local dependencies:

```bash
cd extensions/opl-webaccess
npm install
```

## Testing and operational quirks

Smoke tests bundle entrypoints and parse available JSON; they do not exercise live Pi TUI behavior, network providers, credentials, HTML/PDF extraction, or model interactions. The `opl-webaccess` package has no implemented test script.

Copy installation overwrites matching destinations. Link installation skips existing files and directories. The footer, input, and modes extensions must be installed together when selecting a subset. Footer timing statistics are session-ephemeral, while mode and todo state are reconstructed from session history or branches.

## Key files

- `install.sh`: copy/link installer and extension-bundle selection.
- `tests/extension-smoke.mjs`: shared static smoke-test runner.
- `configs/`: portable external configuration examples.
- `extensions/opl-init/index.ts`: crawl, fingerprint, and `/init` generation behavior.
- `extensions/opl-modes/`: mode registry, safety rules, plan lifecycle, and state persistence.
- `extensions/opl-footer/`: multi-row footer, session statistics, and performance display.
- `extensions/opl-webaccess/`: providers, extraction, PDF handling, and stored results.
<!-- opl-init:fp d20bcd8c5cde5007 -->