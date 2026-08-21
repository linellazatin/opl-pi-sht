# opl-modes

Unified mode manager for Pi. It provides read-only chat and planning modes, plan execution, custom configured modes, and compatibility aliases for existing workflows.

## Commands and flags

- `/mode` opens the mode picker; `/mode chat`, `/mode plan`, and `/mode normal` select modes.
- `/chat` toggles chat mode; `/chat off` exits it.
- `/plan` creates, loads, refines, saves, or discards plan files.
- `/execute` executes an existing plan.
- `--chat` and `--plan` start Pi in the corresponding mode.
- The configured cycle shortcut rotates through visible enabled modes.

Plans are stored under `.pi/plans/`. `plan_complete` is available only in execute mode and exits the mode after completion. Plan mode and chat mode use configurable read-only tool and Bash allowlists. Custom modes can define prompts, tools, safety patterns, labels, and optional model overrides.

## Configuration

Create `~/.pi/agent/configs/opl-modes.json` or copy [`configs/opl-modes.json`](../../configs/opl-modes.json). All fields are optional. The loader falls back to built-in modes, tool lists, safety patterns, labels, and defaults when fields are omitted or the file cannot be parsed. Configuration is read when the extension loads; restart Pi or run `/reload` after changes.

```json
{
  "ui": { "hideNotify": false, "hideWidget": true },
  "shortcuts": { "cycleMode": "shift+tab" },
  "cleanup": { "cleanupOnComplete": false },
  "chatAllowedTools": ["read", "bash", "grep", "find", "ls"],
  "planAllowedTools": ["read", "bash", "grep", "find", "ls"],
  "bashPatterns": {
    "safePatterns": ["^\\s*cat\\b", "^\\s*git\\s+(status|log|diff)"],
    "destructivePatterns": ["\\brm\\b", "\\bgit\\s+(commit|push)\\b"]
  },
  "modes": {
    "review": {
      "enabled": true,
      "prompt": "Review changes without modifying files.",
      "tools": ["read", "grep", "find", "ls"],
      "labels": { "widgetColor": "accent" }
    }
  }
}
```

`chatAllowedTools` and `planAllowedTools` replace the built-in read-only tool lists. `safePatterns` and `destructivePatterns` replace the corresponding Bash rules, so include every rule you need when overriding them. Custom entries under `modes` can add or override modes with prompts, tools, Bash rules, model overrides, visibility, completion permissions, and labels. Use Pi theme color tokens for widget colors.

The extension persists mode state in session entries and reconstructs it on resume or session-tree changes. It publishes mode state for companion extensions such as `opl-input` and `opl-footer`.
