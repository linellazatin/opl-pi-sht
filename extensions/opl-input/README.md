# opl-input

Replaces Pi's default chat editor with a mode-aware custom editor. Native editor behavior such as cursor movement, history, autocomplete, paste, and slash-menu handling remains available.

## Commands, flags, and shortcuts

No commands, flags, or shortcuts. It replaces the standard editor at session start.

## Extension features

- **Boxed or unboxed input**: Full `┌─┐`/`│`/`└─┘` framing by default, or horizontal rules only with `boxedView: false`.
- **External configuration**: Settings are loaded from `~/.pi/agent/configs/opl-input.json`, not hard-coded into the extension.
- **Mode-aware styling**: Bash input has an input-local style; every active mode receives its border and prefix appearance from `opl-modes`.
- **Companion animation**: An optional animated three-line ASCII companion appears above the editor, with changing expressions, blinking, drifting, ear movement, and temporary hidden phases.
- **Scroll-aware borders**: Editor scroll indicators are embedded in the top or bottom border when the input has more content than fits.
- **Slash-menu placement**: The slash menu is rendered below the input with configurable gap and indentation.
- **Responsive rendering**: Narrow terminals fall back to the native editor rendering; the companion is hidden below 40 columns.
- **Shared idle heartbeat**: this component owns the bundle's only render timer. With the companion disabled it slows to one repaint per second instead of ten, which still advances the footer's elapsed/time-per-second cells while Pi is idle.
- **Hex and theme colors**: Color settings accept Pi theme tokens or six-digit hex colors.

## Mode styling precedence

Exactly one style applies at a time, in this order: Bash (`!` input) > active `opl-modes` appearance > hardcoded mode fallback. The compiled fallbacks are normal: `❯`/`accent`/`border`; chat: `»`/`borderAccent`; and plan/execute: `⏸`/`customMessageLabel`.

## Configuration

Create `~/.pi/agent/configs/opl-input.json` or copy [`configs/opl-input.json.sample`](../../configs/opl-input.json.sample). The file is read once when the extension module loads; run `/reload` or restart Pi after changes.

```json
{
  "boxedView": false,
  "boxPadX": 1,
  "menuGap": 0,
  "extraMenuIndent": 1,
  "companion": {
    "enabled": true,
    "color": "accent",
    "type": "dog",
    "ears": " /\\_/\\ ",
    "types": [{ "typeName": "dog", "top": " /),(\\ " }]
  }
}
```

### Top-level options

| Option | Type | Default | Description |
|---|---|---:|---|
| `boxedView` | boolean | `true` | Full box when true; horizontal rules without side borders when false. |
| `boxPadX` | number | `1` | Horizontal padding inside the editor. |
| `menuGap` | number | `0` | Blank lines between the input bottom border and slash menu. |
| `extraMenuIndent` | number | `1` | Additional indentation for slash-menu lines. |

### Companion

| Field | Type | Default | Description |
|---|---|---:|---|
| `companion.enabled` | boolean | `false` | Show the animated companion above the input. The idle repaint that drives it runs every 100 ms when enabled and every 1 s when disabled (the footer's time-based cells ride the same tick). |
| `companion.color` | color | `"accent"` | Companion color. |
| `companion.type` | string | unset | Select a named entry from `companion.types`; built-in `dog` also has a fallback shape (`"cat"` uses the default ears). |
| `companion.ears` | string | cat ears | Directly override the companion's top line; wins over `type`. |
| `companion.types` | array | unset | Named `{ "typeName", "top" }` top-line definitions for use with `type`. |

The companion requires at least 40 terminal columns and reserves three top-padding lines when enabled. Its animation timing and probabilities are source constants in `config.ts`, not user configuration.

### Color values

Every color option accepts either:

- **A Pi theme token** — a color name from Pi's theme schema (56 names at pi 0.87.0 and 1.1.0, 7 of them `*Bg` fills). The ones that matter here:
  - Core: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`
  - Messages/content: `thinkingText`, `searchMatchText`, `userMessageText`, `customMessageText`, `customMessageLabel`
  - Tools: `toolTitle`, `toolOutput`, `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`
  - Markdown: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`
  - Syntax: `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`
  - Thinking borders: `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax`
  - Special: `bashMode`
- **A hex color** — `"#c07898"`, or the three-digit shorthand `"#abc"` (expanded to `#aabbcc`). Hex values are emitted as ANSI truecolor (`38;2;r;g;b`); there is no 256-color downgrade in this extension, so on a 256-only terminal a hex color may render approximately or not at all, while a theme token renders correctly.

Invalid theme tokens fall back to the theme's `border` token; invalid hex renders uncolored rather than crashing.
- A mode `prefix` is clamped to one terminal cell (continuation lines reserve a single space), so a wide or multi-character `appearance.prefix` such as `👀` is truncated to one cell rather than pushing the box border past the editor width.

## Architecture

`index.ts` installs the editor integration and disposes companion render timers on editor replacement or session shutdown; `mode-style.ts` resolves Bash > published mode appearance > compiled fallback; `config.ts` loads editor and companion settings; and `utils.ts` handles color and rendering helpers. `opl-modes` is the sole publisher of active mode appearance through `globalThis.__agentMode`.

Two couplings are worth knowing before editing this extension:

- **pi-tui's text output.** Re-framing the editor means recognising its horizontal borders and
  its scroll indicator, and pi-tui exposes neither as an API: they are the literal strings `─`
  and `─── ↑ 3 more `. Those markers are collected in one place (`isSolidBorder`,
  `scrollIndicatorText`, `isBorderLike` in `index.ts`) and
  `tests/opl-input-pi-tui-markers.test.mjs` asserts the installed pi-tui still emits them. They
  were byte-identical in pi-tui 0.87.0, 0.99.1 and 1.1.0; a failure there means the format
  changed and the re-framing needs updating, not that the test is wrong.
- **The bundle's idle heartbeat.** This component owns the only render timer, so the footer's
  time-based cells advance because of it. Disabling `opl-input` freezes that clock; with
  `companion.enabled: false` the tick slows to one repaint per `IDLE_REPAINT_MS` rather than
  stopping.
