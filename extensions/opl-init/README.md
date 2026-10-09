# opl-init

Generates or refreshes a repository-specific `AGENTS.md` guide through `/init`.

## Commands, flags, and shortcuts

- `/init`: the only interface; there are no flags and unknown args are ignored. If the guide's fingerprint is current it stops and says so - zero model calls. If it is missing or stale: deterministic crawl, one out-of-band model refinement, extension-validated write, then `ctx.reload()` so the running session picks the new guide up.
- No shortcuts.

## Extension features

- Produces a deterministic repository guide with package commands and a file-type inventory, then refines it with **one** `ctx.modelRegistry.streamSimple()` call on the current model at `reasoning: "minimal"` (pi >= 0.86.0). The refinement never enters the conversation: no synthetic user message, no turn in the transcript, no `write` tool needed, and read-only/chat/plan modes refine identically. `"minimal"` is the lowest thinking level pi-ai accepts; an earlier `{ reasoning: false }` read as *unset*, so the call silently paid the provider's default thinking level.
- The model only sees a bounded evidence packet (the baseline guide, every `package.json`'s full scripts block, and the first ~2 KB of each root/workspace `README`/`CLAUDE.md`, hard 24 KB budget with an explicit truncation line). The crawl is the only explorer.
- The extension owns the fingerprint marker: model output is stripped of fences and any `opl-init:fp` comment, and the exact marker is appended as the final line. A model can never corrupt or fake a "current" guide.
- Refine failure (no model, no auth, provider error, empty output) writes the deterministic baseline and notifies `refine failed` - `/init` only fails to write if the write itself fails.
- Mid-session `/init` waits for the agent to settle (`ctx.waitForIdle()`), recomputes the fingerprint, and only then crawls. It never steers or interrupts the task in flight.
- Crawls to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, caps the rendered tree at 300 lines with explicit omission markers, and re-walks declared `pnpm-workspace.yaml`/Cargo members with their own depth-3 budget.
- Crawls to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, caps the rendered tree at 300 lines with explicit omission markers, and re-walks declared `pnpm-workspace.yaml`/Cargo members with their own depth-3 budget. Workspace globs are compiled by escaping every metacharacter except `*` and `?`, because real member patterns carry them (`packages/app(one`, `libs/c++/*`); an unescaped one threw `SyntaxError` and aborted the entire crawl. A glob that compiles to nothing is skipped instead, reported in `Crawl.skippedGlobs`, and named in a tree line so the skip is visible in the guide.
- Fingerprints dirty tracked + untracked files (plus HEAD and a generator schema version), excluding the root `AGENTS.md` itself, so writing the guide never makes it immediately stale and re-editing an already-modified file is never read as "current". Content hashing is **budgeted** (`FP_LIMITS`: 2 MB per file, 32 MB total, 5,000 paths): past the per-file or total ceiling a file contributes `name|size|mtime` instead of its bytes, and past the path ceiling a path contributes its name plus `OVER_CAP`. Budget state is folded into the digest, so the fingerprint cannot oscillate. Without the ceilings a single 200 MB build artifact cost 143 ms and +200 MB of RSS on every `/init`.

## Requirements

Refinement needs pi 0.86.0 or newer (`ctx.modelRegistry.streamSimple`, `ctx.reload`). Run `pi update` first if `/init` reports a refine failure on a machine with configured auth.

## Architecture

Every `git` call goes through one guard. A repository is attacker-chosen data and can declare programs of its own (`[diff "x"] textconv`, `core.fsmonitor`, `core.hooksPath`, or a system/user config naming a helper) that git runs while answering what looks like a read-only query. The guard passes `--no-pager`, `-c core.fsmonitor=false`, `-c core.hooksPath=`, `-c protocol.ext.allow=never`, `-c credential.helper=`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`, plus `--no-ext-diff --no-textconv` on diff-family subcommands. Probes still ask for name-only or porcelain output, because that is all a fingerprint needs. The block is duplicated in `opl-footer/git-status.ts` - installs are per-directory, so the two cannot share a module - and `tests/net-guard-parity.test.mjs` fails if the copies drift.

`index.ts` owns crawling, fingerprinting, the evidence packet, the model call, output validation, and writing. Git repositories fingerprint `schema version + HEAD + a budgeted digest of dirty tracked and untracked files` (root `AGENTS.md` excluded, content replaced by `size|mtime` past the byte ceilings); non-git repositories use sorted path/size/mtime tuples. `gitOutput` caps captured output at 4 MB because every probe asks for path lists or a single value. `/init` writes the file itself and reloads the session context; the main agent is never enlisted.
