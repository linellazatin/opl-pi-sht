# Todo Extension

A persistent top-right overlay widget + LLM `todo` tool for pi coding agent.
State is stored inside session tool results, so it is automatically branch-aware: switching branches with `/tree` restores the todo list to exactly what it was at that point in history.

## Files

```
todo/
├── index.ts     — main extension (tool, overlay, shortcuts, /todos command)
├── config.ts    — config loading from ~/.pi/agent/configs/opl-todo.json
└── README.md    — this file
```

---

## The `todo` Tool

The LLM calls this tool directly. Four actions:

| Action    | Required param | Effect |
|-----------|---------------|--------|
| `list`    | —             | Returns the current todo list as text |
| `add`     | `text`        | Adds a new task; auto-shows the widget |
| `toggle`  | `id`          | Marks a task done/undone; auto-shows widget |
| `clear`   | —             | Removes all tasks; hides the widget |

### Fresh-batch behaviour
When `add` is called and **all existing tasks are already done**, the completed list is silently cleared first and `nextId` resets to `#1`. The new task starts a clean batch — no manual `clear` needed between sessions.

---

## Overlay Widget

- Floats at the **top-right corner** of the terminal.
- **Non-capturing** — never steals focus from the editor input.
- Hidden on terminals narrower than **80 columns**.
- **33% of screen width**, 32-char minimum.
- **50% of screen height** as max items (dynamic based on terminal rows).
- Shows at most `maxItems` tasks; overflow shown as `… +N more`.

### Sizing logic

| Config | Default | Calculation |
|--------|---------|-------------|
| `widget.widthPercent` | `33` | `max(minWidth, floor(width * widthPercent%))` |
| `widget.maxHeightPercent` | `50` | `max(3, floor(rows * maxHeightPercent%) - 5)` |
| `widget.minWidth` | `32` | Floor for widget width |

### Widget states

| State | Display |
|-------|---------|
| No tasks | `No active todos` (widget hidden) |
| Tasks in progress | `○ #1 task name` rows + `X/N completed` |
| All done | `✓ All done!` + auto-hide timer starts |

---

## Keyboard Shortcuts

| Shortcut (default) | Config key | Effect |
|--------------------|-----------|--------|
| `ctrl+alt+t` | `shortcuts.toggleWidget` | Show / hide the widget |
| `ctrl+alt+r` | `shortcuts.resetDone` | Clear all tasks — **only fires when all are done** |

Both shortcuts are configurable in `~/.pi/agent/configs/opl-todo.json`. Changes take effect on the next `/reload`.

---

## `/todos` Command

Opens a full-screen modal listing all tasks on the current branch with progress count. Press `Escape` to close.

---

## Session Behaviour

| Event | Behaviour |
|-------|-----------|
| `/reload` or session start | State reconstructed from session history |
| All tasks were done at last save | Auto-cleared on load — fresh start |
| Branch switch (`/tree`) | Todos sync to that branch's state |
| `clear` action | Widget hidden immediately |
| All tasks toggled done | Widget shows `✓ All done!`, starts auto-hide timer |

---

## Configuration

Create `~/.pi/agent/configs/opl-todo.json` or copy [`configs/opl-todo.json`](../../configs/opl-todo.json). Configuration is read once when the extension loads, so restart Pi or run `/reload` after changes.

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

`allDoneHideMs` controls the completed-widget timer. `shortcuts.toggleWidget` and `shortcuts.resetDone` change the overlay controls. `widget.widthPercent`, `widget.maxHeightPercent`, and `widget.minWidth` control its size; percentages accept values from 1 to 100 and minimum width must be at least 20 characters. Omitted values use the defaults.

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allDoneHideMs` | number | `5000` | Milliseconds before the widget auto-hides after all tasks complete. Set to `0` to hide immediately. |
| `shortcuts.toggleWidget` | string | `"ctrl+alt+t"` | Show/hide the overlay widget. |
| `shortcuts.resetDone` | string | `"ctrl+alt+r"` | Manually clear all todos — silent no-op when any task is still incomplete. |
| `widget.widthPercent` | number | `33` | Widget width as percentage of screen width (1-100). |
| `widget.maxHeightPercent` | number | `50` | Max visible items as percentage of terminal rows (1-100). |
| `widget.minWidth` | number | `32` | Minimum widget width in characters (≥20). |

All changes require a `/reload` to take effect — config is read once at extension load time.
