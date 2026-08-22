# Changelog

## [0.0.3] - 2026-08-22

- `opl-init`: workspace-aware crawling — `pnpm-workspace.yaml`/`Cargo.toml` member globs get fresh depth-3 walks; per-directory entry cap (40) with omission lines; explicit tree-truncation marker; `turbo.json`/`nx.json` listed as manifests.
- `opl-init`: ingests foreign agent rule sources (Cursor, Copilot, Claude, Windsurf, Cline, Devin) into the `/init` context.
- `opl-input`: fixed custom-mode colors not applying (`EditorTheme` has no `.fg()`; now resolves through the full theme); extracted testable `resolveModeStyle()`.
- `opl-footer`: perf segment shows last user-prompt-to-completion turnaround time after cumulative LLM time.
- `opl-modes`: `modes.<name>.allowExecute` gate (default true) — set false to hide picker `Execute:` items and block `/execute` from that mode; plan-mode action menu unaffected. `allowPlanComplete: true` now works on custom modes (appends the `plan_complete` tool). Documented tool-inheritance sharp edge (no `tools` array = all tools, write-capable).
- Tests: functional fixture tests for opl-init crawl and opl-input style resolution wired into `npm test`; new opl-modes helper tests; smoke assertions extended.
- Docs: all extension READMEs re-audited against source; `research/` notes on rule-source ingestion and crawl depth.

## [0.0.2] - 2026-08-21

- `opl-footer`: session/performance statistics rows (turns, steps, model requests/tools, LLM/tool time, TTFT, tok/s, cache %) with last-turn TAT groundwork.
- `opl-modes`: unified mode manager docs aligned to implementation (commands, flags, custom modes, model overrides).
- Docs: footer README corrected to three rows; installer/config documentation updated.
