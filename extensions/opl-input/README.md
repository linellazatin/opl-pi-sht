# opl-input

Replaces Pi's default chat editor with a mode-aware custom editor. Native editor behavior such as cursor movement, history, autocomplete, paste, and slash-menu handling remains available.

## Features

- **Boxed or unboxed input**: Full `┌─┐`/`│`/`└─┘` framing by default, or horizontal rules only with `boxedView: false`.
- **External configuration**: Settings are loaded from `~/.pi/agent/configs/opl-input.json`, not hard-coded into the extension.
- **Mode-aware styling**: Bash input, plan/execute mode, chat mode, and registered custom modes can each use different border colors and prefixes.
- **Companion animation**: An optional animated three-line ASCII companion appears above the editor, with changing expressions, blinking, drifting, ear movement, and temporary hidden phases.
- **Scroll-aware borders**: Editor scroll indicators are embedded in the top or bottom border when the input has more content than fits.
- **Slash-menu placement**: The slash menu is rendered below the input with configurable gap and indentation.
- **Responsive rendering**: Narrow terminals fall back to the native editor rendering; the companion is hidden below 40 columns.
- **Hex and theme colors**: Color settings accept Pi theme tokens or six-digit hex colors.

## Mode styling precedence

Exactly one style applies at a time, in this order: Bash (`!` input) > plan/execute > chat > custom mode > default. Custom mode styling reads the shared `__agentMode` state published by `opl-modes`; plan and chat use their compatibility globals. A custom mode only needs to define the fields it wants to change — unspecified fields fall back per-field to the defaults.

## Configuration

Create `~/.pi/agent/configs/opl-input.json` or copy [`configs/opl-input.json`](../../configs/opl-input.json). The file is read once when the extension module loads; run `/reload` or restart Pi after changes.

```json
{
  "boxedView": false,
  "boxPadX": 1,
  "menuGap": 0,
  "extraMenuIndent": 1,
  "borderColor": "border",
  "prefix": "❯",
  "prefixColor": "accent",
  "planModePrefix": "⏸",
  "planModePrefixColor": "customMessageLabel",
  "planModeBorderColor": "customMessageLabel",
  "chatModePrefix": "»",
  "chatModePrefixColor": "chatModeBorder",
  "chatModeBorderColor": "chatModeBorder",
  "modes": {
    "audit": {
      "prefix": "⚑",
      "prefixColor": "warning",
      "borderColor": "#c07898"
    }
  },
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
| `borderColor` | color | `"border"` | Default border color. |
| `prefixColor` | color | `"accent"` | Default prefix color. |
| `prefix` | string | `"❯"` | Default first-line prefix. |

### Plan and execute modes

| Option | Type | Default | Description |
|---|---|---:|---|
| `planModePrefix` | string | `"⏸"` | Prefix while plan or execute mode is active. |
| `planModePrefixColor` | color | `"customMessageLabel"` | Prefix color for plan and execute modes. |
| `planModeBorderColor` | color | `"customMessageLabel"` | Border color for plan and execute modes. |

### Chat mode

| Option | Type | Default | Description |
|---|---|---:|---|
| `chatModePrefix` | string | `"»"` | Prefix while chat mode is active. |
| `chatModePrefixColor` | color | `"chatModeBorder"` | Prefix color for chat mode. |
| `chatModeBorderColor` | color | `"chatModeBorder"` | Border color for chat mode. |

### Custom modes (`modes.<name>`)

One entry per custom mode registered by `opl-modes`, keyed by the exact mode name (e.g. `audit`, `review`). Built-in modes (`off`, `chat`, `plan`, `execute`) are handled by the dedicated options above and should not be listed here.

| Field | Type | Default | Description |
|---|---|---:|---|
| `modes.<name>.prefix` | string | falls back to `prefix` | Prefix while this mode is active. |
| `modes.<name>.prefixColor` | color | falls back to `prefixColor` | Prefix color while this mode is active. |
| `modes.<name>.borderColor` | color | falls back to `borderColor` | Border color while this mode is active. |

### Companion

| Field | Type | Default | Description |
|---|---|---:|---|
| `companion.enabled` | boolean | `false` | Show the animated companion above the input. |
| `companion.color` | color | `"accent"` | Companion color. |
| `companion.type` | string | unset | Select a named entry from `companion.types`; built-in `dog` also has a fallback shape (`"cat"` uses the default ears). |
| `companion.ears` | string | cat ears | Directly override the companion's top line; wins over `type`. |
| `companion.types` | array | unset | Named `{ "typeName", "top" }` top-line definitions for use with `type`. |

The companion requires at least 40 terminal columns and reserves three top-padding lines when enabled. Its animation timing and probabilities are source constants in `config.ts`, not user configuration.

### Color values

Every color option accepts either:

- **A Pi theme token** — one of the 45 tokens defined by Pi's `Theme`:
  - Core: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`
  - Messages/content: `thinkingText`, `searchMatchText`, `userMessageText`, `customMessageText`, `customMessageLabel`
  - Tools: `toolTitle`, `toolOutput`, `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`
  - Markdown: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`
  - Syntax: `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`
  - Thinking borders: `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax`
  - Special: `bashMode`
- **A six-digit hex color** — e.g. `"#c07898"` (rendered as ANSI truecolor, downgraded automatically on 256-color terminals).

Invalid theme tokens fall back to the theme's `border` token; invalid hex renders uncolored rather than crashing.
