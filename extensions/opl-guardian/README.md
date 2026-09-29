# opl-guardian

A configurable session and tool safety extension. `opl-guardian` filters malformed assistant tool calls, prompts before dangerous Bash commands, blocks operations on protected paths, and confirms destructive session transitions. It replaces the standalone `permission-gate`, `protected-paths`, and `confirm-destructive` extensions while retaining malformed-call diagnostics. It adds no tools, commands, prompts, or model-facing schema overhead.

## Configuration

Copy `configs/opl-guardian.json.sample` to `~/.pi/agent/configs/opl-guardian.json` and customize it. For a package install, find the sample under the installed package's `configs/` directory. All settings are optional; absent settings use the defaults from the sample.

- `permissionGate.patterns` is a list of case-insensitive JavaScript regex strings. A match prompts for confirmation in the terminal or over RPC; Yes allows the command, while No or cancel blocks it. An empty list disables pattern matching. `permissionGate.blockWithoutUI` defaults to `true` and blocks a match when confirmation UI is unavailable. Configured patterns replace the defaults; update existing config files manually to adopt changes to default patterns.
- `protectedPaths.paths` contains `{ "path", "deny" }` entries. Valid denied operations are `read`, `write`, `edit`, and `bash`. Bare names match exact path segments for file tools; Bash uses literal command matching. Absolute and `~/` entries match resolved paths and descendants for file tools. An empty list disables path rules.
- `confirmDestructive` controls confirmations for starting a new session (`clearSession`), resuming another session when unanswered user work exists (`switchWithUnsavedWork`), and forking (`forkSession`). All default to `true`. `confirmDestructive.blockWithoutUI` also defaults to `true`; set it to `false` to allow these actions without an interactive confirmation.
- `dropMalformedToolCalls` defaults to `true`. Set it to `false` to disable only malformed-call filtering and its incident log.

Malformed or invalid config sections generate a warning when a UI is available and fall back to safe defaults for the affected settings. Invalid individual regexes or protected-path entries are reported; valid entries continue to apply. Empty arrays are explicit opt-outs.

If migrating from the standalone extensions, manually move their settings into the corresponding `permissionGate` and `protectedPaths` sections. `opl-guardian` does not read or merge legacy config files. Credits to pi's sample extensions [here](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions).

## What it guards

### Dangerous Bash commands

The default patterns cover recursive `rm` flags (including `-rf`, `-fr`, and separate `-f -r`), `sudo`, `chmod`/`chown` to mode `777`, `printenv`, and bare `env`. Matching commands require confirmation. Without a confirmation UI they are blocked by default.

### Protected paths

Defaults protect `.env` from read/write/edit/Bash, `.git/` from read/write/edit, `node_modules/` from write/edit, and `~/.pi/agent/auth.json` from read/write/edit/Bash. File-tool path checks compare both the supplied path and its filesystem-resolved target, including existing symlinks and symlinked parents for new files; paths that cannot be safely resolved are blocked when an applicable path rule is active. A path denial is a hard block and takes precedence over a dangerous-command confirmation for the same Bash call. These are preflight checks, not filesystem confinement: paths can change between the check and the tool operation. Bash matching is literal and cannot reliably detect indirect access through scripts, variables, or shell expansion (for example `cat "$HOME/.pi/agent/auth.json"` misses the auth file); it also over-blocks commands that merely *mention* a protected path or name (for example `grep .env notes.md`). Do not rely on guardian alone as a security boundary against untrusted shell commands.

### Destructive session actions

Starting a new session, resuming another session with a pending user message, and forking prompt for confirmation by default. Configured actions are canceled if no UI is available unless `confirmDestructive.blockWithoutUI` is explicitly set to `false`.

### Malformed provider tool calls

A tool call is malformed when its ID or name is blank after trimming whitespace. The extension drops malformed calls before Pi persists or replays them, preserves valid sibling calls, and turns invalid-only responses into a text-only stop so the user can continue. Unfamiliar but non-empty tool names are not rejected. As defense in depth, the `tool_call` boundary also blocks any blank-id/name call that slips through, so a malformed call can never execute even if the `message_end` filter is bypassed.

## Forensic JSONL

Each malformed-call incident appends one JSON object to:

```text
<project cwd>/err/guardian.jsonl
```

Records include timestamp (falling back to the current time when a provider omitted or zeroed it), session/project/provider/model metadata, and removed tool-call blocks. The log does not contain prompts, assistant text, thinking, or tool results, but tool-call arguments may include paths, commands, or user text. Treat it as local diagnostic data and ignore `err/` in version control where appropriate. On POSIX, a newly created log is restricted to mode `0600` on a best-effort basis. If logging fails, malformed calls are still removed and the diagnostic reports the write failure.

## Testing

```bash
npm run test:opl-guardian
```
