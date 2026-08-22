# opl-init

Provides `/init`, which generates or updates a repository `AGENTS.md` agent guide.

## Generated guide

`/init` asks the model for repository-specific information rather than a generic contributor template. Depending on the available evidence, it covers what the project is, commands, architecture, configuration and installation, testing or operational quirks, and key files. It calls out meaningful absent commands and avoids generic Git or pull-request advice unless the repository provides concrete facts.

Depth stays at 3 by design: workspace-member expansion with fresh per-member budgets covers monorepo layouts more surgically than a deeper global walk, which mostly enumerates asset directories. Declared members are always re-walked with a full budget even when the root walk already touched them, because partial coverage must not truncate member internals. Changing crawl limits does not invalidate existing guides — the staleness fingerprint depends only on Git state (or path/size/mtime outside Git), so limit changes take effect on the next stale or missing run.

## How to

`opl-init` has no external configuration file. Its crawl depth, ignored directories, tree limit, manifest list, fingerprinting, and prompt are defined in `index.ts`. Run `/init` from the repository root; it creates or updates `AGENTS.md` only when the embedded fingerprint is missing or stale.

- Crawls the current repository deterministically to depth 3.
- Enumerates declared monorepo workspace members (from `pnpm-workspace.yaml` `packages:` and `Cargo.toml` `[workspace] members` globs) with their own depth-3 walk, so `packages/foo/src` layouts are not penalized by their grouping prefix. `turbo.json` and `nx.json` are reported as manifests for context; package locations come from the package manager's workspace config.
- Limits the directory tree to 300 lines and emits an explicit truncation marker when the cap is hit.
- Caps each directory listing at 40 entries with a stable `... (N more entries omitted)` line.
- Ignores common generated and dependency directories such as `.git`, `node_modules`, `dist`, `build`, `target`, and virtual environments.
- Reports file-extension counts and recognizes common project manifests.
- Includes npm scripts when `package.json` is present.
- Detects instruction files from other coding agents (see below) and includes their content for incorporation.
- Sends compact crawl context to the model instead of embedding full manifest bodies.

`AGENTS.md` is created when missing and updated only when its fingerprint marker is missing or stale. The final line must be:

```html
<!-- opl-init:fp <fingerprint> -->
```

Git repositories use a fingerprint derived from `HEAD` and `git status --porcelain=v1 --untracked-files=all`. This is efficient and respects Git ignore rules, but it does not directly hash every modified file's content. Non-Git repositories use sorted path, size, and modification-time tuples, so touching a file may cause a harmless false stale result.

## Existing agent rule sources

When `AGENTS.md` is missing or stale, `/init` also checks for instruction sources used by other coding agents and lists any it finds in the dispatch context, so their project-specific guidance can be incorporated into the generated guide:

| Source | Harness |
|---|---|
| `.cursorrules` | Cursor |
| `.cursor/rules/` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `.claude/rules/` | Claude Code |
| `.windsurfrules` / `.windsurf/rules/` | Windsurf |
| `.clinerules` | Cline |
| `.devin/rules/` | Devin |

Rule files are included with their first 2048 bytes; rule directories are listed by filename. The prompt instructs the model to fold relevant content into the guide without copying rules verbatim or treating them as authoritative over evidence from this repository. Detection happens only on stale or missing runs, so re-running `/init` on a current `AGENTS.md` still costs nothing. `AGENTS.md` itself is deliberately excluded from this list because it is the command's output.

The crawl is retained in the active Pi transcript through `pi.sendUserMessage`; structured retrieval in an entirely new session is not implemented.
