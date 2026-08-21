# questionnaire

Registers a `questionnaire` tool the model calls to ask the user one or more
questions with selectable options, instead of listing questions in plain text.

- **Single question** — a simple numbered options list.
- **Multiple questions** — a tab bar to navigate between questions, then a Submit tab.

Answers are returned to the model as structured text (which option was selected,
or free text the user typed).

## Configuration

`opl-questionnaire` has no external configuration file. The tool schema, prompt guidance, validation, and keyboard controls are defined in `index.ts`; availability is controlled by Pi's active tool set and mode configuration.

Entirely model-invoked. There is no slash command or keybinding — the LLM decides
to call it. Two things make that happen reliably:

- `promptGuidelines` / `promptSnippet` on the tool registration nudge the model to
  prefer this tool over prose Q&A (appended to the system prompt while the tool is active).
- The tool must be in the active tool set for the current mode. It is included in the
  `mode-switcher` defaults for Plan and Chat modes and in the `audit`/`review` custom
  modes (see `~/.pi/agent/configs/opl-modes.json`). In normal ("off") mode all
  registered tools are active, so it is available there too.

If the tool errors (e.g. a non-interactive/headless session where `ctx.mode !== "tui"`),
the model is instructed to fall back to asking the questions in plain text.

## Controls

- `↑↓` — move selection
- `1`-`9` (and `0` for a 10th option) — jump to and select that numbered option
- `Enter` — confirm selection / submit
- `Tab` / `←→` — switch between questions (multi-question only)
- `Esc` — cancel

Each question may include a "Type something." option (`allowOther`, default true) that
opens an inline editor for a free-text answer.

## Files

- `index.ts` — tool registration, validation, and the custom TUI component
- `types.ts` — shared types and TypeBox parameter schemas

## Validation

`execute()` rejects, before showing any UI:

- duplicate question `id`s (answers are keyed by id and would silently collide)
- a question with no `options` and `allowOther: false` (nothing would be selectable)
