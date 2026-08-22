# opl-todo

Provides branch-aware model-managed tasks with a non-capturing overlay and full-screen `/todos` view.

## Commands, flags, and shortcuts

- `/todos`: open the current branch's full-screen task list; `Esc` closes it.
- Tool: `todo` with `list`, `add`, `toggle`, and `clear` actions.
- `shortcuts.toggleWidget`: show or hide the overlay, default `ctrl+alt+t`.
- `shortcuts.resetDone`: clear only a fully completed list, default `ctrl+alt+r`.

## Extension features

- Stores todos in session tool results; switching session branches with `/tree` restores that branch's list.
- Starts a fresh batch at ID `#1` when adding after every prior task is complete.
- Displays a top-right overlay without taking editor focus; hides below 80 columns and caps its height to the configured terminal percentage.
- Shows `✓ All done!` and hides after the configured delay; `clear` hides immediately.
- Reconstructs state on session start, `/reload`, and session-tree changes. A completed restored list is cleared so the next add begins a new batch.

## Configuration

Copy [`configs/opl-todo.json`](../../configs/opl-todo.json) to `~/.pi/agent/configs/opl-todo.json`, then `/reload` or restart Pi.

```json
{
  "allDoneHideMs": 10000,
  "shortcuts": { "toggleWidget": "ctrl+alt+t", "resetDone": "ctrl+alt+r" },
  "widget": { "widthPercent": 33, "maxHeightPercent": 50, "minWidth": 32 }
}
```

| Key | Default | Behavior |
|---|---:|---|
| `allDoneHideMs` | `5000` | Delay before a completed overlay hides; `0` hides immediately. |
| `shortcuts.toggleWidget` | `ctrl+alt+t` | Toggle overlay visibility. |
| `shortcuts.resetDone` | `ctrl+alt+r` | Clear only a fully completed list. |
| `widget.widthPercent` | `33` | Overlay width, greater than 0 through 100. |
| `widget.maxHeightPercent` | `50` | Terminal-row percentage used for the item cap. |
| `widget.minWidth` | `32` | Minimum overlay width; values below 20 are rejected. |

## Architecture

`index.ts` registers the tool, overlay, shortcuts, command, and session integration. `config.ts` loads and validates JSON. Todo state is derived from session history rather than a separate file.
