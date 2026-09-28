# opl-guardian Consolidation Design Specification

## Goal

Expand `opl-guardian` from malformed assistant tool-call filtering into the package-owned home for four independent protections: malformed tool-call filtering, configurable dangerous-Bash confirmation (permission gate), configurable protected-path blocking, and confirmation for destructive session transitions. Users configure all four through `~/.pi/agent/configs/opl-guardian.json` and can disable the standalone equivalents without losing these behaviors.

## Approved intent and constraints

- Preserve guardian's current malformed-call filtering and forensic evidence behavior.
- Port the behavior of the user's existing `permission-gate` and `protected-paths` extensions and Pi's `confirm-destructive` example, adapting configuration into one file.
- Do not leave parallel copies enabled; the user has removed the standalone extensions from their Pi agent extensions directory.
- Block configured destructive session actions when no UI is available by default.
- Keep protections independently configurable and avoid adding tools, commands, prompt content, or third-party runtime dependencies.

## Configuration

The extension loads `~/.pi/agent/configs/opl-guardian.json` once at startup. The repository ships `configs/opl-guardian.json.sample` with defaults and placement instructions. Missing config uses built-in defaults. Parse errors or malformed individual sections produce a UI warning at session start and use safe defaults for the affected section rather than silently disabling protection.

Example shape:

```json
{
  "permissionGate": {
    "patterns": [
      "\\brm\\s+(-rf?|--recursive)",
      "\\bsudo\\b",
      "\\b(chmod|chown)\\s+(?:-[a-z]+\\s+)*777(?:\\b|$)",
      "\\bprintenv\\b",
      "(^|\\s)env(\\s|$)"
    ],
    "blockWithoutUI": true
  },
  "protectedPaths": {
    "paths": [
      { "path": ".env", "deny": ["read", "write", "edit", "bash"] },
      { "path": ".git/", "deny": ["read", "write", "edit"] },
      { "path": "node_modules/", "deny": ["write", "edit"] },
      { "path": "~/.pi/agent/auth.json", "deny": ["read", "write", "edit", "bash"] }
    ]
  },
  "confirmDestructive": {
    "clearSession": true,
    "switchWithUnsavedWork": true,
    "forkSession": true,
    "blockWithoutUI": true
  },
  "dropMalformedToolCalls": true
}
```

### Defaults and override semantics

- `permissionGate.patterns` defaults to the five patterns shown above. A provided array replaces defaults; an explicit empty array disables pattern matches. Invalid regex strings are reported; valid strings remain active. If none of the configured strings compile, use built-in defaults.
- `permissionGate.blockWithoutUI` defaults to `true`; when false, a dangerous command passes without UI.
- `protectedPaths.paths` defaults to the four entries shown above. A provided array replaces defaults; an explicit empty array disables path rules. Each entry requires a non-empty `path` and a `deny` array containing only `read`, `write`, `edit`, and/or `bash`. Invalid entries are reported and ignored; if the section is malformed, use built-in defaults.
- `confirmDestructive.clearSession`, `switchWithUnsavedWork`, and `forkSession` default to `true`. `confirmDestructive.blockWithoutUI` defaults to `true`; when false, the configured transition proceeds when no UI exists.
- `dropMalformedToolCalls` defaults to `true` to preserve current behavior; setting it to `false` disables only malformed-call filtering and its JSONL incidents.
- Missing individual properties use their defaults. Unknown keys are ignored.

## Behavior

### Permission gate

On `tool_call`, inspect Bash commands only. If any configured case-insensitive regular expression matches, prompt in interactive mode with a concise command preview and Yes/No selection. Only an affirmative choice allows execution; cancel or No blocks it. With no UI, block by default according to `permissionGate.blockWithoutUI`. Keep the existing `tool_call` cancellation reason actionable and identify `opl-guardian` as the source.

### Protected paths

On `tool_call`, check `read`, `write`, and `edit` path arguments against configured entries and block when the operation appears in that entry's `deny` list. Bare names match exact path segments for file tools; absolute and `~/` paths resolve and match the path or descendants on a directory boundary. For Bash, preserve the reference extension's literal-command matching behavior: bare names are searched as command substrings; absolute/home-relative entries are searched in their resolved and configured forms. Notify when a UI exists and return a block reason describing the protected entry and operation.

A protected-path match is a hard block and takes precedence over a permission-gate prompt for the same Bash call. The two checks are wired through one listener so ordering is deterministic.

### Destructive session actions

Use Pi's `session_before_switch` and `session_before_fork` hooks:

- When a new session would clear the current session, request confirmation if `clearSession` is enabled; cancel on rejection.
- When switching/resuming with unanswered user work, request confirmation if `switchWithUnsavedWork` is enabled. Detect pending work as a user message after the most recent assistant message, rather than treating any historical user message as unsaved.
- Request confirmation before forking if `forkSession` is enabled.
- With no UI, cancel the configured action by default. Honor `blockWithoutUI: false` as an explicit opt-out.

No confirmation is requested for an action whose corresponding flag is false.

### Malformed tool-call filtering

Preserve the current `message_end` behavior when `dropMalformedToolCalls` is enabled: remove tool calls with missing or whitespace-only IDs/names before persistence/replay, preserve valid content and valid calls, change invalid-only responses into text-only `stop` responses, and append a project-local JSONL incident under `err/guardian.jsonl`. Logging failure must not prevent sanitization. When the flag is false, leave assistant messages untouched and do not write incident records.

## Architecture and files

Keep one package extension entrypoint and separate configuration/policy responsibilities:

```text
extensions/opl-guardian/
├── index.ts       Pi event wiring for tool calls, session transitions, and message end
├── guardian.ts    Existing pure malformed-call helpers and incident record construction
├── config.ts      Config types, defaults, loading, validation, and warnings
├── policies.ts    Pure protected-path matching and pending-session-work helpers as warranted
└── README.md      User-facing behavior and configuration
configs/opl-guardian.json.sample
```

`index.ts` remains the Pi integration layer. Reuse the permission prompt's standard Pi TUI components where needed. No new runtime dependency is required. Do not import from or depend on the local standalone extensions at runtime.

## Tests

Extend `tests/opl-guardian.test.mjs` and retain the `OPL_EXTENSION=opl-guardian` smoke test. Cover:

1. Config defaults, overrides, explicit empty arrays, and invalid values/regex warnings.
2. Permission patterns allowing ordinary commands, prompting on matches, blocking rejection/cancel, and honoring both no-UI settings.
3. Protected file-tool matches for bare/absolute/home-relative paths and operation-specific deny lists; Bash matching; precedence over permission prompts.
4. Session clear, unsaved-work switch, and fork confirmations; cancellation; disabled flags; no-UI block/opt-out behavior.
5. Malformed-call behavior enabled by default, disabled mode, preservation of existing JSONL and log-failure guarantees.
6. Bundling the entrypoint and parsing the sample configuration.

Tests should use temporary paths and mocked Pi event/UI interfaces; do not write forensic data into the repository.

## Documentation and migration

Update `extensions/opl-guardian/README.md`, root `README.md`, and `configs/opl-guardian.json.sample` to describe the unified behaviors and config location. Add `opl-guardian` to root configuration listings and replace the current description that it has no configuration. Update `CHANGELOG.md` when implementation lands. No installer allowlist change is expected because `opl-guardian` is already in `install.sh` and configuration files are discovered by matching names.

The user has already removed standalone extensions from `~/.pi/agent/extensions`; document migrating any old standalone config files into the unified config, and do not automatically read legacy files.

## Non-goals

- Keeping or installing standalone `permission-gate`, `protected-paths`, or `confirm-destructive` implementations.
- Automatically migrating/merging old config files.
- Changing Pi core, provider behavior, tool schemas, session storage formats, or unrelated mode-level Bash safety.
- Expanding path matching into shell parsing or promising detection of indirect access through scripts/variables.
- Changing the malformed-call evidence format or adding log rotation.
