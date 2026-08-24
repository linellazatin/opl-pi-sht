# opl-pi-sht

A portable collection of nine Pi coding-agent extensions and five standard-JSON configuration examples. Repository directories and config files use `opl-`; established Pi-facing commands and tool names stay compatible.

## Installation

```bash
chmod +x install.sh
./install.sh                         # copy all extensions and configs
./install.sh --link                  # non-destructive symlinks
./install.sh --only opl-init opl-todo
./install.sh --link --only opl-input # installs the complete UI bundle
PI_AGENT_DIR=/path/to/.pi/agent ./install.sh --link
```

Copy mode overwrites matching destinations. Link mode skips existing destinations. `--only`/`-o` accepts one or more extension names; selecting `opl-footer`, `opl-input`, or `opl-modes` installs all three because they share active-mode state. Use `./install.sh --help` for flags. The repository uses standard `.json` only.

## Extensions

| Extension | Summary | Commands, tools, and configuration |
|---|---|---|
| [`opl-init`](extensions/opl-init/README.md) | Fingerprinted repository-guide generator. | `/init`; no config. |
| [`opl-simplebench`](extensions/opl-simplebench/README.md) | Auditable provider-aware model benchmark with JSON artifacts and metrics. | `/simplebench`, `simplebench`; supports Ollama, OpenAI-compatible providers, and Bedrock; no dedicated config. |
| [`opl-webaccess`](extensions/opl-webaccess/README.md) | Search plus readable URL/PDF retrieval with session recovery. | `web_search`, `fetch_content`, `get_search_content`; `opl-webaccess.json`. |
| [`opl-ctxtrim`](extensions/opl-ctxtrim/README.md) | Trims verbose context-mode `ctx_*` tool-schema descriptions on outbound provider requests (~67% smaller schema, ~4,700-6,300 tokens/request). | No commands/tools; no config. |
| [`opl-todo`](extensions/opl-todo/README.md) | Branch-aware task tool, overlay, and task list. | `todo`, `/todos`; `opl-todo.json`. |
| [`opl-questionnaire`](extensions/opl-questionnaire/README.md) | Interactive structured-choice tool. | `questionnaire`; no config. |
| [`opl-input`](extensions/opl-input/README.md) | Configurable replacement editor. | No commands/tools; `opl-input.json`. |
| [`opl-modes`](extensions/opl-modes/README.md) | Mode, plan, tool-safety, and active-appearance manager. | `/mode`, `/chat`, `/plan`, `/execute`, `plan_complete`; `opl-modes.json`. |
| [`opl-footer`](extensions/opl-footer/README.md) | Configurable multi-row status footer. | No commands/tools; `opl-footer.json`. |

## Configuration

Copy applicable files from [`configs/`](configs/) to `~/.pi/agent/configs/`:

- `opl-footer.json`, `opl-input.json`, `opl-modes.json`, `opl-todo.json`, `opl-webaccess.json`
- `opl-init` and `opl-questionnaire` have no external configuration.
- Config files must be valid JSON, with no comments or trailing commas beyond deliberate `_comment` keys.
- `opl-modes` owns active-mode appearance. Each mode's `appearance.prefix`, `prefixColor`, and `borderColor` style `opl-input`; `appearance.modeColor` styles `opl-footer`'s unified mode label. Renderers retain hardcoded fallbacks.
- `opl-modes.bashPatterns` is the shared read-only Bash policy for chat and plan. Use per-mode pattern fields only when those modes intentionally need different policies.

See each extension README for commands, behavior, configuration fields, runtime constraints, and architecture.

## Runtime requirements

All extensions use Pi's normal extension discovery. `opl-webaccess` requires its local dependencies before HTML or PDF extraction:

```bash
cd extensions/opl-webaccess
npm install
```

`opl-simplebench` writes a full JSON benchmark artifact in Pi's current working directory by default. Use `/simplebench --no-artifact` or `simplebench({ no_artifact: true })` when responses must not be written to disk. Provider credentials remain outside tracked configuration; configure them through Pi provider settings, environment variables, or Pi authentication.

## Tests

```bash
npm test
```

Run one extension suite with `npm run test:opl-<name>` for `footer`, `init`, `input`, `modes`, `questionnaire`, `todo`, `webaccess`, `simplebench`, or `ctxtrim`. Every helper, functional, and selected-entrypoint smoke check uses Bun's named-test reporter; output includes per-test status, timings, and pass/fail totals. Functional tests cover deterministic helpers where practical; smoke tests bundle entrypoints and parse config. They do not test live TUI behavior, provider credentials, network access, or PDF extraction.
