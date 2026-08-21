# opl-todo

A session-branch-aware `todo` tool with a non-capturing top-right overlay, configurable shortcuts, and a `/todos` command. Todo state is stored in session tool results, so switching branches with `/tree` restores the list from that point in history.

## Features

- Model-callable `todo` tool with `list`, `add`, `toggle`, and `clear` actions.
- Adding to a fully completed list starts a fresh batch and resets IDs to `#1`.
- Non-capturing overlay anchored at the top right; it never steals editor focus.
- Overlay is hidden below 80 columns, uses 33% width by default, and caps visible items at 50% of terminal height.
- `/todos` opens a full-screen current-branch task list.
- Completed lists show `✓ All done!` and auto-hide after the configured delay.

## Configuration

Create `~/.pi/agent/configs/opl-todo.json` or copy [`configs/opl-todo.json`](../../configs/opl-todo.json). Configuration is read once when the extension loads; restart Pi or run `/reload` after changes.

```json
{
  "allDoneHideMs": 10000,
  "shortcuts": {
    "toggleWidget": "ctrl+alt+t",
    "resetDone": "ctrl+alt+r"
  },
  "widget": {
    "widthPercent": 33,
    "maxHeightPercent": 50,
    "minWidth": 32
  }
}
```

| Key | Type | Default | Description |
|---|---|---:|---|
| `allDoneHideMs` | number | `5000` | Delay before the all-done overlay hides; `0` hides immediately. |
| `shortcuts.toggleWidget` | string | `ctrl+alt+t` | Show or hide the overlay. |
| `shortcuts.resetDone` | string | `ctrl+alt+r` | Clear tasks only when every task is already complete. |
| `widget.widthPercent` | number | `33` | Overlay width percentage, from greater than 0 through 100. |
| `widget.maxHeightPercent` | number | `50` | Percentage of terminal rows used to calculate the item cap. |
| `widget.minWidth` | number | `32` | Minimum overlay width; values below 20 are rejected. |

## Session behavior

State is reconstructed from session history on session start and `/reload`, and synchronized when the session tree changes. A fully completed list is cleared when loaded so the next `add` begins a fresh batch. `clear` hides the overlay immediately. The overlay uses the current terminal width and is only visible when the width is at least 80 columns.

## Controls

- `/todos` opens a modal listing all tasks on the current branch; press Escape to close.
- The configured toggle shortcut shows or hides the overlay.
- The configured reset shortcut clears tasks only when all tasks are complete.

## Files

- `index.ts`: tool, overlay, shortcuts, `/todos`, and session integration.
- `config.ts`: JSON config loading and validation.
