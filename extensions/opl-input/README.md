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
      "borderColor": "customMessageLabel"
    }
  },
  "companion": {
    "enabled": true,
    "color": "accent",
    "type": "dog",
    "types": [{ "typeName": "dog", "top": " /),(\\ " }]
  }
}
```

| Option | Type | Default | Description |
|---|---|---:|---|
| `boxedView` | boolean | `true` | Full box when true; horizontal rules without side borders when false. |
| `boxPadX` | number | `1` | Horizontal padding inside the editor. |
| `menuGap` | number | `0` | Blank lines between the input bottom border and slash menu. |
| `extraMenuIndent` | number | `1` | Additional indentation for slash-menu lines. |
| `borderColor` | string | `border` | Default border color. |
| `prefix` | string | `❯` | Default first-line prefix. |
| `prefixColor` | string | `accent` | Default prefix color. |
| `planModePrefix` | string | `⏸` | Prefix for plan and execute modes. |
| `planModePrefixColor` | string | `customMessageLabel` | Prefix color for plan and execute modes. |
| `planModeBorderColor` | string | `customMessageLabel` | Border color for plan and execute modes. |
| `chatModePrefix` | string | `»` | Prefix for chat mode. |
| `chatModePrefixColor` | string | `chatModeBorder` | Prefix color for chat mode. |
| `chatModeBorderColor` | string | `chatModeBorder` | Border color for chat mode. |
| `modes.<name>.prefix` | string | unset | Prefix override for any custom `opl-modes` mode. |
| `modes.<name>.prefixColor` | string | unset | Prefix color override for a custom mode. |
| `modes.<name>.borderColor` | string | unset | Border color override for a custom mode. |
| `companion.enabled` | boolean | `false` | Show the animated companion above the input. |
| `companion.color` | string | `accent` | Companion color. |
| `companion.ears` | string | cat ears | Directly override the companion's top line. |
| `companion.type` | string | unset | Select a named entry from `companion.types`; built-in `dog` also has a fallback shape. |
| `companion.types` | array | unset | Named `{ "typeName", "top" }` top-line definitions. |

The companion requires at least 40 terminal columns and reserves three top-padding lines when enabled. Its animation timing and probabilities are source constants, not user configuration.

Mode precedence for input styling is: Bash (`!` input), plan/execute, chat, custom mode, then default. Custom mode styling reads the shared `__agentMode` state published by `opl-modes`; plan and chat use their compatibility globals.

Any valid Pi theme color token works. Six-digit colors such as `#c07898` are also accepted. Invalid theme tokens fall back to the theme's border color.
