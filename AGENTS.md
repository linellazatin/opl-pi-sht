# opl-pi-sht Repository Guide

## What this is

A portable collection of customized Pi coding-agent extensions. Repository directories and external config filenames use the `opl-` prefix, while established Pi-facing commands and tool names remain stable, including `/init`, `/chat`, `/plan`, `/mode`, `/todos`, `todo`, and `questionnaire`.

## Commands

- `npm test` bundles and smoke-tests all seven extensions and parses each available JSON config.
- `npm run test:opl-<name>` runs one extension smoke test. Valid names are `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, and `webaccess` with the `opl-` prefix.
- `./install.sh` copies extensions and configs to `~/.pi/agent`; `./install.sh --link` creates non-destructive symlinks instead. Use `--only`/`-o` with one or more extension names to install a subset; selecting any of `opl-footer`, `opl-input`, or `opl-modes` installs that complete bundle. Set `PI_AGENT_DIR` to install elsewhere.

There are no build, lint, or typecheck scripts. The test suite relies on Bun's bundler being available.

## Architecture

Each `extensions/opl-*/` directory is an independently loadable Pi extension with its own README. `opl-modes` centralizes chat, plan, execute, and custom modes; `opl-input` and `opl-footer` consume its shared/global state. Preserve established `mode-switcher`, `chat-mode`, and `plan-mode` persisted/event identifiers unless an explicit migration is added, because old sessions rely on them.

`opl-init` crawls a target repository and uses a fingerprint marker to avoid rewriting a current `AGENTS.md`. Its public command stays `/init`.

`opl-webaccess` provides search, readable content extraction, PDF extraction, and session-stored result retrieval. It is the only extension with its own npm manifest and runtime dependencies.

## Configuration and installation

Tracked JSON configs and `.sample` copies live in `configs/`; install them as `~/.pi/agent/configs/opl-*.json`. `opl-init` and `opl-questionnaire` have no external config. Keep provider credentials out of tracked JSON: `opl-webaccess` reads API keys from environment variables named in its config, and ignored `.env` files are acceptable locally.

Before using `opl-webaccess`, install its declared packages:

```bash
cd extensions/opl-webaccess
npm install
```

## Testing and operational quirks

Smoke tests are static: they parse configuration and bundle entrypoints with Pi and web runtime packages externalized. They do not test live Pi TUI behavior, provider credentials, network access, or PDF extraction.

The installer copy mode overwrites matching destinations. Link mode skips existing destinations. `opl-footer`, `opl-input`, and `opl-modes` must be installed together when selecting a subset. The repository intentionally uses standard JSON; do not add comment or trailing-comma syntax to configs.

## Key files

- `install.sh`: copy/link installer.
- `tests/extension-smoke.mjs`: shared static test runner.
- `configs/`: portable external configuration examples.
- `extensions/opl-init/index.ts`: `/init` crawling and AGENTS fingerprint behavior.
- `extensions/opl-modes/`: unified mode manager and persisted state.
- `extensions/opl-webaccess/`: provider, extraction, PDF, and stored-result implementation.
<!-- opl-init:fp c50c56e2c67a8d79 -->
