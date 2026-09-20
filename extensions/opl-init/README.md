# opl-init

Generates or refreshes a repository-specific `AGENTS.md` guide through `/init`.

## Commands, flags, and shortcuts

- `/init`: crawl the current repository and write `AGENTS.md` when its fingerprint is missing or stale. A stale guide is **overwritten** wholesale, hand-edited prose included; version control is the recovery path.
- `/init --refine`: same write, then one injected user turn asking the model to expand the guide into a fuller, evidence-based version. Opt-in only: plain `/init` never touches the transcript.
- No shortcuts.

## Extension features

- Produces a deterministic repository guide with package commands and a file-type inventory.
- Crawls deterministically to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, and caps the rendered tree at 300 lines with explicit omission markers.
- Re-walks declared `pnpm-workspace.yaml` and Cargo workspace members with their own depth-3 budget.
- Reads known manifests to include package scripts when present.
- Writes the deterministic fingerprinted `AGENTS.md` directly. It sends no synthetic user message on its own; `/init --refine` is the single, explicit request for a model-refined guide.
- Skips the write when the final `<!-- opl-init:fp <fingerprint> -->` marker is current.
- Excludes `AGENTS.md` itself from the Git status fingerprint, preventing the act of updating the guide from making it immediately stale.

## Session timing, reiterations, and re-injections

`/init` is an initialization command: run it at the **start** of a session, before the work begins, and again at the **very end** to fold the session's changes into the guide before pushing to the remote. Both are quiet moments, and `--refine` needs a quiet moment.

What a `--refine` injection does to a live session:

- It is a **user-role turn**. It is persisted in the session and replayed as context on every later turn and on resume, so two `--refine` runs in one session leave two instruction blocks behind and the transcript keeps paying for both.
- It **always triggers a turn**. With an idle agent the refinement starts immediately. With an agent already streaming it is queued as a follow-up (`deliverAs: "followUp"`), so the guide is rewritten *after* the current turn finishes — later than you asked, and possibly after you have moved on to something else. An injection with no `deliverAs` makes Pi throw `Agent is already processing` and the request is lost.
- It **cannot be fulfilled in a read-only mode**. Chat and plan modes carry no `write` tool, so the model can only describe the guide it was asked to write: the turn is spent and `AGENTS.md` stays at the deterministic baseline. Run `--refine` in normal (OFF) mode.
- In **execute mode it ends the plan**. `opl-modes` leaves execute mode when a turn completes without `plan_complete`, so the refinement turn finishing drops the session to OFF mid-plan.
- A refined guide is **not sticky**. The fingerprint is `HEAD` plus `git status`, so the next commit or dirty file makes the guide stale, and the next plain `/init` overwrites the refined prose with the baseline. Refine last, then commit `AGENTS.md`; if you refine and keep working, expect to refine once more at the end of the session.
- The refinement's own write does **not** invalidate the marker: `AGENTS.md` is filtered out of the status fingerprint, so a successful `--refine` leaves `/init` reporting "current".
- There is **no recursion and no automatic re-injection**. The message is sent with `expandPromptTemplates: false`, so a `/init` appearing inside it is not re-dispatched, and the extension registers no event handlers: every injection comes from you typing `--refine`.

## Architecture

`index.ts` owns crawling, fingerprinting, and deterministic guide writing. Git repositories fingerprint `HEAD` plus relevant `git status --porcelain=v1 --untracked-files=all` output, excluding `AGENTS.md` itself; non-Git repositories use sorted path, size, and mtime tuples. `/init` writes its guide locally and leaves the Pi transcript alone; `--refine` adds one small user message that points the model at the written file instead of re-sending the crawl.
