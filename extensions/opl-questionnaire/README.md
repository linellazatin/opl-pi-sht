# opl-questionnaire

Registers a model-callable `questionnaire` tool for asking one or more questions with selectable options. A single question uses a compact option list; multiple questions use a tabbed interface with a final Submit tab.

## Behavior

- The model receives prompt guidance to use the tool for discrete choices, clarification, preferences, and confirmations instead of listing questions in prose.
- Each question has an `id`, `prompt`, `options`, optional `label`, and optional `allowOther` free-text choice.
- Answers preserve the question ID, selected value and label, whether the user wrote custom text, and the selected option index when applicable.
- Duplicate IDs are rejected before the UI opens because answers are keyed by ID.
- A question with no options and `allowOther: false` is rejected because it cannot be answered.
- Empty custom answers are returned as `(no response)`.
- The tool returns a clear error in non-TUI/headless sessions; the model should fall back to plain-text questions.

## Configuration

`opl-questionnaire` has no external configuration file. Tool schema, prompt guidance, validation, rendering, and keyboard controls are defined in `index.ts`. Availability depends on Pi's active tool set and mode configuration. The default `opl-modes` chat and plan tool lists include `questionnaire`; custom modes must list it explicitly if they need it.

## Controls

- `↑`/`↓`: move through options.
- `1`-`9` and `0`: select options 1-10 directly.
- `Enter`: select or submit.
- `Tab`/`Shift+Tab` or `←`/`→`: switch questions in multi-question mode.
- `Esc`: cancel, or leave custom-answer editing.

Selecting `Type something.` opens an inline editor. Multi-question mode shows answered/unanswered tabs and prevents submission until every question has an answer.

## Files

- `index.ts`: tool registration, validation, custom TUI, and result rendering.
- `types.ts`: TypeBox parameter schema and shared answer/question types.
