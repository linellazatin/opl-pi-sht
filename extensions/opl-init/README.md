# opl-init

Provides `/init`, which generates or updates a repository `AGENTS.md` agent guide.

## Generated guide

`/init` asks the model for repository-specific information rather than a generic contributor template. Depending on the available evidence, it covers what the project is, commands, architecture, configuration and installation, testing or operational quirks, and key files. It calls out meaningful absent commands and avoids generic Git or pull-request advice unless the repository provides concrete facts.

## Configuration

`opl-init` has no external configuration file. Its crawl depth, ignored directories, tree limit, manifest list, fingerprinting, and prompt are defined in `index.ts`. Run `/init` from the repository root; it creates or updates `AGENTS.md` only when the embedded fingerprint is missing or stale.

- Crawls the current repository deterministically to depth 3.
- Limits the directory tree to 300 lines.
- Ignores common generated and dependency directories such as `.git`, `node_modules`, `dist`, `build`, `target`, and virtual environments.
- Reports file-extension counts and recognizes common project manifests.
- Includes npm scripts when `package.json` is present.
- Sends compact crawl context to the model instead of embedding full manifest bodies.

`AGENTS.md` is created when missing and updated only when its fingerprint marker is missing or stale. The final line must be:

```html
<!-- opl-init:fp <fingerprint> -->
```

Git repositories use a fingerprint derived from `HEAD` and `git status --porcelain=v1 --untracked-files=all`. This is efficient and respects Git ignore rules, but it does not directly hash every modified file's content. Non-Git repositories use sorted path, size, and modification-time tuples, so touching a file may cause a harmless false stale result.

The crawl is retained in the active Pi transcript through `pi.sendUserMessage`; structured retrieval in an entirely new session is not implemented.
