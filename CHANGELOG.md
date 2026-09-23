# Changelog

## [0.2.5] - 2026-09-24

### Added

- **`opl-webaccess` configurable content caps**: `maxContentChars` caps the initial `web_search`/`fetch_content` body (default 30000), and `maxRetrievalChars` caps one `get_search_content` page (default 30000). `get_search_content` gains an `offset` parameter and returns continuation metadata, so a single retrieval no longer dumps the whole stored body into context.
- **`opl-browser` configurable retrieval cap**: `getChars` limits one `action: get` page (default 30000), with an `offset` parameter and continuation metadata for paged retrieval.

### Changed

- **`opl-footer`** `context_pct` now reads Pi's canonical `ctx.getContextUsage()` and renders an explicit `(--%)` when usage is unknown (right after compaction or a context edit), instead of reconstructing a possibly-stale percentage from the last assistant usage.
- **`opl-modes`** plan loading now appends a TUI-only custom entry via `registerEntryRenderer`, keeping the plan out of the model context; the execute-mode system prompt remains the single model-facing copy.
- **Dev dependency floor**: `@earendil-works/pi-coding-agent` is now `^0.87.0` (was pinned to `0.87.0`).

### Tests

- **`opl-footer`** git-probe back-off test now injects a clock via `setClock` and asserts TTL invariants instead of a wall-clock-sensitive probe count, making it deterministic.

### Added

- **Pi 0.87.0 host-loader smoke:** `npm run test:pi-host` loads all 11 package extension entrypoints through Pi's real `discoverAndLoadExtensions()` API and fails on any loader error. The test is part of `npm test`, so it runs in CI and release validation.

### Changed

- Added `@earendil-works/pi-coding-agent` **0.87.0** as a development-only dependency for the real-loader smoke. Distributed package host peers remain `"*"`, as Pi's package documentation requires.

## [0.2.3] - 2026-09-22

### Changed

- **`opl-modes`** (Pi **0.87.0** compatibility): `execute-mode` auto-exit moved from `agent_end` to the new `agent_before_settle` boundary. 
  - In Pi 0.87.0 `agent_end` fires when the low-level run ends but Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages, so exiting execute mode there could drop the session out of execute mode early. 
  - `agent_before_settle` fires only after that automatic work settles, so execute mode now survives retries/recovery and queued follow-ups and exits on the final `outcome === "completed"`. 
  - Plan-text extraction stays on `agent_end` (it needs `event.messages`, which the settle boundary does not expose).

### Tests

- **`opl-modes-lifecycle.tests.mjs`** (Pi **0.87.0** compatibility): Renamed/focused the test to fire agent_before_settle with outcome: "aborted" | "error" | "completed" instead of fake `agent_end` message payloads.
  - Dropped the obsolete "no assistant message" case (tied to the old stopReason read).

## [0.2.2] - 2026-09-21

### Added

- **`opl-guardian`**: removes assistant tool calls with blank IDs or names at Pi's `message_end` boundary before they persist or replay. Each removal is recorded in `<cwd>/err/guardian.jsonl`; valid sibling calls continue, while invalid-only responses become a clean stop that can be followed by another prompt.
  - This is the first feature that opl-guardian can do for now. If I happen to encounter another error/issue that can be (possibly) fixed via extensions, I might add that up in this extension.

## [0.2.1] - 2026-09-20

### MAJOR CHANGE - opl-init: single flagless /init, out-of-band model refinement

Enabled by pi 0.86.0, which exposed `ctx.modelRegistry.stream()/streamSimple()` for extension model calls through configured providers with resolved auth, plus `ctx.reload()` and `ctx.waitForIdle()`. opl-init v0.2.1 uses them to retire every synthetic user message.

- **`opl-init`**: `/init` is now one command with no flags. Stale guide -> deterministic crawl -> **one** `streamSimple()` refinement on the **current model** with a bounded evidence packet (baseline guide + full per-package scripts blocks + README/CLAUDE heads, 24 KB budget) -> the extension validates the output (strips fences and any model-smuggled markers, appends its own fingerprint marker) -> writes `AGENTS.md` -> `ctx.reload()` so the session actually runs on the new guide. No `deliverAs: "followUp"`, no user-role turn, no persisted prompt replay on every later turn and on resume, and the main agent's `write` tool is no longer required (chat/plan/read-only modes refine fine). Current fingerprint -> zero model calls.
- **`opl-init`**: mid-session `/init` waits (`ctx.waitForIdle()`), recomputes the fingerprint (the settling run may have changed the tree), and only then crawls. It never steers or interrupts the task in flight.
- **`opl-init`**: **breaking** - `/init --refine` is gone; refine is the default and the only path. Unknown args are ignored.
- **`opl-init`**: fingerprint v2 hashes actual dirty content (per-file sha256 over `git diff HEAD --name-only` + untracked files) instead of `git status` lines, so re-editing an already-`M` file no longer leaves the guide reading "current". A `GUIDE_SCHEMA_VERSION` input means generator upgrades invalidate old guides. Only the root `AGENTS.md` is excluded now; subdirectory `AGENTS.md` files count.
- **`opl-init`**: `package.json` parsing reads up to 256 KB (the 2 KB cap applied to *parsing* before, silently losing scripts on moderate manifests), workspace scripts aggregate root-first with per-package labels instead of first-package-wins, and re-walked workspace members no longer double-count the file-type inventory.
- **tests**: `npm run test:opl-init` now runs three suites: the content-fingerprint test drives a throwaway git repo; flow tests run the real handler against fake pi/ctx (never call the model, marker smuggling, idle-gate recalculation, reload exactly once); the smoke assertion now requires `sendUserMessage` to be absent from the source.

## [0.2.0] - 2026-09-20

### MAJOR FIX - prevented multi-message 'user-labeled' prompts on /init invoke (opl-init should just initialize context file, not continuously inject)

- **`opl-init`**: `/init` now writes or refreshes its fingerprinted `AGENTS.md` directly, without sending a synthetic user message or asking a model to refine the guide.

### Security hardened

- **`opl-modes`**: the read-only Bash allowlist gained the three pure stdout filters it was missing (`uniq`, `tr`, `cut`) and stopped treating a redirect into `/dev/null` as a file write, so `ls -l 2>/dev/null` and `du -sh . > /dev/null` work in chat and plan mode again. `uniq` is the exception that keeps a guard: its second operand is an output file, so `uniq -c in.txt out.txt` is blocked while `uniq -c sorted.txt` stays a read. Interpreters and write-capable filters (`awk`, `sed`, `xargs`, `perl`, `python`, `env`) remain unlisted on purpose - they can write files, exec programs, or leak the environment.
- **`opl-modes`**: a second re-audit of the same gate closed four more holes. The `/dev/null` redirect exception matched by **prefix**, so `cat f > /dev/null/../tmp/pwn` and `cat f > /dev/nullfoo` wrote real files while looking like a null redirect; the target now has to end at a token boundary. Three safe-listed commands could still exec or write through a flag: `fd -x`/`-X` (including short-flag clusters like `-Hx`) run a command per match, `tree -o` writes an output file exactly like `sort -o`, and `rg --pre CMD` runs CMD on every file it searches. `jq` could also dump the process environment (`jq -n env`, `jq -n '$ENV'`), which is the very reason `env`/`printenv` are not safe-listed; those forms are now blocked, at the cost of over-blocking a JSON key literally named `env`. `rg --pre` therefore moves out of the documented limitations list. `fd -t f`, `tree -L 2`, `grep -x`, `sort -c`, `jq -r '.items[]'`, and `rg -n` stay allowed. Policy is now 42 safe / 18 destructive entries, with the `.sample` config and `tests/opl-modes-helpers.test.mjs` carrying the same cases.
- **`opl-modes`**: the read-only Bash allowlist is now checked **per shell segment** instead of only against the start of the command line. `&&`, `||`, `;`, `|`, newlines, `$(...)`, backticks, and `<(`/`>(` each begin a segment and every segment must be safe-listed, so `cat f && node -e '...'`, `ls; python -c '...'`, `echo x && sed -i ...`, `cat "$(rm -rf /tmp/x)"`, and `sort -o out in` no longer ride the first command's allowance. Quoted string contents are not separators, so `grep "a|b"` is still one command (the next bullet covers what a quoted string may still hide).
- **`opl-modes`**: destructive defaults are anchored to command position and matched per segment, so read-only commands that merely mention a dangerous word in an argument are allowed again (`du -sh`, `find . -name '*.sh'`, `ls cp/`, `cat mv.sh`, `git log --grep=rm`, `grep -rn 'touch' src`, `git branch -a`). `git branch -` tightened to `-[dDmM]`, `--delete`/`--exec`/`--exec-batch` now caught, `sort -o` and `<(`/`>(` substitution added. Obfuscation is still blocked: every pattern is tested against the command and each segment, raw and quote/backslash-stripped (`r"m"`, `-del"ete"`). 25 entries became 12; the `.sample` config and both `_comment` keys were updated to match. A re-audit of that gate closed three holes in it: a **lone `&` now starts a segment**, so `cat x & rm -rf /tmp/x` cannot background a command the allowlist never saw; segment scanning is **quote-aware instead of quote-blinding**, so a `$(...)` or backtick payload inside double quotes still gets checked (`echo "$(node -e ...)"`) while `grep "a|b"` stays one command; and the blocklist gained the **write flags that hide behind safe commands** (`find -fprint`/`-fprintf`/`-fls`, any `--output` file, `sort -o` in any argument position, `npm audit fix`, the writing `git remote` subcommands, `>&file`), taking it from 12 entries to 14. `2>&1`, `>&2`, `-print`, and `-printf` to stdout stay allowed, and `git rev-parse` joined the safe list so `cat "$(git rev-parse HEAD)"` keeps working. Caveat for anyone whose live `opl-modes.json` copies the pattern lists: they are replace-only, so a copied list overrides every future hardening - delete `bashPatterns.safePatterns`/`destructivePatterns` to inherit the built-in policy.

### Changed

- **`opl-footer`**: the `cost` segment shows four decimals (`$0.0123`), so a cheap or local session reads as a real number instead of `$0.00`.
- **`opl-input`**: the render timer this component owns is the bundle's only periodic repaint, and it ran at 100 ms whether or not the companion was visible. With `companion.enabled: false` (the default) it now ticks once per second instead of ten times, cutting idle TUI repaints by ~90 %. The 100 ms cadence stays while the companion is enabled, and the slower tick still advances the footer's elapsed and tokens-per-second cells, which read wall-clock time.
- **`opl-modes`**: the plan menu's Refine entry no longer implies a limit that was never enforced. It counted against an unenforced `MAX_REFINE_CYCLES = 5` and then said "consider saving"; the constant is gone and the label simply reports the count (`Refine (3 cycles so far)`).

### Added

- **`opl-modes`**: `modes.off.tools` pins the resting (OFF) tool set, so `load_tools`-escalated lazy tools (`subagent`, `browser`, `simplebench`, ...) can be kept out of normal mode deliberately instead of being available because OFF inherits everything.
- **`opl-modes`**: `/mode <name>` now accepts any registered mode, so config-defined modes (`/mode review`, `/mode research`) work like the picker entries; `execute` explains that it needs `/execute`, disabled modes report `enabled: false`, and the unknown-mode warning lists the real choices. Command description updated to `… · /mode <custom>`.
- **`opl-modes`**: a mode listing an unknown tool name now warns once per session (`modes.<name>.tools: unknown tool "x" is ignored by Pi`) instead of Pi silently shrinking the mode's tool set.
- **`opl-modes`**: the bundled `research` mode prompt tells the model to `load_tools` first when `subagent`/`subagent_wait`/`browser` are withheld by `lazyTools`, so the fan-out instructions are actually executable.
- **`opl-init`**: `/init --refine` brings back the model-refined guide as an **opt-in** single request. Plain `/init` stays a pure local write (no injected user turn, no forced model turn); `--refine` writes the same deterministic baseline and then queues one small user message pointing the model at the file, instead of re-sending the whole crawl. The injection uses `deliverAs: "followUp"`, because Pi throws `Agent is already processing` for an injection with no delivery mode while a turn is streaming. `tests/opl-init-crawl.test.mjs` covers the three cases: plain `/init` injects nothing, a stale guide is overwritten while a current one is left alone, and `--refine` sends exactly one queued message carrying the marker.
- **`opl-init`**: the extension README now documents when to run it and what a mid-session `--refine` costs. `/init` is an initialization command: session start, and once more at the very end before pushing. Mid-session the injected turn is a persisted user-role message replayed on every later turn and on resume; it fires *after* the turn in flight; chat and plan modes cannot fulfil it (no `write` tool, so the turn is spent and the guide stays at the baseline); in execute mode the completed refinement turn makes `opl-modes` drop the plan to OFF; and a refined guide is not sticky, because the next commit makes the fingerprint stale and the next plain `/init` overwrites the refined prose. There is no recursion (`expandPromptTemplates: false`) and no event handler, so every injection is one you typed.
- **tests**: `tests/opl-modes-lifecycle.test.mjs` mounts the real `opl-modes` extension against a fake Pi host (the host package is stubbed at build time into gitignored `tests/.build/`), which covers the state this repo could not reach through exported helpers alone: pinned-OFF tool snapshots, resume into a pinned OFF, an unknown newest mode restoring nothing, mode-model capture/release across two entries, and the `agent_end` execute rules. It runs inside `npm run test:opl-modes`.

### Fixed

- **`opl-modes`**: entering OFF with `modes.off.tools` pinned no longer leaves the previous mode's tool snapshot behind. The pinned set replaces it, so a later mode with no `tools` list inherits the pinned baseline instead of silently widening back to whatever was active before the first mode.
- **`opl-modes`**: session restore treats the **newest** `mode-switcher` entry as the verdict. An entry naming a mode that is no longer registered restores nothing (the session falls back to normal mode) instead of digging up an older entry and resuming a `chat` or `execute` mode the user had already left.
- **`opl-modes`**: entering plan mode from the picker's `Execute:` entries, `/plan <name>`, the plan loader, and the resume paths honors `modes.plan.tools`; those five sites hardcoded the shared default list, so a built-in override applied only to `/plan` with no arguments.
- **`opl-modes`**: an errored turn no longer counts as a finished execution. The `agent_end` auto-exit requires a completed assistant turn, so `aborted` (ESC), `error`, and the no-message case all keep execute mode instead of dropping a half-executed plan.
- **`opl-modes`**: `/mode <unknown>` lists `off` among the valid arguments, which it accepts.
- **`opl-modes`**: `allowPlanComplete` now works end to end. The gate let a custom mode call `plan_complete` while the tool body and the result handler still hard-checked for execute mode, so the flag's whole purpose (finishing from a custom mode) answered "plan_complete is only available in execute mode" every time. All three paths now use one `planCompleteAllowed()` predicate — the same one that decides whether the tool is in the mode's list — so a custom mode with the flag cleans up the plan and exits to OFF exactly like execute mode.
- **`opl-modes`**: an unrestorable model restore point is released instead of kept forever. A restore target no longer in the registry is dropped at once; one that exists but has no credentials is retried once and then released, so a stale point cannot block later captures indefinitely. A switch superseded by a newer one (the queue resolves `undefined`) never counts as a failure.
- **`opl-modes`**: ESC before the first token now also keeps execute mode. Pi emits an assistant message with `stopReason: "aborted"` (via `message_start`/`message_end`/`turn_end`) even when nothing streamed, so the auto-exit check sees the abort in every case.
- **`opl-modes`**: only `plan` and `execute` publish a non-off `__planMode`, so entering a custom mode no longer makes the footer's legacy `plan_mode` segment report `Plan mode: ON`.
- **`opl-modes`**: `unrestrictedBash` is honored when **overriding a built-in mode** (`modes.chat.unrestrictedBash` etc.), not only for new custom modes; it previously merged silently into an unused field.
- **`opl-modes`**: a blank or partial `model` (`{ "provider": "", "id": "" }`, `{}`) is normalized to "no override" instead of warning `Model not found: /`, leaving the mode model in place, and skipping the restore of the previous model. Blank now behaves like omitting the key, so a blank `modes.off.model` lets `--model` and the configured default stand.
- **`opl-modes`**: mode entry snapshots the **active** tool set rather than every registered tool, and the restore/execute/session-restore paths use it too, so exiting a mode can no longer widen the set beyond what was active before it.
- **`opl-modes`**: the model restore point is persisted in the `mode-switcher` session entry, so `/reload` or `/resume` inside a mode restores the real pre-mode model instead of recording the mode's own model as the restore point.
- **`opl-modes`**: ESC during execution no longer drops the session out of execute mode. `agent_end` auto-exit now checks the last assistant message's `stopReason`: an aborted turn keeps execute mode (resumable via `/execute`), while a completed turn that never called `plan_complete` still exits as before.
- **`opl-modes`**: `allowPlanComplete: true` on a custom mode with **no** `tools` list now activates `plan_complete` (it was allowed by the gate but never active, so the mode could not finish), and `withPlanComplete()` is applied on the session-restore path, so resume keeps the tool.
- **`opl-modes`**: a plan name must contain a letter or digit. `sanitizePlanName()` accepted punctuation-only input (`"."`, `"--"`, `". ."`), which created `plan-.md` with an empty display title; those are now rejected like any other invalid name.
- **`opl-modes`**: removed the unused `resetRefineCount()` export from `state.ts` (never called; the refine count resets with the state transition itself).
- **`opl-input`**: `startRenderTimer()` takes its period, with the disposer and both cadences asserted in `tests/opl-input-style.test.mjs`.
- **`opl-input`**: the chat fallback style used `chatModeBorder`, which is not a Pi theme token, so chat's border and prefix rendered in the plain `border` color on built-in themes; now `borderAccent`. Configure `modes.chat.appearance` (or add the token to a custom theme) to keep your own color.
- **`opl-input`**: the mode `prefix` is clamped to one terminal cell; a wide `appearance.prefix` previously pushed the box border one cell past the editor width and misaligned continuation lines.
- **`opl-footer`**: `applyColor()` and `resolveColorToRgb()` no longer propagate Pi's `Unknown theme color` throw. A bad token in `opl-footer.json` `colors`, in an `opl-modes` `appearance.modeColor`, or a malformed hex now renders that text uncolored instead of failing every footer render.
- Removed the dead `isSafeCommand()` helper (the handler had its own copy of the logic); `tests/opl-modes-helpers.test.mjs` gained segment, anchor, `unrestrictedBash`, blank-model, and restore-point persistence checks; `tests/opl-input-style.test.mjs` updated for the chat token.
- **`opl-footer`**: `formatTokens()` lost two dead branches that returned the same string as their neighbours (`n < 10000` and `n < 10000000`); behaviour is unchanged and the boundaries are now asserted.
- **`opl-footer`**: the thinking-level fallback `thinkingLevelFromSession || pi.getThinkingLevel()` was unreachable because the reduce was seeded with the truthy string `"off"`, so a branch with no `thinking_level_change` entry displayed `off`. Seeding is now `null` and the live Pi level is used in that case.
- **`opl-footer`, `opl-input`, `opl-modes`**: three-digit hex (`#abc`) is expanded to `#aabbcc` in every color path (footer text, footer context-bar RGB, input borders/prefix, mode labels). Previously it rendered uncolored with a stray `\x1b[0m` reset in footer/input and plain text in modes.
- **`opl-footer`**: a directory that is not a git repository no longer costs one `git` spawn per second forever. The first failed probe arms a 30 second back-off; `git init`/`git clone` (added to the tool-result matchers) and `write`/`edit` invalidations clear it immediately, and a probe that fails inside a real repository is confirmed with `git rev-parse --is-inside-work-tree` so a locked index keeps the normal cadence instead of being mistaken for "not a repo".
- **`opl-footer`**: git probing is skipped entirely when no configured row contains the `git` segment, so a layout that never shows branch/dirty counts pays nothing for it.
- **`opl-footer`**: a git probe that fails *after* an invalidation is discarded. The stale failure used to arm the 30 second not-a-repo back-off right behind `git init`'s clean-up, hiding a freshly created repository for half a minute.
- **`opl-footer`, `opl-input`**: a malformed hex (`#nope`) renders the text with no escape sequence at all. It kept emitting a stray `\x1b[0m` reset that the changelog and both READMEs said was gone.
- **`opl-footer`, `opl-modes`**: two strict-TypeScript errors in the changed paths - `mode_switcher` passed an untyped `appearance.modeColor` into a `ColorValue` parameter, and `createLatestModelQueue()` typed its chain tail as `Promise<void>` while returning `T | undefined`.
- **`opl-browser`, `opl-todo`, `opl-simplebench`**: the remaining strict-TypeScript errors are gone (optional `selector` used without narrowing in `browser_capture`, an unnarrowed content-block fallback in the `todo` result renderer, and `streamSimple()`'s branded `TranscriptContext` / `AgentToolResult.details` / `RunArtifact.suite` shapes). `tsc --strict --noEmit` over `extensions/**/*.ts` is now clean.
- **`opl-simplebench`**: an Ollama run recorded `requestCount: 1`, `retryCount: 0`, and no time-to-first-token because the two chat helpers returned only `{ response, elapsedMs }` while the metrics layer asked for fields that were never there. The retry loop's attempt count and the stream's first-token timestamp are now returned, so artifacts show real retries and TTFT instead of defaults.
- **`opl-simplebench`**: `/simplebench` injected its report with `display: { type: "content", content: report }`, but Pi's `sendMessage()` takes a **boolean** `display`, so every report entry was persisted with a malformed field; now `display: true`.
- **`opl-simplebench`**: removed the `detailedHelp` command option (a 20-line usage block). Pi's `RegisteredCommand` has no such field, so it was never rendered anywhere; `/simplebench --help`, handled in the command body, is and stays the real help path.
- **`opl-simplebench`**: `/simplebench <Tab>` model completions were missing the required `value`, so accepting a suggestion inserted nothing into the input.
- **`opl-simplebench`**: `util/providers.ts` imported `PiExtensionContext` from `../../../shared/types`, a path that does not exist in this package (a type-only import, so nothing failed until a typecheck). It now declares the single field provider detection reads.
- **`opl-simplebench`**: reasoning rows carried `details: scored.details`, a field `scoreReasoning()` does not return, so each row wrote `undefined`; removed.

## [0.1.21] - 2026-09-17

### Fixed
- **`opl-todo`**: a schema-rejected call (`details: {}`) crashed the TUI on every render and made the session unresumable; it also aborted `session_start` before the widget overlay mounted (no widget, dead `ctrl+alt+t`). All render/reconstruct paths now guard malformed results, missing or partial args, and empty lists.
- Added `tests/opl-todo-render.test.mjs` regression check (wired into `npm run test:opl-todo`).

## [0.1.20] - 2026-09-14

### Added
- `cacheReadSegment` (cache_read) & `cacheWriteSegment` (cache_write) text labels (e.g. *Read* 27.09M / *Write* 1.40M)
- **`/configure-opl`**: six-tab footer segment, separator, and reorder configurator with immediate apply.
- **`status` footer segment**: `Working`, `Waiting` during Pi tool execution, and `Ready` when the agent settles.

### Fixed
- **`opl-modes`**: serialize mode-model changes, fail safe on malformed per-mode Bash patterns, and honor explicit empty pattern overrides.
- **`opl-input`**: cleanup companion animation timers on editor replacement and session shutdown.

## [0.1.19] - 2026-09-13

### Security hardened

- **`opl-modes`**: destructive base now blocks `find -delete`/`-exec`, `truncate`, and `git clean`/`update-ref`/`tag -d`/`cherry-pick`/`revert`/`am`/`apply`; `env` and `printenv` are no longer safe-listed. Destructive checks run against a quote/backslash-stripped skeleton, so `r"m"` cannot dodge `\brm\b`.
  - updated config json sample, based from this fix so that defaults will have these for use
- **`opl-modes`**: `bashPatterns` is now the shared Bash base for every mode — custom modes inherit it by default and opt out with `unrestrictedBash: true`. Session restore fails closed (unknown modes fall back to normal, plan filenames with path separators or `..` are dropped).
- **`opl-browser`**: `navigate`/`new_page` accept http(s) only; screenshot paths are confined to the project directory.
- **`opl-webaccess`**: `fetch_content` is http(s)-only with a 10 MB cap and a 30s timeout; Gemini keys now travel in the `x-goog-api-key` header.
- `install.sh` copy mode sets `chmod 600` on installed configs.

## [0.1.18] - 2026-09-12

### Added
- **`opl-browser` structured extraction (`extract` action, extension v1.1.0)**: Readability + Turndown over the *rendered* (post-JS) DOM, optionally scoped to a CSS selector; runs after `click`/`fill`/`wait_for` to read the page in its interacted-with state.
  - Reuses the existing preview + `responseId` size gate — no new config keys or schema fields.
  - Selector-scoped extracts use raw turndown, skipping Readability: its whole-document candidate scoring mispicks inside small subtrees (found live on gcash.com `#about-gcash`, where five of six stat cards were dropped).
  - Complements `opl-webaccess`'s `fetch_content` (raw HTTP HTML only): static pages → `fetch_content`; rendered or interacted-with pages → `browser:extract`.
  - Pipeline intentionally duplicated from opl-webaccess (~30 lines) for per-extension install independence. Nested deps `@mozilla/readability`, `linkedom`, `turndown` are already root dependencies.

## [0.1.17] - 2026-09-11

### Added
- **Named `runSequence` profiles**: `sequences: [{ name, iterations, llamaMetrics?, pauseMs? }]`, run via `/simplebench --sequence=<name>`; a bare `--sequence` runs the only profile, otherwise fails listing names. Names are single words and unique; per-profile `llamaMetrics`/`pauseMs` override block defaults. The legacy flat `sequence` array still works as an anonymous `(legacy)` profile, but cannot be selected by name.

### Changed
- Sequence start notice now reports effective settings (`llamaMetrics on/off`, `pause Ns`), so inherited defaults are visible before the first run.

### Fixed
- All chat wrappers (OpenAI-compatible, Bedrock Converse, Ollama tool) stamp `startedAt`/`finishedAt`, fixing null timestamps in coding-lite, research, and tool-test records.

## [0.1.16] - 2026-09-03

### Added
- **`runSequence` template** for `/simplebench --sequence`: a config-driven multi-iteration benchmark protocol in `opl-simplebench.json`, e.g. a warm-up curve of `--coding-lite --tag=coldest` → `--3ptest --tag=colder` → `--coding-lite --tag=semiwarm` → `--test-all --research-live --tag=warm`. Each entry is a plain flag string with its own `--tag`; iterations run sequentially against the current (or passed) model, each writing its normal artifact, and a failed iteration does not abort the sequence.
  - `llamaMetrics: true` appends `--llama-server --llamagputop` to every entry so local server stats are captured per iteration without repeating flags.
  - `pauseMs` sleeps between iterations only (including after a failed one), keeping thermal/KV-cache cooldown consistent across the run.
  - `enabled` gates the flag; validation rejects disabled/empty sequences, negative `pauseMs`, invalid entry tags, and entries containing `--all` or `--sequence` before any run starts. The outer `--tag` is ignored during a sequence.
- **`--3ptest`** flag: the explicit form of the default baseline suite (reasoning, instruction following, tool calls). Pure alias; artifacts already named the baseline suite `3ptest`, so run behavior and filenames are unchanged.

## [0.1.15] - 2026-09-02

### Changed
- **`opl-footer` session_stats**: replaced redundant counters (turns/steps/mreq/mtool; turns and mreq were literally the same expression, steps and mtool near-identical) with `prompts · api calls · tool calls` 
  - `prompts` counts user messages
  - `api calls` counts completed assistant responses
  - `tool calls` counts emitted tool-call blocks
- Removed dead live counters (`turns`, `steps`, `modelRequests`, `modelToolCalls`) that the branch reconstruction had already superseded; timing accumulators are unchanged.

### Added
- **npm publishing**: published as `@openlines/opl-pi-sht`, so `pi install npm:@openlines/opl-pi-sht@0.1.15` works alongside the Git install (`pi install git:github.com/linellazatin/opl-pi-sht@v0.1.15`).

## [0.1.14] - 2026-09-02

### Fixed
- **`opl-init` reliability for smaller models**: `/init` now writes a deterministic fingerprinted baseline `AGENTS.md` before asking the model to refine it, so a Markdown-only response cannot leave the repository unchanged. The prompt explicitly requires a write-tool call and read-back verification.
- **`opl-init` fingerprint stability**: `AGENTS.md` is excluded from the Git status fingerprint, preventing the guide from becoming immediately stale after it is written.

## [0.1.13] - 2026-09-01

### Added
- **`--tag=<word>`** (`tag` tool parameter) for `/simplebench`: labels a run as `benchmark.tag` in the artifact, e.g. `simplebench-coldrun-coding-lite-<model>-<thinking>-<timestamp>.json`. Tags are restricted to a single word (letters, digits, dot, dash, underscore); invalid tags are rejected before the run starts.

## [0.1.12] - 2026-08-31

### Changed
- **Coding-lite pass** is correctness-only: hidden tests green and no unrelated files. `verifiedAfterEdit` (public tests after final edit) is reported but no longer required.
- **Numeric closed answers** match the expected value as the last numeric token on any line (backward scan), so trailing thinking-template remnants no longer fail correct answers. Word answers keep strict final-line matching.
- **Tool test** accepts canonical argument variants (`15*24`, `15 × 24`, `15x24`, `(15*24)`, `15*24=`) and locations such as `Tokyo, Japan`.

### Removed
- Dead legacy code from `opl-simplebench/util/config.ts`: unified reasoning/tool/instruction runners, tool-support cache, and test-history/regression store (grep-confirmed unused). The `--clear-cache` path is retained.

### Fixed
- Coding verifier failures keep only the thrown error line; the full `node --eval` source and tmp path are no longer embedded in artifacts.

## [0.1.11] - 2026-08-31

### Fixed
- Research prompt hardening on css declaration
- `cause_effect`, `relative_quantities`, `analogy_1`, `bat_and_ball`, `scale_weight`, and `commonsense` reasoning test prompts hardening for more deterministic response ask.

## [0.1.10] - 2026-08-30

### Changed
- **Closed-answer reasoning grading** evaluates only the normalized final non-empty response line. Prompts use one canonical answer; ambiguous alternatives and keyword-based “reasoning quality” scoring were removed.
- **Instruction following** requires the exact deterministic JSON object, rejecting Markdown fences, extra keys, and incorrect values.
- **Coding-lite completion** requires a passing public `run_tests` result after the final edit, in addition to hidden verification and allowed-file checks.
- Tool-completion tests no longer pass providers that cannot continue after tool results.
- **Research grading**: `--test-all` uses deterministic source cards and verifies exact inline claim citations. `--research-live` retains configured DDGS/SearXNG research as an integration smoke test that does not affect recommendation.
- **Closed-answer fixtures and reporting** now use canonical tokens/noun phrases or explicit choices, avoid optional articles and unconstrained specificity, and label their strict result as a closed-answer contract rather than broad reasoning capability.

### Fixed
- `instruction_following` no longer strips Markdown fences before JSON parsing; the JSON-only contract rejects them.

## [0.1.9] - 2026-08-30

### Added
- `configs/opl-simplebench.json.sample`: camelCase `researchSearchProvider` (`ddgs` or `searxng`), `researchSearchUrl`, `researchMaxResults`, `llamaServerUrl`, and `llamagputopUrl`. `--llama-server` and `--llamagputop` are boolean opt-ins using those configured URLs; `--test-all` includes the benchmark-local research-artifact task and writes a `result.json`/`research.md`/`page.html` bundle.
- `opl-simplebench --llama-server` (tool `llama_server`): writes `summary.serverStats` from configured direct llama-server `/props` + `/metrics` without changing LiteLLM inference. `modelConfig` = ctx, slots, temp, top-k/p, min-p, repeat, spec-type (null for build-only fields: ngl, flash-attn, threads, batch, kv-k/v, n-max, draft-kv); `modelStats` = prefill/gen/session-avg tok/s and speculative acceptance from the before/after `/metrics` delta.
- `opl-simplebench --llamagputop` (tool `llamagputop`): treats configured `/stats` as authoritative, fills `serverStats` config/stats without matching Pi's selected model, and records the served ID as `modelConfig.model`; raw responses are excluded. On `/stats` failure, `/health` is checked for diagnostics only.
- **Coding-lite efficiency scoring**: each task result now carries `efficiency: STRONG | MODERATE | WEAK | FAIL` based on turns used (1 = STRONG, 2–3 = MODERATE, 4–5 = WEAK, failed = FAIL). The `score` field in `tests[]` uses this grade. `summary.coding.efficiency` contains per-bucket counts. Recommendation uses efficiency-weighted coding score (STRONG=1.0, MODERATE=0.7, WEAK=0.4, FAIL=0, threshold 0.5).
- **Coding-lite single-shot mode**: each `CodingTaskFixture` now carries `inlinePrompt` with the buggy code embedded. Pass `singleShot: true` to `runCodingTask` for a no-tools, single-turn variant — pure model quality signal with no agent loop variance.
- **`inlinePrompt` for all six tasks**: `fix-off-by-one`, `validate-config`, `diagnose-cross-file`, `safe-refactor`, `cli-flag`, `verify-after-edit`.

### Changed
- `/stats` is authoritative for llamagputop `model`, `spec-type`, and `reasoning`, replacing `/props` placeholder values such as `none`.
- llama-server capture is opt-in; inference endpoint and sampling unchanged. `/metrics` deltas are server-wide cumulative telemetry (not per-request); response usage stays authoritative. Probe errors go to `serverStats.errors` and never fail the run; `/props` and `/stats` are never stored raw.
- **Coding-lite `maxTurns` default reduced from 12 to 5.** Tighter turn budget removes sampling-path variance and makes turn-to-solution a meaningful signal.
- **Efficiency thresholds recalibrated for 5-turn budget**: STRONG = 1–2 turns, MODERATE = 3–4 turns, WEAK = 5 turns (hit limit). With a 5-turn max, the minimum read→write→run sequence takes 3–4 turns; the old STRONG=1/MODERATE=2–3 thresholds were unreachable in agent-loop mode.
- **`safe-refactor` public test now exercises empty-string filtering.** Public verifier changed from `['a', 'b']` (original code already passes, model gets no signal) to include `['a', '', 'b']`, matching the hidden test. Without this, the model ran tests, saw green, and exhausted turns without ever adding the filter.
- **Coding-lite notify output** now shows per-task efficiency grade and turn count (`STRONG (1 turn)`, `MODERATE (2 turns)`, etc.) and a summary line with STRONG/MODERATE/WEAK counts.
- **Coding-lite artifact `summary`** now includes `summary.coding` with `passed`, `total`, and `efficiency` bucket counts.

### Fixed
- `animals_1` expected answer now accepts `water`, `ocean`, and `sea` (was `water` only; model answers `ocean`).
- `analogy_2` expected answer now accepts `boot`, `sock`, and `shoe` (was `boot`/`sock`; `shoe` is the direct analogue to `glove`).
- `cause_effect` expected answer now accepts `grows`, `grow`, and `germinate` (was `grows` only; stemming mismatch caused false failures).
- `fix-off-by-one` public verifier now tests correct inclusive behavior (`sumInclusive(1, 4) === 10`), removing the adversarial contradiction where fixing the bug caused the public test to fail.
- `instruction_following` now strips markdown fences before `JSON.parse`, matching the repair logic already in `util/config.ts`.

## [0.1.8] - 2026-08-28

### Added
- Pi package manifest loading only `extensions/*/index.ts`; Git installs install root runtime dependencies for browser and web access.
- Tag-triggered GitHub Release workflow: tests with Bun, extracts the matching changelog section, and creates the release. It does not publish to npm.

### Changed
- Root README documents `pi install git:github.com/linellazatin/opl-pi-sht@v0.1.8`, optional config copying, and the one-time Playwright Chromium setup.

### Fixed
- `opl-modes` tests no longer read ignored user configuration files in CI; appearance publication is tested with an in-memory custom mode instead.

## [0.1.7] - 2026-08-28

### Added
- Pi package manifest loading only `extensions/*/index.ts`; Git installs now install root runtime dependencies for browser and web access.
- Tag-triggered GitHub Release workflow: tests with Bun, extracts the matching changelog section, and creates the release. It does not publish to npm.

### Changed
- Root README documents `pi install git:github.com/linellazatin/opl-pi-sht@v0.1.7`, optional config copying, and the one-time Playwright Chromium setup.

## [0.1.6] - 2026-08-28

### Added
- `opl-browser`: Chromium automation via Playwright behind a single action-based `browser` tool (navigate, snapshot, screenshot, click, fill, hover, press, select, evaluate, console/network, page management). Large outputs return a preview + `responseId` (fetch via `action: "get"`); screenshots go to file. One reused browser per session. Replaces the chrome-devtools MCP. Needs `npm install` + `npx playwright install chromium`.
- `opl-modes`: `lazyTools` config — listed tools are withheld from the resting active set and enabled on demand via `load_tools`, keeping heavy schemas (`subagent`, `browser`, `simplebench`) out of the cached prefix. Activation is bounded by the current mode's policy; core built-ins, `plan_complete`, and `load_tools` are protected.

## [0.1.5] - 2026-08-24

### Added
- `opl-ctxtrim`: trims verbose context-mode `ctx_*` tool-schema descriptions on outbound requests (`before_provider_request` hook) for OpenAI Responses/Chat Completions and Bedrock Converse, without touching the context-mode package. Preserves names, structure, required fields, enums, defaults, bounds, strict flags; fails open on unknown formats/tools. Measured vs context-mode v1.0.169: 28,019 → 9,152 bytes (67.3%, ~4,700-6,300 tokens/request).

### Changed
- Root `README.md`, `install.sh`, `package.json` include `opl-ctxtrim` (nine extensions).

### Tests
- `tests/opl-ctxtrim.test.ts`: all provider shapes, non-`ctx_*` preservation, fail-open paths, input immutability, single-handler registration, and a live context-mode measurement.

## [0.1.4] - 2026-08-23

### Added
- `opl-simplebench`: six execution-backed coding-lite tasks (disposable dirs, restricted tools, hidden verification, coding metrics) with `--coding-lite`, `--test-all`, and matching LLM options; `--test-all` composes with `--all`.

### Changed
- `opl-simplebench`: Ollama chat forwards native tool defs and captures streamed tool calls; missing-path file inspection returns recoverable errors; coding-lite records live in artifact `tests[]` as a fourth recommendation category.

### Tests
- Fixture isolation, path traversal, public/hidden verification, coding-mode arguments.

## [0.1.3] - 2026-08-23

### Changed
- `opl-simplebench`: default runs leave sampling/reasoning to the provider; `--thinking-max` requests max reasoning for OpenAI-compatible providers and metadata-advertised direct Bedrock models (delegating Bedrock request construction to Pi's adapter). Artifacts record requested/effective thinking mode, level, and metadata source.

### Tests
- Metadata-gated Bedrock max-thinking resolution; retained provider-default/OpenAI-compatible checks.

## [0.1.2] - 2026-08-23

### Hotfix
- `opl-simplebench`: fixed instruction-following report rendering (`reportInstructionScore` → `formatInstructionScore`).

## [0.1.1] - 2026-08-23

### Added
- `opl-simplebench`: model benchmark for reasoning, JSON instruction-following, and tool-call generation across providers.

### Changed
- All helper/functional/smoke checks use Bun's named-test runner; smoke bundles target Node.

### Tests
- Artifact opt-out, cwd artifacts, fixtures/scoring, provider usage extraction, aggregate metrics.

## [0.1.0] - 2026-08-22

### Changed
- Standardized all extension READMEs (commands/flags, features, configuration, architecture).
- Centralized active-mode appearance in `opl-modes.json` (incl. `off`/`execute`); `opl-input` resolves Bash > mode appearance > fallback; `opl-footer` reads `appearance.modeColor` (fallback `muted`).
- `opl-init`: workspace-aware crawling, foreign-rule ingestion, bounded traversal, truncation reporting.
- `opl-modes`: `allowExecute`, functional custom `allowPlanComplete`, merged review mode, write-limited research mode.
- `opl-footer`: latest settled prompt-to-completion turnaround beside cumulative LLM time.

### Tests
- Expanded coverage for `/init` crawling, input style, modes, footer, todo config, webaccess.

## [0.0.3] - 2026-08-22

### Changed
- `opl-init`: workspace-aware crawling and foreign agent-rule ingestion.
- `opl-input`: fixed custom-mode color resolution; extracted testable styling helpers.
- `opl-footer`: last settled prompt-to-completion turnaround time.
- `opl-modes`: `allowExecute`, functional custom `allowPlanComplete`, review + research modes, restrictive-mode tool docs.

### Tests
- Fixture coverage for init crawling, input styling, mode helpers, footer helpers, todo config, webaccess.

## [0.0.2] - 2026-08-21

### Changed
- `opl-footer`: session/performance statistics rows.
- `opl-modes`: unified mode-manager docs (commands, flags, custom modes, model overrides).
