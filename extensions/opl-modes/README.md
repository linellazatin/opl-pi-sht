# opl-modes

Unified mode manager for Pi. It provides normal, read-only chat, read-only planning, plan execution, and configurable custom modes. It also publishes shared mode state consumed by `opl-input` and `opl-footer`.

## Commands, flags, and shortcuts

- `/mode` opens the picker; `/mode chat`, `/mode plan`, and `/mode normal` select built-in modes.
- `/chat` toggles chat mode; `/chat off` exits it.
- `/plan` toggles plan mode, creates or loads a named plan, or accepts `/plan off`.
- `/execute` selects or executes an existing plan; `/execute <name>` runs a named plan.
- `--chat` and `--plan` start Pi in the corresponding read-only mode.
- The configured cycle shortcut rotates through enabled visible modes. Execute mode is excluded from cycling because it requires an active plan.

Plans are Markdown files under `.pi/plans/` with the `plan-` filename prefix. `plan_complete` is available only in execute mode. On completion, the plan file is deleted when `cleanup.cleanupOnComplete` is enabled. If execution ends without `plan_complete`, execute mode is exited automatically.

## Extension features

### Mode behavior

Chat and plan modes replace the active tools with configurable read-only tool lists and restrict Bash to safe inspection patterns. Destructive patterns are checked even when a command matches a safe pattern. User-provided safe and destructive pattern arrays replace the built-in lists, rather than extending them.

Custom modes can add or override modes with prompts, tool lists, Bash patterns, model overrides, visibility, enabled state, `plan_complete` permission, execute-handoff permission, labels, and `appearance`. Appearance is published to `opl-input` and `opl-footer`, so every mode owns its input prefix/border and footer identity color.

### Execute handoff

Any mode can start plan execution via the mode picker's `Execute:` entries or `/execute`, unless it sets `allowExecute: false`. When blocked, the picker hides the `Execute:` entries and `/execute` reports that execution is unavailable from the current mode. The plan-mode action menu (`Execute / Refine / Save & Exit / Discard & Exit`) is the designed plan-to-execute pipeline and is always available in plan mode regardless of this flag.

`allowPlanComplete: true` on a custom mode appends the `plan_complete` tool to that mode's tool list, letting a custom mode finish and exit through the same completion path as execute mode (the `tool_call` gate enforces the flag).

### Tool inheritance warning

A custom mode with no `tools` array inherits **all** tools, including `write` and `edit` — it is write-capable by default. Always specify an explicit read-only tool list for restrictive modes.

Mode state is persisted in session entries and restored on session resume or branch changes. The `mode-switcher` entry type and legacy chat/plan event identifiers are compatibility contracts.

## Configuration

Create `~/.pi/agent/configs/opl-modes.json` or copy [`configs/opl-modes.json`](../../configs/opl-modes.json). All fields are optional. The module reads the file when loaded; restart Pi or run `/reload` after changes.

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
      "prompt": "Deep web/local research with subagent fan-out. Create new md/html outputs under research/; never modify existing files.",
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
| `bashPatterns.safePatterns` / `bashPatterns.destructivePatterns` | Replace the shared Bash policy for built-in chat and plan. Per-mode pattern fields intentionally override this shared policy when those modes need to differ. |
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

`prefix`, `prefixColor`, and `borderColor` style `opl-input`; omitted fields use its compiled mode defaults. `modeColor` styles the value in `opl-footer`'s `mode_switcher` segment; if omitted, the footer uses hardcoded `muted`. Colors accept Pi theme tokens or six-digit hex strings.

Model overrides are resolved through Pi's model registry when entering a mode and the previously active model is restored on exit when applicable. Use Pi theme color tokens for widget label colors.

## Architecture

`config.ts` registers built-in modes, merges configured overrides, compiles Bash patterns, and publishes the registry. `state.ts` persists and restores mode/plan state and is the single publisher of `globalThis.__agentMode`. `index.ts` wires commands, picker, lifecycle hooks, tool replacement, Bash interception, and `plan_complete`; `utils.ts` handles plan files and shared helpers.
