# opl-init

Generates or refreshes a repository-specific `AGENTS.md` guide through `/init`.

## Commands, flags, and shortcuts

- `/init`: crawl the current repository and create or update `AGENTS.md` when its fingerprint is missing or stale.
- No flags or shortcuts.

## Extension features

- Produces evidence-based guidance for project purpose, commands, architecture, configuration, testing, operational quirks, and key files.
- Crawls deterministically to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, and caps the rendered tree at 300 lines with explicit omission markers.
- Re-walks declared `pnpm-workspace.yaml` and Cargo workspace members with their own depth-3 budget; reports `turbo.json` and `nx.json` as contextual manifests.
- Collects extension counts, known manifests, and npm scripts without embedding full manifest bodies.
- Incorporates relevant Cursor, Copilot, Claude Code, Windsurf, Cline, and Devin rule sources without copying them verbatim or treating them as more authoritative than repository evidence.
- Writes a deterministic baseline `AGENTS.md` before dispatching the model turn, so lower-capability models cannot leave the guide only in chat; the model is then prompted to refine it with repository-specific guidance and verify the file.
- Skips the model turn when the final `<!-- opl-init:fp <fingerprint> -->` marker is current.
- Excludes `AGENTS.md` itself from the Git status fingerprint, preventing the act of updating the guide from making it immediately stale.

## Architecture

`index.ts` owns crawling, fingerprinting, baseline writing, foreign-rule discovery, and prompt dispatch. Git repositories fingerprint `HEAD` plus relevant `git status --porcelain=v1 --untracked-files=all` output, excluding `AGENTS.md` itself; non-Git repositories use sorted path, size, and mtime tuples. Crawl context remains in the active Pi transcript only; cross-session structured retrieval is not implemented. The model prompt explicitly requires a write-tool call and a read-back verification, but the baseline write is the reliability boundary.
