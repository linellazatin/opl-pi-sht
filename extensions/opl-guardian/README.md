# opl-guardian

Prevents malformed assistant tool calls from entering Pi session history. It runs on every provider and model through Pi's `message_end` hook, removes protocol-invalid calls before Pi persists or replays them, and records each removal as JSON Lines evidence.

>
> This is the first feature that opl-guardian can do for now. If I happen to encounter another error/issue that can be (possibly) fixed via extensions, I might add that up in this extension.
>

## Commands, tools, and configuration

No commands, tools, or configuration. Loading the extension is the entire interface and adds no prompt or tool-schema overhead.

## What it guards

A tool call is malformed when its `id` or `name` is blank after trimming whitespace. Such a record cannot be safely replayed through OpenAI-compatible tool-call APIs: a later provider request may reject it and block the session until its history is abandoned.

`opl-guardian` does not reject an unfamiliar but non-empty tool name. That is a normal model/tool-resolution error, not an invalid protocol envelope.

| Assistant response | Guardian behavior |
| --- | --- |
| No malformed calls | Leaves the response unchanged. |
| Valid and malformed calls | Drops only malformed calls, preserves valid calls and `toolUse`, appends a diagnostic, and lets Pi execute the valid calls normally. |
| Only malformed calls | Removes every call, returns a text-only `stop` response, and tells the user to send another prompt. |

When a UI is available, every incident also produces a warning notification.

## Forensic JSONL

Each incident appends one JSON object to:

```text
<project cwd>/err/guardian.jsonl
```

A record includes timestamp, session ID, project CWD, provider, model, response ID when available, and the removed `toolCall` blocks. It does not log prompts, assistant text, thinking, or tool results.

Tool-call arguments can still contain project paths, commands, or user text. Add `err/` to the project’s version-control ignore policy if it is not already ignored, and treat the file as local diagnostic data.

If the log write fails, guardian still removes the malformed calls. The session diagnostic and UI warning report that the forensic file could not be written rather than claiming it was saved.

## Architecture

```text
guardian.ts  Pure malformed-call filter and JSONL incident-record builder.
index.ts     Pi message_end handler, project-local JSONL append, UI notification.
```

The extension has no runtime dependencies. Run its checks with:

```bash
npm run test:opl-guardian
```
