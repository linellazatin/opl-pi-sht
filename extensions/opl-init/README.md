# opl-init

Generates or refreshes a repository-specific `AGENTS.md` guide through `/init`.

## Commands, flags, and shortcuts

- `/init`: crawl the current repository and create or update `AGENTS.md` when its fingerprint is missing or stale.
- No flags or shortcuts.

## Extension features

- Produces a deterministic repository guide with package commands and a file-type inventory.
- Crawls deterministically to depth 3, ignores generated/dependency directories, caps directory listings at 40 entries, and caps the rendered tree at 300 lines with explicit omission markers.
- Re-walks declared `pnpm-workspace.yaml` and Cargo workspace members with their own depth-3 budget.
- Reads known manifests to include package scripts when present.
- Writes the deterministic fingerprinted `AGENTS.md` directly; it never sends synthetic user messages or asks a model to refine the guide.
- Skips the write when the final `<!-- opl-init:fp <fingerprint> -->` marker is current.
- Excludes `AGENTS.md` itself from the Git status fingerprint, preventing the act of updating the guide from making it immediately stale.

## Architecture

`index.ts` owns crawling, fingerprinting, and deterministic guide writing. Git repositories fingerprint `HEAD` plus relevant `git status --porcelain=v1 --untracked-files=all` output, excluding `AGENTS.md` itself; non-Git repositories use sorted path, size, and mtime tuples. `/init` writes its guide locally and does not modify the Pi transcript.
