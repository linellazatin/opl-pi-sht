# opl-modes

Unified mode manager for Pi. It provides normal, read-only chat, read-only planning, plan execution, and configurable custom modes. It also publishes shared mode state consumed by `opl-input` and `opl-footer`.

## Commands, flags, and shortcuts

- `/mode` opens the picker; `/mode chat`, `/mode plan`, and `/mode normal` select built-in modes, and `/mode <name>` selects any registered custom mode (for example `/mode review`). `execute` is excluded because it needs an active plan; use `/execute`.
- `/chat` toggles chat mode; `/chat off` exits it.
- `/plan` toggles plan mode, creates or loads a named plan, or accepts `/plan off`.
- `/execute` selects or executes an existing plan; `/execute <name>` runs a named plan.
- `--chat` and `--plan` start Pi in the corresponding read-only mode.
- The configured cycle shortcut rotates through enabled visible modes. Execute mode is excluded from cycling because it requires an active plan. The default `shift+tab` is also Pi's built-in `app.thinking.cycle`, so both fire on one press; rebind either action in `~/.pi/agent/keybindings.json` (or pick another `shortcuts.cycleMode`) if you want them separate.

Plans are Markdown files under `.pi/plans/` with the `plan-` filename prefix. A plan name must contain at least one letter or digit, so `/plan .` or `/plan --` is rejected instead of producing an untitled `plan-.md`. `plan_complete` is available in execute mode and in any mode that sets `allowPlanComplete`. On completion, the plan file is deleted when `cleanup.cleanupOnComplete` is enabled. If execution ends without `plan_complete`, execute mode is exited automatically — but only when a turn actually finished: an aborted (ESC) or errored turn keeps execute mode active so the plan can be resumed.

## Extension features

### Mode behavior

Chat and plan modes replace the active tools with configurable read-only tool lists and restrict Bash to safe inspection patterns. The allowlist is checked **per shell segment**, not just at the start of the command line: `&&`, `||`, a lone `&` (backgrounding), `|`, `;`, newlines, `$(...)`, backticks, and `<(`/`>(` each begin a segment, and every segment must match a safe pattern. Segment scanning is quote-aware, so `grep "a|b"` is one command, but a `$(...)` or backtick payload still runs inside double quotes and is split out and checked, so `echo "$(node -e ...)"` cannot hide behind the quoted argument. `cat f && node -e '...'`, `ls; python -c '...'`, and `cat x & rm -rf /` are blocked because their second segment is not safe-listed. Destructive patterns are still checked even when a command matches a safe pattern. The allowlist covers read-only inspection and text filters only: `awk`, `sed`, `xargs`, `perl`, `python`, and `env` are deliberately absent because they can write files, exec programs from their arguments, or dump API keys. Valid user-provided safe and destructive pattern arrays replace the built-in lists, rather than extending them. An explicit empty per-mode array replaces that policy with none; a malformed non-empty per-mode array is ignored and inherits the existing policy.

The shared destructive base blocks file mutation primitives (`rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `tee`, `dd`, `shred`, `truncate`), `find -delete`/`-exec`/`-execdir`/`--exec-batch` and find's file-writing predicates (`-fprint`, `-fprint0`, `-fprintf`, `-fls`), any `--output` file (`sort --output`, `git log/diff/show --output`), `sort -o` in any argument position, `npm`/`yarn`/`pip` install and update forms including `npm audit fix`, state-changing `git` subcommands (including `branch -d`/`-D`/`-m`/`-M`/`-c`/`-C`/`--delete`/`--unset-upstream` and the writing `git remote` subcommands), `sudo`/`su`, `kill`/`pkill`, shell spawns, editors, `uniq`'s output operand (`uniq -c in.txt out.txt`; flags are not operands, so `uniq -c sorted.txt` stays a read), and every redirect that names a file - while descriptor duplication (`2>&1`, `>&2`, `>&-`) and `>/dev/null` are not writes and stay allowed. `env` and `printenv` are not safe-listed, since they could dump provider API keys into the model context. Program-name entries are anchored to command position and matched per segment, so a read-only command that merely *mentions* a dangerous word in an argument (`du -sh`, `find . -name '*.sh'`, `ls cp/`, `cat mv.sh`, `git log --grep=rm`, `grep -rn 'touch' src`) stays allowed, and descriptor duplication (`2>&1`, `>&2`, `>&-`) is not mistaken for a file write. Every destructive pattern is tested against the command and each of its segments, with and without quotes/backslashes stripped, so `r"m"` and `-del"ete"` cannot dodge the list. That blocklist split deliberately ignores quotes, so an operator inside a quoted string (`echo "a > b"`) is over-blocked rather than trusted. This is still a heuristic backstop, not a process-isolation boundary: `rg --pre`, `npx`, and any command whose *name* comes from an expansion are outside what a pattern list can catch.

Custom modes can add or override modes with prompts, tool lists, Bash patterns, model overrides, visibility, enabled state, `plan_complete` permission, execute-handoff permission, labels, and `appearance`. `visible: false` hides a mode from the picker and the cycle list but leaves it reachable through `/mode <name>`, on purpose: it is the escape hatch for a mode you want available without cluttering the menu. Appearance is published to `opl-input` and `opl-footer`, so every mode owns its input prefix/border and footer identity color. A mode that omits its own `safePatterns`/`destructivePatterns` inherits the whole shared base; a mode overrides a component with its own array or disables all gating with `unrestrictedBash: true` — which works for built-in overrides (`modes.chat`, `modes.plan`, ...) as well as new custom modes. Built-in `off` and `execute` stay unrestricted unless you give them their own `tools` list.

### Execute handoff

Any mode can start plan execution via the mode picker's `Execute:` entries or `/execute`, unless it sets `allowExecute: false`. When blocked, the picker hides the `Execute:` entries and `/execute` reports that execution is unavailable from the current mode. The plan-mode action menu (`Execute / Refine / Save & Exit / Discard & Exit`) is the designed plan-to-execute pipeline and is always available in plan mode regardless of this flag. The Refine entry counts cycles (`Refine (3 cycles so far)`) as information only; nothing caps how often you refine.

`allowPlanComplete: true` on a custom mode appends the `plan_complete` tool to that mode's tool list, letting a custom mode finish and exit through the same completion path as execute mode: the `tool_call` gate, the tool body, and the result handler all use one `planCompleteAllowed()` predicate, so calling it from such a mode deletes the plan file (when cleanup is enabled) and reports `Plan implemented. Plan mode OFF.` exactly like execute mode.

### Tool inheritance warning

A custom mode with no `tools` array inherits **all** tools, including `write` and `edit` — it is write-capable by default. Always specify an explicit read-only tool list for restrictive modes.

`off` behaves the same way: it restores the tools that were active before the mode (never a wider set). Set `modes.off.tools` to pin the resting tool set instead — for example to keep `subagent`/`browser` out of normal mode entirely. Pinning replaces the snapshot taken on mode entry, so a later mode that lists no `tools` inherits the pinned set rather than the older, wider one. `load_tools` is offered in `off` because withheld lazy tools are otherwise unreachable there.

Model overrides are resolved through Pi's model registry when entering a mode. A blank or partial `model` (for example `{ "provider": "", "id": "" }`) is treated as **no override**, so the mode keeps the current model instead of warning `Model not found: /`. The previously active model is captured once per mode and restored on exit; the restore point is persisted in the mode session entry, so `/reload` and `/resume` inside a mode no longer lose it. If the restore target is gone from the registry it is dropped immediately; if it exists but has no credentials (before `/login`, say) the restore is retried once and then released, so a stale point cannot block future captures indefinitely. `Pi.setModel` is session-scoped: it never rewrites your configured `defaultProvider`/`defaultModel`, but it does append a model change to the session transcript, which is why the restore point is persisted alongside the mode. Changes are serialized, so a rapid mode exit cannot leave a superseded mode model active. Note that setting `modes.off.model` makes OFF a pinned baseline: it is applied on every mode exit *and* at session start, overriding `--model` and the configured default. Use Pi theme color tokens for widget label colors.

Mode state is persisted in session entries and restored on session resume or branch changes. Pi ignores tool names it does not know, so a `tools` list with a typo would silently lose tools: every mode entry checks the list against the registered tools and warns once per unknown name per session. The `mode-switcher` entry type and legacy chat/plan event identifiers are compatibility contracts. On resume, an unknown mode name in a session entry is ignored (falling back to normal), and plan filenames containing path separators or `..` are dropped, so a stale or foreign branch cannot leave the session unrestricted or point plan reads outside `.pi/plans/`.

## Configuration

Create `~/.pi/agent/configs/opl-modes.json` or copy [`configs/opl-modes.json.sample`](../../configs/opl-modes.json.sample). All fields are optional. The module reads the file when loaded; restart Pi or run `/reload` after changes.

```json
{
  "ui": { "hideNotify": false, "hideWidget": true },
  "shortcuts": { "cycleMode": "ctrl+alt+m" },
  "cleanup": { "cleanupOnComplete": true },
  "defaultNotifyTemplate": "✓ {Name} mode ON",
  "bashPatterns": {
    "safePatterns": ["^\\s*cat\\b"],
    "destructivePatterns": ["\\brm\\b"]
  },
  "modes": {
    "review": {
      "enabled": true,
      "allowExecute": false,
      "prompt": "Review diffs and codebases for correctness, security, and architecture. Do not modify files.",
      "tools": ["read", "bash", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "artifact", "questionnaire"],
      "safePatterns": ["^git", "^cat", "^grep", "^diff", "^ls"],
      "labels": { "widgetColor": "accent" }
    },
    "research": {
      "enabled": true,
      "allowExecute": false,
      "prompt": "Deep web/local research with subagent fan-out. Create new outputs in any location; never modify existing files.",
      "tools": ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "artifact", "questionnaire", "subagent", "subagent_wait", "write"]
    },
    "verify": {
      "enabled": true,
      "allowPlanComplete": true,
      "prompt": "Verify the implementation, then call plan_complete.",
      "tools": ["read", "grep", "bash", "plan_complete"]
    }
  }
}
```

| Area | Behavior |
|---|---|
| `ui.hideNotify` / `ui.hideWidget` | Suppress mode notifications or widgets. |
| `shortcuts.cycleMode` | Keybinding for cycling enabled visible modes. |
| `cleanup.cleanupOnComplete` | Delete the active plan after successful `plan_complete`. |
| `defaultNotifyTemplate` | Notification template for custom modes; `{Name}` is capitalized mode name. |
| `modes.chat.tools` / `modes.plan.tools` | Replace the respective built-in read-only tool lists. |
| `chatAllowedTools` / `planAllowedTools` | **Deprecated compatibility aliases** for the built-in tool lists. They are used only when the corresponding `modes.<name>.tools` is omitted; migrate to `modes.chat.tools` or `modes.plan.tools`. |
| `bashPatterns.safePatterns` / `bashPatterns.destructivePatterns` | Shared Bash policy applied to every mode by default; a mode overrides with its own `modes.<name>.safePatterns`/`destructivePatterns` or disables gating with `modes.<name>.unrestrictedBash: true`. Every segment of a command must satisfy the allowlist. |
| `modes.<name>.unrestrictedBash` | Set `true` to exempt a mode from the Bash policy entirely (no safe/destructive patterns). Works for custom modes and built-in overrides. |
| `modes.off.tools` | Optional: pin the resting tool set for OFF mode. Omit to restore whatever was active before the mode. |
| `lazyTools` | Tool names withheld from the active set at rest and enabled on demand (see Lazy tool loading below). |
| `modes.<name>` | Add or override a mode, including `model`, `tools`, patterns, `allowPlanComplete`, `allowExecute`, `visible`, `enabled`, `prompt`, `labels`, and `appearance`. |

### Mode appearance

Use `modes.<name>.appearance` to keep any mode's visual identity with its definition. This applies to built-in `off`, `chat`, `plan`, and `execute` modes as well as custom modes:

```json
{
  "modes": {
    "chat": {
      "appearance": {
        "prefix": "󰭻",
        "prefixColor": "#157cd6",
        "borderColor": "#157cd6",
        "modeColor": "#157cd6"
      }
    }
  }
}
```

`prefix`, `prefixColor`, and `borderColor` style `opl-input`; omitted fields use its compiled mode defaults. `modeColor` styles the value in `opl-footer`'s `mode_switcher` segment; if omitted, the footer uses hardcoded `muted`. Colors accept Pi theme tokens, six-digit hex, or the three-digit `#abc` shorthand (expanded to `#aabbcc`).

Model overrides are resolved through Pi's model registry when entering a mode and the previously active model is restored on exit when applicable. Changes are serialized, so a rapid mode exit cannot leave a superseded mode model active. Use Pi theme color tokens for widget label colors.

### Lazy tool loading

`lazyTools` withholds heavy tool schemas from the active set until the model actually needs them, keeping the system-prompt prefix (and its prompt-cache write) smaller every session:

```json
{
  "lazyTools": ["subagent", "subagent_wait", "subagent_supervisor", "browser", "simplebench"]
}
```

Behavior:

- Listed tools are removed from the active set wherever opl-modes computes it. In practice this only affects modes that would otherwise include them: `off`/`execute` (which inherit all tools) and custom modes that list them. Read-only `chat`/`plan` already exclude these tools, so nothing changes there.
- When at least one lazy tool is withheld from a mode, opl-modes registers and activates a `load_tools` tool. The model calls `load_tools({ tools: [...] })` (or with no argument to enable all currently-allowed lazy tools) to activate them before use.
- `load_tools` is bounded by the current mode's tool policy: it can only enable a lazy tool the active mode already permits, so a read-only mode cannot enable a write-capable tool.
- Core built-ins (`read`, `edit`, `write`, `bash`, `powershell`, `grep`, `find`, `ls`), `plan_complete`, and `load_tools` itself are protected and silently ignored if listed in `lazyTools`.
- Switching modes re-applies the policy, so a lazy tool enabled earlier returns to inactive on the next mode change and must be re-enabled.
- A mode `prompt` that instructs the model to use a lazy tool must also tell it to call `load_tools` first, otherwise the instruction names a tool the model cannot see. The bundled `research` mode does exactly that.

Caching note: activating a lazy tool mid-session preserves the cached prefix on models with native deferred tool loading (Anthropic 4.5+, OpenAI gpt-5.4+) and otherwise triggers one prompt-cache rewrite from that point. It is most effective for tools you use occasionally (delegation, browser automation, benchmarking).

## Architecture

`config.ts` registers built-in modes, merges configured overrides, compiles Bash patterns, and publishes the registry. `state.ts` persists and restores mode/plan state (including the persisted model restore point) and is the single publisher of `globalThis.__agentMode`. `index.ts` wires commands, picker, lifecycle hooks, tool replacement, Bash interception, and `plan_complete`; `utils.ts` handles plan files, the per-segment Bash gate, and shared helpers.
