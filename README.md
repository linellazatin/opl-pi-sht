# opl-pi-sht

## openlines "pi should have that" collection
A tracked collection of customized Pi coding-agent extensions and their portable configuration examples. Extensions keep their Pi-facing command and tool names; the `opl-` prefix identifies the repository-branded directories and configuration filenames.

## Extensions

| Extension | Description |
|---|---|
| [`opl-init`](extensions/opl-init/README.md) | `/init` repository crawler that creates or updates fingerprinted `AGENTS.md` contributor guides and incorporates existing Cursor, Copilot, Claude, Windsurf, Cline, and Devin rule sources. |
| [`opl-webaccess`](extensions/opl-webaccess/README.md) | Multi-provider web search, URL extraction, PDF extraction, and stored-result retrieval tools. |
| [`opl-todo`](extensions/opl-todo/README.md) | Session-branch-aware `todo` tool, overlay widget, shortcuts, and `/todos` command. |
| [`opl-questionnaire`](extensions/opl-questionnaire/README.md) | Model-invoked TUI questionnaire for selectable single or multi-question clarification. |
| [`opl-input`](extensions/opl-input/README.md)* | Configurable chat editor with boxed/unboxed rendering, mode-aware colors, and optional animated companion. |
| [`opl-modes`](extensions/opl-modes/README.md)* | Unified chat, plan, execute, and custom mode manager with tool/Bash restrictions and plan files. |
| [`opl-footer`](extensions/opl-footer/README.md)* | Multi-row status footer with model, path, Git, context, token, cost, and session statistics. |

`* required bundled`

## Installation

Make the installer executable once, then choose copy or symlink mode:

```bash
chmod +x install.sh

# Copy all extensions and JSON configs into ~/.pi/agent.
./install.sh

# Install only opl-init and opl-todo.
./install.sh --only opl-init opl-todo

# Selecting any bundle member installs opl-footer, opl-input, and opl-modes.
./install.sh --only opl-input

# Link repository extensions and JSON configs into ~/.pi/agent.
./install.sh --link

# Combine selection with link mode.
./install.sh --link --only opl-webaccess

# Show usage.
./install.sh --help
```

The default copy mode installs all seven extensions and their five matching JSON configs, overwriting matching destinations. `--link` creates non-destructive symlinks and skips destinations that already exist. Use `--only` (or `-o`) followed by one or more extension names to select a subset. `opl-footer`, `opl-input`, and `opl-modes` are a required UI bundle: selecting any one of them installs all three. Both modes install repository extensions under `~/.pi/agent/extensions/` and configs under `~/.pi/agent/configs/`.

Set `PI_AGENT_DIR` to install into a different Pi agent directory:

```bash
PI_AGENT_DIR=/path/to/.pi/agent ./install.sh --link
```

The installer handles both `.json` and `.jsonc` config filenames, although the repository currently uses `.json`.

## Configurations

Tracked example configurations live in [`configs/`](configs/):

- [`opl-input.json`](configs/opl-input.json)
- [`opl-footer.json`](configs/opl-footer.json)
- [`opl-modes.json`](configs/opl-modes.json)
- [`opl-todo.json`](configs/opl-todo.json)
- [`opl-webaccess.json`](configs/opl-webaccess.json)

Copy the applicable files to `~/.pi/agent/configs/`. `opl-questionnaire` and `opl-init` have no external configuration files.

## Runtime audit

All seven extensions load through Pi's normal extension discovery pattern and have valid internal relative imports. The registrations and lifecycle behavior are:

| Extension | Commands | Tools | Lifecycle/event handlers | External config |
|---|---|---|---|---|
| `opl-footer` | None | None | `session_start`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `message_update`, `tool_result`, `user_bash` | `opl-footer.json` |
| `opl-init` | `/init` | None | None | None |
| `opl-input` | None | None | `session_start` | `opl-input.json` |
| `opl-modes` | `/mode`, `/chat`, `/plan`, `/execute` | `plan_complete` | `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_end`, `session_tree` | `opl-modes.json` |
| `opl-questionnaire` | None | `questionnaire` | None | None |
| `opl-todo` | `/todos` | `todo` | `session_start`, `session_tree` | `opl-todo.json` |
| `opl-webaccess` | None | `web_search`, `fetch_content`, `get_search_content` | `session_start` | `opl-webaccess.json` |

### Call-path notes

- `opl-input` and `opl-footer` are UI-only at model level. They do not add model-callable tools.
- `opl-modes` changes active tools and injects chat, plan, refine, or execute instructions through `before_agent_start`. Its Bash safety handler can block commands in read-only modes.
- `opl-questionnaire` is model-invoked and returns structured answers; it requires interactive TUI mode and returns an explicit error in headless mode.
- `opl-todo` is model-invoked, stores state in session tool results, and reconstructs state on branch changes.
- `opl-webaccess` performs network calls, stores bounded result data, and returns a response ID for retrieval when output is truncated. Its runtime dependencies must be installed separately; see [its README](extensions/opl-webaccess/README.md).
- `opl-init` runs the deterministic crawl only when `/init` is called, and skips the model turn when the `AGENTS.md` fingerprint is current.

## Projected token overhead

These are rough planning estimates, not instrumented measurements. They include likely registration/schema/prompt metadata, not arbitrary runtime tool results:

| Extension | Estimated overhead | Main source |
|---|---:|---|
| `opl-footer` | ~350 tokens | Registration and loaded UI metadata; no tool output |
| `opl-input` | ~150 tokens | Loaded UI/editor metadata; no tool output |
| `opl-modes` | ~1,450 tokens | Mode prompts, Bash patterns, tool registration, and mode metadata |
| `opl-questionnaire` | ~600 tokens | Tool schema, prompt snippet, and prompt guidelines |
| `opl-todo` | ~600 tokens | Tool schema, tool description, and render metadata |
| `opl-webaccess` | ~950 tokens | Three tool schemas and descriptions; results are additional |
| `opl-init` | ~750 tokens when invoked | Generation prompt plus repository crawl context; no cost when current |

A rough all-loaded estimate is **~4,800–5,000 tokens** before large tool results. This is a projection from source size and registration strings, not a provider tokenizer measurement. UI-only extensions mostly affect startup/runtime metadata, while mode prompts, questionnaire guidance, web results, and `/init` crawl context can affect per-turn context substantially. Web pages, PDFs, search answers, and todo/questionnaire answers are variable and can dominate the estimate.

## JSON configurations

The five external configuration files use standard JSON and are loaded directly with the JavaScript runtime's `JSON.parse`:

- `opl-input.json`
- `opl-footer.json`
- `opl-modes.json`
- `opl-todo.json`
- `opl-webaccess.json`

They intentionally do not support comments or trailing commas. `opl-questionnaire` and `opl-init` have no external configuration files.

## Tests

Run every extension bundle and configuration smoke test:

```bash
npm test
```

Run one extension manually:

```bash
npm run test:opl-footer
npm run test:opl-init
npm run test:opl-input
npm run test:opl-modes
npm run test:opl-questionnaire
npm run test:opl-todo
npm run test:opl-webaccess
```

Each extension test parses its JSON configuration when present and bundles its entrypoint with Pi runtime and optional web packages externalized. These are static smoke tests, not live TUI, network, provider-credential, or PDF behavior tests.

## Verification

The smoke tests use Bun for bundling. `opl-webaccess` also requires its local runtime dependencies before using its web and PDF tools:

```bash
cd extensions/opl-webaccess
npm install
```

Then run the repository tests from the project root. The web-access dependency and provider configuration details are documented in [its README](extensions/opl-webaccess/README.md).
