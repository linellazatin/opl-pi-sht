# opl-init

Generates or refreshes a repository-specific `AGENTS.md` guide through `/init`.

## Commands, flags, and shortcuts

- `/init`: the only interface; there are no flags and unknown args are ignored. If the guide's fingerprint is current it stops and says so - zero model calls. If it is missing or stale: deterministic crawl, one out-of-band model refinement, extension-validated write, then `ctx.reload()` so the running session picks the new guide up.
- No shortcuts.

## Extension features

- Produces a deterministic repository guide with package commands and a file-type inventory, then refines it with **one** `ctx.modelRegistry.streamSimple()` call on the current model (pi >= 0.86.0). The refinement never enters the conversation: no synthetic user message, no turn in the transcript, no `write` tool needed, and read-only/chat/plan modes refine identically.
- The model only sees a bounded evidence packet (the baseline guide, every `package.json`'s full scripts block, and the first ~2 KB of each root/workspace `README`/`CLAUDE.md`, hard 24 KB budget with an explicit truncation line). The crawl is the only explorer.
- The extension owns the fingerprint marker: model output is stripped of fences and any `opl-init:fp` comment, and the exact marker is appended as the final line. A model can never corrupt or fake a "current" guide.
- Refine failure (no model, no auth, provider error, empty output) writes the deterministic baseline and notifies `refine failed` - `/init` only fails to write if the write itself fails.
- Mid-session `/init` waits for the agent to settle (`ctx.waitForIdle()`), recomputes the fingerprint, and only then crawls. It never steers or interrupts the task in flight.
- Crawls to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, caps the rendered tree at 300 lines with explicit omission markers, and re-walks declared `pnpm-workspace.yaml`/Cargo members with their own depth-3 budget.
- Fingerprints dirty tracked + untracked file **contents** (plus HEAD and a generator schema version), excluding the root `AGENTS.md` itself, so writing the guide never makes it immediately stale and re-editing an already-modified file is never read as "current".

## Requirements

Refinement needs pi 0.86.0 or newer (`ctx.modelRegistry.streamSimple`, `ctx.reload`). Run `pi update` first if `/init` reports a refine failure on a machine with configured auth.

## Architecture

`index.ts` owns crawling, fingerprinting, the evidence packet, the model call, output validation, and writing. Git repositories fingerprint `schema version + HEAD + sha256 of every dirty tracked and untracked file` (root `AGENTS.md` excluded); non-git repositories use sorted path/size/mtime tuples. `/init` writes the file itself and reloads the session context; the main agent is never enlisted.
