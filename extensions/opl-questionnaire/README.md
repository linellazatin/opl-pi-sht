# opl-questionnaire

Adds a model-callable interactive questionnaire for discrete choices, preferences, and confirmations.

## Commands, flags, and shortcuts

- Tool: `questionnaire`.
- `↑`/`↓`: move through options; `1`-`9`/`0`: select options 1-10; `Enter`: select or submit.
- Multi-question UI: `Tab`/`Shift+Tab` or `←`/`→` changes tabs; `Esc` cancels or exits custom-answer editing.

## Extension features

- Renders one question as a compact option list and multiple questions as tabs with a final Submit tab.
- Questions require an `id`, prompt, options, and optional label or free-text `allowOther` response.
- Rejects duplicate IDs and questions that cannot be answered; returns `(no response)` for an empty custom answer.
- Returns structured answers containing question ID, selected value and label, custom-text flag, and option index where applicable.
- Blocks submission until every multi-question prompt has an answer.
- Returns a clear error in headless sessions so the model can use plain-text questions instead.

## Configuration

No external configuration file. Availability follows Pi's active tool set: the shipped `opl-modes` chat and plan lists include `questionnaire`; custom modes must list it explicitly.

## Architecture

`index.ts` registers the tool, validates input, renders the custom TUI, and formats results. `types.ts` contains the TypeBox parameter schema and shared question/answer types.
