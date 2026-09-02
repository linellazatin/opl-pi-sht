# opl-pi-sht Repository Guide

## What this is

A Pi coding-agent extension kit packaged as an npm- and Git-installable Pi package (`@openlines/opl-pi-sht` on npm, `v*` tags on GitHub). Extension directories and configuration files use the `opl-` prefix. Preserve established Pi-facing commands and compatibility names, including `/init`, `/chat`, `/plan`, `/execute`, `/todos`, `todo`, and `questionnaire`.

## Commands

- `npm test` runs all ten extension suites: `browser`, `ctxtrim`, `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, `webaccess`, and `simplebench`.
- `npm run test:opl-<name>` runs one extension suite.
- `./install.sh` copies extensions and tracked JSON configs to `~/.pi/agent`; `./install.sh --link` creates non-destructive symlinks. `--only` selects extensions; `opl-footer`, `opl-input`, and `opl-modes` select the complete UI bundle.
- Set `PI_AGENT_DIR=<path>` to install outside `$HOME/.pi/agent`.

Tests use Bun. There are no build, lint, or typecheck scripts.

## Architecture

Each `extensions/opl-*/index.ts` is independently loadable through the root Pi extension glob. `opl-modes` is the sole owner of active-tool selection and published mode appearance; `opl-input` and `opl-footer` consume that state. Preserve compatibility identifiers such as `mode-switcher`, `chat-mode`, and `plan-mode`.

`opl-browser` provides one lazy Playwright browser dispatcher. `opl-webaccess` provides provider-backed search and readable URL/PDF extraction. `opl-ctxtrim` trims only known context-mode `ctx_*` schema descriptions, preserves all schema fields, and fails open for unknown payloads. `opl-init` writes a deterministic fingerprinted `AGENTS.md` baseline before dispatching the model to refine it, so a chat-only response cannot leave the guide unwritten; `AGENTS.md` itself is excluded from the fingerprint. `opl-simplebench` provides provider-aware benchmarking, coding-lite tasks, deterministic grounded research (`--test-all`) plus optional live-search smoke test (`--research-live`), metrics, scoring, direct llama-server metadata, llamagputop stats, and tagged artifacts. `opl-todo` stores branch-aware tasks; `opl-questionnaire` provides interactive choices.

## Configuration and installation

`configs/` contains working configs and `.sample` files. Configuration is standard JSON: do not add comments or trailing commas except intentional `_comment` properties. Keep credentials out of tracked files.

`opl-modes.json` owns active-mode appearance and the shared read-only Bash policy. `opl-simplebench.json` uses camelCase fields for research and llama endpoints; `--llama-server` and `--llamagputop` are boolean opt-ins using configured URLs. `/simplebench --tag=<word>` stores the label under `benchmark.tag` and prefixes artifact names; tags are restricted to one word.

Pi installs via `pi install npm:@openlines/opl-pi-sht@<version>` or `pi install git:github.com/linellazatin/opl-pi-sht@v<version>`; pick one source per machine because Pi loads both entries as separate, duplicate extensions. Per-extension selection post-install uses the settings `packages` object-form `extensions` filter or `pi config` (there is no `pi install --only`).

`opl-browser` and `opl-webaccess` have nested runtime dependencies. Install dependencies in their extension directories; browser additionally needs `npx playwright install chromium`.

## Testing and operational quirks

Smoke tests do not exercise live TUI behavior, provider credentials, network providers, extraction, or real model interactions. `opl-webaccess` has no standalone implemented test command; use the root suite.

Copy installation overwrites matching destinations; link installation skips existing files and directories. Footer timing is session-ephemeral. Mode and todo state reconstruct from session history or branches. Simplebench `--test-all` writes a bundle containing `result.json`, `research.md`, and `page.html`; raw provider management responses and credentials must not be stored.

## Key files

- `install.sh` — installer and UI-bundle selection.
- `tests/extension-smoke.test.mjs` — shared extension smoke runner.
- `configs/` — portable configuration examples.
- `extensions/opl-init/index.ts` — repository crawl, fingerprint, and `/init` behavior.
- `extensions/opl-modes/` — mode registry, policy, lifecycle, and shared state.
- `extensions/opl-simplebench/` — benchmark orchestration, artifacts, research, metrics, and scoring.
- `extensions/opl-browser/` and `extensions/opl-webaccess/` — external runtime integrations.
- `extensions/opl-footer/segments/` — individual footer cells.
- `.github/workflows/release.yml` — tag-triggered GitHub Release plus npm Trusted Publishing (OIDC); npm versions are immutable, so every publish requires a `package.json` version bump.
<!-- opl-init:fp ec605aa217aebfd9 -->
