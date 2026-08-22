# opl-footer

A customizable three-row footer for the Pi coding agent. It shows model, path, Git, context, thinking, mode, token, cost, session, and performance information in configurable left/right segments.

## Commands, flags, and shortcuts

No commands, flags, or shortcuts. Nerd Font detection can be overridden with `FOOTER_NERD_FONTS=1` or `FOOTER_NERD_FONTS=0`.

## Extension features

### Layout

The default footer has three content rows separated by horizontal dividers:

```
Row 1 left:  π | <model name> (<provider>) | <folder> <path> <branch> <dirty>
Row 1 right: <context bar> <pct%> / <max tokens>

Row 2 left:  Thinking: <LEVEL> | <active mode>
Row 2 right: T: <total> (<cached> cached) ↑ <in> ↓ <out> | $<cost>

Row 3 left:  <turns> turns · <steps> steps · <model requests> mreq · <tool calls> mtool
Row 3 right: LLM <time> (<last-turn TAT>) · Tool <time> | TTFT <time> · <tokens>/s | Cache <percent>%
```

The third row is populated after the first completed turn. Its session and performance values are reconstructed from the current session branch where possible; timing values are process-local.

## Features

- **Three-row layout**: independent left and right segment lists for model/context, mode/usage, and session/performance data
- **Context bar**: configurable gradient bar with percentage and context-window size
- **Git integration**: branch plus staged, unstaged, and untracked counts, with invalidation after relevant file and Git commands
- **Token and cost tracking**: total, cache, input/output, and accumulated cost segments
- **Session statistics**: turns, tool steps, model requests, and model tool calls
- **Performance statistics**: cumulative LLM/tool duration, most recent user-prompt-to-completion turnaround time, average time to first token, output rate, and cache-hit percentage
- **Thinking and mode indicators**: thinking-level colors plus caveman, plan, chat, or unified mode segments when available
- **Nerd Font support**: automatic detection with plain-icon fallbacks
- **Live updates**: branch changes and session events request footer re-rendering

## Configuration

Create `~/.pi/agent/configs/opl-footer.json` or copy the tracked example from [`configs/opl-footer.json`](../../configs/opl-footer.json). Configure all six row-side arrays (`row1LeftSegments` through `row3RightSegments`) to change the layout. Colors, icons, path/Git display, and the context bar are also configurable. Unknown or invalid JSON uses the extension defaults.

The config is cached for five seconds. Changes normally appear automatically; use `/reload` or restart Pi if needed.

```json
{
  "row1LeftSegments": ["pi", "separator", "model", "separator", "path", "git"],
  "row1RightSegments": ["context_pct"],
  "row2LeftSegments": ["thinking", "separator", "mode_switcher"],
  "row2RightSegments": ["token_total", "separator", "cost"],
  "row3LeftSegments": ["session_stats"],
  "row3RightSegments": ["perf_stats"]
}
```

See the tracked [`configs/opl-footer.json`](../../configs/opl-footer.json) for a complete example. Segment IDs, color fields, context-bar options, thinking-level colors, and icon overrides are documented below. Colors accept Pi theme tokens or hex strings.

## Architecture

`index.ts` installs the footer and lifecycle tracking. `segments/` renders configurable values; `theme.ts`, `types.ts`, and `config.ts` provide styling and JSON configuration; session and performance statistics are collected in process memory and reconstructed from session history where possible.

## Available Segments

| Segment | Description | Notes |
|---------|-------------|-------|
| `pi` | π symbol in accent blue | — |
| `model` | Model name in pink + `(provider)` in dim | No icon; provider omitted if unavailable |
| `path` | Current working directory | `segmentOptions.path.mode`: `"full"` (default) · `"abbreviated"` · `"basename"` |
| `git` | Git branch and dirty indicators | `showBranch`, `showStaged`, `showUnstaged`, `showUntracked` (all bool) |
| `context_pct` | Gradient bar + `X.X%` + max tokens | Bar fully configurable via `segmentOptions.contextBar` (see below). % and max tokens use `contextLabel` colour. Max tokens formatted with K/M suffix (e.g. `128k`, `2M`). Set `DEBUG_PCT` in `context.ts` to a number (0–100) to pin the bar at a fixed value for visual testing. |
| `cost` | `$<amount>` | `$` dim, amount in `cost` colour (`muted` by default) |
| `thinking` | `Thinking: <LEVEL>` | Dim label, CAPS level with per-level colour; always visible |
| `mode_switcher` | Unified active mode label | Reads state published by `opl-modes`; `appearance.modeColor` controls the mode value, with hardcoded `muted` fallback |
| `caveman` | `Caveman mode: <MODE>` | Hidden when caveman extension not loaded |
| `plan_mode` | `Plan mode: <MODE>` | Hidden when plan-mode extension not loaded |
| `chat_mode` | `Chat mode: <MODE>` | Hidden when chat-mode extension not loaded |
| `token_total` | `T: <total> (<cached> cached) ↑ <in> ↓ <out>` | Labels dim, numbers in `tokens` colour (`muted` by default) |
| `token_in` | Input tokens | Available for custom layouts |
| `token_out` | Output tokens | Available for custom layouts |
| `cache_read` | Cache read tokens (hidden if zero) | — |
| `cache_write` | Cache write tokens (hidden if zero) | — |
| `context_total` | Total context window size | — |
| `separator` | `\|` divider | Coloured via `separator` in `colors` |
| `text:...` | Literal text, e.g. `text:⚡` | — |

## Context Bar

The `context_pct` segment's bar is fully configurable via `segmentOptions.contextBar`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `barWidth` | number | `18` | Number of characters wide |
| `filledChar` | string | `"▋"` | Character used for the filled portion |
| `unfilledChar` | string | `"▋"` | Character used for the unfilled portion |
| `unfilledColor` | color | `"#4e4c49"` | Color of the unfilled portion — hex or pi theme token |
| `gradientStart` | color | `"#f29373"` | Gradient color at the left/empty end — hex or pi theme token |
| `gradientMid` | color | `"#d67858"` | Gradient midpoint color — hex or pi theme token |
| `gradientEnd` | color | `"#ae4f2f"` | Gradient color at the right/full end — hex or pi theme token |
| `gradientMidPoint` | number | `0.55` | Where `gradientMid` sits along the bar (0–1). Below this fraction the gradient runs start→mid; above it mid→end |

All color fields accept either a hex string (e.g. `"#ff6347"`) or a pi theme token (e.g. `"accent"`, `"warning"`, `"dim"`).

```json
{
  "segmentOptions": {
    "contextBar": {
      "barWidth": 20,
      "unfilledColor": "dim",
      "gradientStart": "#56b6c2",
      "gradientMid": "#61afef",
      "gradientEnd": "#c678dd",
      "gradientMidPoint": 0.4
    }
  }
}
```

## Thinking Levels

The `thinking` segment shows per-level colours:

| Level | Display | Default colour |
|-------|---------|---------------|
| `off` | `OFF` | dim |
| `minimal` | `MINIMAL` | muted |
| `low` | `LOW` | warning |
| `medium` | `MEDIUM` | success |
| `high` | `HIGH` | `#afb9fe` |
| `xhigh` | `EXTRA HIGH` | rainbow gradient |
| `max` | `MAX` | rainbow gradient |

Override any level colour via the corresponding key in `colors`. Setting `thinkingXhigh` or `thinkingMax` replaces the rainbow gradient with a solid colour:

```json
{
  "colors": {
    "thinkingXhigh": "#9575cd",
    "thinkingMax": "#ce93d8"
  }
}
```


## Git Status Indicators

The `git` segment shows:
- Branch name coloured green (clean) or amber (dirty)
- `*N` — unstaged changes
- `+N` — staged changes
- `?N` — untracked files

## Session and Performance Statistics

The `session_stats` segment shows turns, tool steps, and (when available) model requests and model tool calls for the current branch; turns and steps are reconstructed from session history so they survive quit/resume.

The `perf_stats` segment shows cumulative session LLM and tool time, average time to first token, output tokens/sec, and cache-hit percentage. The `LLM` figure is followed by the most recent user-prompt-to-completion turnaround time in parentheses, e.g. `LLM 18m 22s (2m 13s)`. This turnaround reflects only fully-settled turns (the `agent_settled` signal, after any retries or compaction), so it stays blank until the first turn completes. All `perf_stats` timing values are ephemeral — they reset each session and are not reconstructed from branch history.

## Icons

Nerd Font icons are auto-detected from your terminal. Ghostty, WezTerm, Kitty, iTerm2, Alacritty, Foot, Rio, and Contour are recognised automatically — everything else falls back to plain Unicode symbols. If detection gets it wrong (e.g. when running inside tmux), override it:

```bash
export FOOTER_NERD_FONTS=1  # force Nerd Fonts on
export FOOTER_NERD_FONTS=0  # force plain icons
```

### Installing a Nerd Font (macOS)

```bash
brew install --cask font-jetbrains-mono-nerd-font
```

Other fonts available via `brew search nerd-font`.

### Configuring iTerm2

1. Open **Settings → Profiles → Text**
2. Set **Font** to `JetBrainsMonoNL Nerd Font Propo`, size `10` (recommended)
3. Enable **Use a different font for non-ASCII text** and set the same font there — required for icons to render correctly

### Custom Icons

To swap out any icon, add an `icons` key to your `~/.pi/agent/configs/opl-footer.json`. Browse available Nerd Font glyphs at [nerdfonts.com/cheat-sheet](https://www.nerdfonts.com/cheat-sheet):

```json
{
  "icons": {
    "branch": "",
    "separator": "|"
  }
}
```
