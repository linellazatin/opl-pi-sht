# Changelog

## [0.3.0] - Security hardening, fixes, and extension enhancements

The network trust boundary became address-based, code that Pi executes on the model's behalf stopped inheriting the harness environment, configuration and written paths became relocatable, and the collection stopped paying tokens for content it does not use. Detail lives in each extension's README.

### Breaking

- **`opl-browser`, `opl-webaccess`**: the entire local-use translation prefix `64:ff9b:1::/48` is blocked, even with `allowPrivateNetwork` and `allowLoopback` enabled. The well-known `64:ff9b::/96` prefix still follows embedded-IPv4 policy. [Browser network policy](extensions/opl-browser/README.md#network-policy), [Webaccess network policy](extensions/opl-webaccess/README.md#network-policy)
- **`opl-browser`, `opl-webaccess`**: `allowLoopback` now defaults to **`false`**, so neither tool reaches `localhost`, `127.0.0.0/8` or `::1` unless you opt in. Before this a model could drive a dev server, a local Docker socket proxy or an IDaaS callback. Set `"allowLoopback": true` if your work depends on a local service; endpoints you configure yourself (`ddgs.apiUrl`, `searxng.instanceUrl`) are outside this key. [Network policy](extensions/opl-browser/README.md#network-policy)
- **`opl-browser`**: page-scoped actions resolve their target through `index` (the selected page when absent) and a stale or out-of-range selection is now an error naming the page count instead of silently falling back to the last page. `close_page` keeps the same page selected when a different page closes; `new_page` selects the page it created. [Browser details](extensions/opl-browser/README.md#extension-features)
- **`opl-browser`**: a screenshot target is contained on its **real** path (symlinks in the existing part are followed first, so `shots -> ~/.pi` inside the project can no longer carry the write out), refused if a symlink or file already stands there, and reserved with `wx` so the refusal and the write are one operation. The action returns an absolute path; a failed capture leaves no empty file. [Extension features](extensions/opl-browser/README.md#extension-features)
- **`opl-guardian`**: malformed-call forensics moved out of the repository. `err/guardian.jsonl` beside the session directory became `<agent dir>/guardian-incidents.jsonl`; `logging.incidentFile` overrides it (relative values stay under the agent dir, `false` stops writing), `logging.maxBytes` (262144) rotates to `.1`, and records hold the tool name, sorted argument *key* names and argument byte size - never values. [Forensic JSONL](extensions/opl-guardian/README.md#forensic-jsonl)
- **`opl-guardian`, `opl-modes`**: a bash tool call whose `command` is not a string is **blocked** rather than coerced - `String(["rm","-rf"])` reads as `rm,-rf` to a word matcher, and there is no inspection to perform on a value that is not a command. [Guardian Bash rules](extensions/opl-guardian/README.md#dangerous-bash-commands), [Mode behavior](extensions/opl-modes/README.md#mode-behavior)
- **Session directory, not harness directory**: plans (`.pi/plans/` in `opl-modes`), screenshot targets, `opl-simplebench` artifacts and the footer's `path` segment now resolve against `ExtensionContext.cwd`. `process.cwd()` survives only as the documented pre-session fallback in `opl-modes` state, the footer context builder, and a programmatic simplebench run. [Mode behavior](extensions/opl-modes/README.md#mode-behavior)

### Security

- **`opl-webaccess`, `opl-browser`**: the host policy is judged on **resolved addresses**, not URL text. Hostnames resolve through `node:dns` (`all` + `verbatim`) and every answer goes through the classifier used for IP literals, closing the `nip.io` class of bypass; each redirect hop is re-resolved and nothing is cached; IPv6 literals embedding an IPv4 (NAT64, 6to4, `::ffff:`, deprecated IPv4-compatible) are judged by the embedded address; cloud metadata and unspecified addresses (`0.0.0.0/8`, `::`) are never toggleable. [Network policy](extensions/opl-webaccess/README.md#network-policy)
- **`opl-webaccess`**: each HTTP connection dials an approved address through a pinned resolver; every redirect hop re-resolves and re-pins, and sockets are not pooled. TLS certificate validation and the `Host` header retain the hostname. `maxResponseBytes` (default 10485760) is enforced while reading. Browser DNS rebinding remains a documented residual because Chromium resolves internally; private-network and loopback access remain opt-in. [Network policy](extensions/opl-webaccess/README.md#network-policy)
- **`opl-browser`**: the guard covers the whole page, not just the URL the model was given - a context route for subresources, script fetches, JS/meta redirects and popups; `routeWebSocket` for `ws://`/`wss://` (a `route()` never sees a handshake); `serviceWorkers: "block"` on new contexts; `file:` fails closed. Because a route handler only sees the **first** URL of a redirect chain, live frame URLs are re-checked after navigation, after `select_page` and before page-bound actions, and a page landed on a blocked host is cleared to `about:blank`. If a handler cannot be installed the context is closed and the tool throws rather than browsing half-guarded. [Browser details](extensions/opl-browser/README.md#network-policy)
- **`opl-simplebench`**: the coding verifier runs model-authored code from an allowlisted environment (`PATH`, `HOME`, temp/locale/timezone, TLS trust, terminal and Windows spawn variables). Secrets, `AWS_*`, `GH_*`, `PI_*` are withheld and `NODE_OPTIONS`/`NODE_PATH` are never forwarded, because both make Node load attacker-chosen files; anything the model's code spawns inherits the same set. Measured with a shell-exported canary: 56 inherited keys reading it before, 9 and clean at both depths after. This limits what generated code can read from the process; it is **not** a filesystem or network sandbox. [Coding lite](extensions/opl-simplebench/README.md#coding-lite)
- **`opl-simplebench`**: AWS profile resolution stopped building a shell string. `execFile` with an argument vector, profile names validated against `^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$` (an invalid name spawns nothing, a leading dash cannot become another option), and the call is async so a slow SSO chain no longer stalls the TUI. [Provider authentication](extensions/opl-simplebench/README.md#provider-authentication)
- **`opl-guardian`**: Bash protected-path rules match **paths**, not command text - words split on whitespace, quotes, backticks and shell punctuation, relative words resolved against the session directory and through symlinks. `grep -rn "process.env" src` and `cat .env.example` are allowed; `cat .env`, `git show HEAD:.env`, `python -c 'open(".env")'`, `cat alias` (symlink) are blocked, and the default `env` pattern now fires on a dumped environment rather than the word anywhere. Advisory by design: `read`/`write`/`edit` is where paths are enforced. [Dangerous Bash commands](extensions/opl-guardian/README.md#dangerous-bash-commands)
- **`opl-init`, `opl-footer`**: every `git` probe runs through a shared guard, because on git 2.54 a `git diff HEAD` in a worktree declaring `* diff=canary` with a `textconv` driver **runs that command**; the guard adds `--no-pager`, `core.fsmonitor=false`, `core.hooksPath=`, `protocol.ext.allow=never`, `credential.helper=`, `GIT_CONFIG_NOSYSTEM`/`GIT_ATTR_NOSYSTEM`, `GIT_TERMINAL_PROMPT=0` with cleared askpass vars, `GIT_OPTIONAL_LOCKS=0`, and `--no-ext-diff --no-textconv` after diff-family subcommands (a `-c diff.textconv=` override alone does not stop a named driver). The block is duplicated per extension because `install.sh` installs one directory at a time, and drift-pinned by the parity test. [Git probing](extensions/opl-footer/README.md#git-probing)
- **`opl-modes`, `opl-footer`, `opl-input`**: cross-extension `globalThis` state is validated, not trusted. Segments honour only a well-shaped value and go invisible on anything malformed instead of throwing inside the render loop; the footer render trigger is `typeof`-checked and wrapped; both sides delete what they publish on `session_shutdown` and re-publish on `session_start`. [Cross-extension seams](extensions/opl-footer/README.md#cross-extension-seams)
- **Configuration paths**: extensions with configs, plus `opl-simplebench`'s `models.json`, `auth.json` and cache, resolve their paths through the host's `getAgentDir()` instead of hardcoded home directories or the legacy `PI_AGENT_DIR`. This changes path resolution, not config reload timing; some configs are loaded at extension initialization. `opl-guardian`'s default protected `~/.pi/agent/auth.json` path still needs an explicit entry when the agent directory is relocated. [Configuration](README.md#configuration), [Protected paths](extensions/opl-guardian/README.md#protected-paths)

### Added

- **`opl-footer`**: added `compactions` segment, which counts manual and automatic compactions from the active session, including resumed-session history; it stays hidden at zero. [Available segments](extensions/opl-footer/README.md#available-segments)

### Changed

- **`install.sh`**: installs `configs/<extension>.json` when the repo carries one, otherwise the `.sample`; an existing target config is no longer overwritten (`--force-configs` restores that); installs are recorded in `<agent-dir>/extensions/.opl-pi-sht.installed` and a recorded directory this release no longer ships is pruned (`--no-prune` opts out), because pi auto-discovers `extensions/*/index.ts` and leftovers loaded beside the new copy; the target honours `PI_CODING_AGENT_DIR` with `PI_AGENT_DIR` as a legacy alias, and `--link` gained the same behavior. [Checkout installer](README.md#checkout-installer)
- **`opl-init`**: `/init` preserves the user-owned `## Operational notes` section verbatim during regeneration, including nested subsections, in both model-refined and fallback guides. Duplicate protected sections or detected edits during refinement cancel the update. Protection applies only to `/init`. [User-owned operational notes](extensions/opl-init/README.md#user-owned-operational-notes)
- **`opl-init`**: `globToRegExp` escapes every metacharacter except `*` and `?` (real workspace names contain `(`, `+`, `*`; an unescaped one threw `SyntaxError` out of `crawl()`), with an unusable glob skipped and reported in `Crawl.skippedGlobs`; fingerprinting stopped reading whole files (2 MB per file, 32 MB total, 5,000 paths, `size|mtime` past a ceiling, `OVER_CAP` past the count ceiling, budget state folded into the digest so it cannot oscillate), `gitOutput` `maxBuffer` 64 MB to 4 MB, and the refinement call asks `reasoning: "minimal"` because `{ reasoning: false }` read as unset and paid the provider default. [Extension features](extensions/opl-init/README.md#extension-features)
- **`opl-guardian`**: `protectedPaths` entries are exact paths, as the code always meant for file tools - `.env` does not cover `.env.local`, there is no glob syntax, and configured `permissionGate.patterns` replace the defaults. [Protected paths](extensions/opl-guardian/README.md#protected-paths)
- **`opl-input`**: the pi-tui text sniffing behind the editor re-framing is now `isSolidBorder`/`scrollIndicatorText`/`isBorderLike` at module scope instead of two duplicated closures, pinned against the installed pi-tui source. Behavior unchanged. [Color values](extensions/opl-input/README.md#color-values)
- **`opl-todo`**: the overlay's item cap uses the terminal height pi-tui reports for the overlay each frame (24 rows until the first frame), not `process.stdout.rows`, so a redirected stdout or an embedded terminal of another shape cannot make the widget plan for a screen it is not drawing into. [Extension features](extensions/opl-todo/README.md#extension-features)
- **`opl-todo`**: `ctrl+alt+r` now removes completed todos even when unfinished items remain. The remaining list is saved to session history so it stays cleared after branch reconstruction. [Shortcuts](extensions/opl-todo/README.md#commands-flags-and-shortcuts)
- **Packaging**: the `opl-*.json` ignore rule is anchored to `/configs/`; the two nested manifests (`opl-browser`, `opl-webaccess`) are `private`, dropped the nonexistent `"main"` and the `npm test` stub, carry `license: MIT`, and keep their own version line (`0.2.0`) instead of mirroring the collection. [Package installation](README.md#pi-package)
- **Token cost**: plan injection is capped (`plan.maxInjectBytes` 24000 for the system prompt, `plan.maxEntryBytes` 4096 for the session copy, applied before a custom `{plan}` template substitutes, retaining complete lines within a UTF-8 budget that includes the marker); a search or fetch result spills to `<agent-dir>/web-access-cache/<responseId>.json` and the session entry keeps a 512 B/item preview plus the path (1 h TTL, 32 MB prune, `timeoutMs` default 30000 composed with the caller's abort - a three-URL fetch entry went 80.2 KB to 2.0 KB); and the footer drops empty rows with their dividers, so one populated row costs 2 lines instead of 6. [Plan configuration](extensions/opl-modes/README.md#configuration), [Webaccess configuration](extensions/opl-webaccess/README.md#configuration), [Layout cost](extensions/opl-footer/README.md#layout-cost)

### Removed

- **`opl-simplebench`**: the dead `models.json` write path (`writeModelsJson` with a fixed `.tmp` name and no cross-process lock, `acquireModelsJsonLock`, `readModifyWriteModelsJson`) plus helpers left unreachable by it. Nothing called them; a future caller would have inherited the corruption risk on `~/.pi/agent/models.json`. The read path through `detectProvider` is unchanged. [Simplebench architecture](extensions/opl-simplebench/README.md#architecture)

### Fixed

- **`opl-ctxtrim`**: tool names must be own entries in `CTX_DESCRIPTIONS`; inherited names such as `constructor`, `toString` and `__proto__` no longer rewrite unrelated tool descriptions or parameter prose. Regression coverage checks these names alone and beside a known context-mode tool. [Scope](extensions/opl-ctxtrim/README.md#scope)
- **Installer**: retained or unsuccessfully pruned extensions stay recorded for later cleanup; failed pruning exits nonzero, invalid manifest names cannot traverse paths, skipped link destinations are not claimed, and manifest replacement uses a unique temporary file. [Checkout installer](README.md#checkout-installer)
- **Packaging**: npm ships only sample configs, excluding checkout live configs; the root lock restores missing TypeScript/esbuild platform entries without upgrading existing dependencies. Release validation uses `npm ci` and strict typechecking before the full suite. [Package installation](README.md#pi-package)
- **`opl-browser`**: selected pages are tracked by identity, so closing an earlier tab cannot switch the selected document; an externally closed selection requires explicit recovery. Each page action binds its target once, preventing a close during validation from retargeting it. [Browser details](extensions/opl-browser/README.md#extension-features)
- **`opl-browser`**: the sample shipped without `allowLoopback` while its comment claimed loopback was always allowed; config tests assert the shipped file rather than the loader default. [Browser details](extensions/opl-browser/README.md#network-policy)
- **`opl-browser`, `opl-webaccess`**: fully expanded IPv6 addresses now pass through the embedded-IPv4 classifier; expanded DNS answers for unspecified, loopback and IPv6 metadata addresses follow the same policy as their compressed forms. 6to4 addresses embedding `0.0.0.0` are also refused. Both guards remain parity-checked. [Browser network policy](extensions/opl-browser/README.md#network-policy), [Webaccess network policy](extensions/opl-webaccess/README.md#network-policy)
- **`opl-webaccess`**: URL fetches decode `gzip`, `deflate` and `br` with separate received/decoded byte caps; redirect headers advance without buffering their bodies, and only 301/302/303/307/308 are followed. Abort and inactivity cleanup closes the socket and decoder; the overall deadline survives cleanup between hops. [Retrieval behavior](extensions/opl-webaccess/README.md#extension-features)
- **`opl-webaccess`**: PDF fetching converts HTTP response buffers into plain `Uint8Array` input before extraction, avoiding PDF.js rejecting Node `Buffer` values. [Retrieval behavior](extensions/opl-webaccess/README.md#extension-features)
- **`opl-webaccess`**: `searchWeb` re-read and re-parsed its config per query; a multi-query fan-out now passes the loaded config down. [Retrieval behavior](extensions/opl-webaccess/README.md#extension-features)
- **`opl-modes`**: plan caps include the UTF-8 truncation marker and source path instead of reserving a fixed 200 bytes. Only complete lines are retained; oversized paths use a generic file reference, tiny budgets use a shortened notice, and session entries keep the full path separately. [Plan configuration](extensions/opl-modes/README.md#configuration)
- **`opl-footer`**: branch facts are keyed by session and leaf identity, branch length, context window and estimation state; tree navigation and compaction invalidate them. Equal-length branch switches refresh counts, tokens, cost and thinking, and canonical context usage drops the estimate marker. [Footer behavior](extensions/opl-footer/README.md#features)
- **`opl-footer`**: a throwing segment renders `[?]` while sibling segments survive, malformed transcript values read as zero, and the unfilled cell colour resolves once per frame. Git cache invalidation ignores non-string Bash commands instead of matching coerced arrays or objects. [Footer behavior](extensions/opl-footer/README.md#features)
- **`opl-ctxtrim`**: Known context-mode `ctx_*` descriptions in Google/Gemini requests were previously left untrimmed. `functionDeclarations` and `toolSpecifications` inside `tools[]`, the `tool_config` snake_case variant, and `parametersJsonSchema`/`input_schema` are now recognised: 21,752 B to 5,726 B on an 11-tool payload (-73.7%; the OpenAI shape is -74.1%). [Token savings](extensions/opl-ctxtrim/README.md#token-savings)
- **`opl-simplebench`**: no more `require()` in ESM, and the model-facing parameters are built with TypeBox rather than a raw JSON literal through `as any` - descriptions byte-identical, so token cost does not move. [Simplebench architecture](extensions/opl-simplebench/README.md#architecture)
- Strict typechecking found three real defects, each fixed at the source rather than with a cast: a `opl-guardian` type predicate declared `block is ToolCall` narrowed the kept content and made the "does a valid call remain?" test unreachable to the compiler; `opl-browser`'s `GuardTarget.route` returned `Promise<void>`, which excluded the `BrowserContext` Playwright hands back; and `opl-questionnaire`'s `validateQuestions` demanded a normalized `Question` while reading three fields, plus it read `result.isError`, a field newer than the floor and now treated as optional.

### Tests

- **Release verification**: 480 tests and strict typechecking pass with installed Pi `1.1.0`, locked Pi `1.0.0` and floor Pi `0.87.0`; all 11 extension entrypoints load in each matrix. npm `10.9.9` and `11.19.1` complete clean installs with the repaired lockfile. These checks do not establish full live TUI/provider behavior. [Tests](README.md#tests)
- **Gates, not assertions**: `npm run typecheck` runs `tsc --strict` with `noUncheckedIndexedAccess` on, over all 86 extension sources; a committed root `package-lock.json` lets CI use `npm ci`; and a CI `floor` job pins `pi-coding-agent`/`pi-tui`/`pi-ai` to `0.87.0` with `typebox@1.3.27`, neutralises `PI_CODING_AGENT_DIR`/`PI_MANAGED_INSTALL_ROOT`, and fails when the loader reports a different build (`OPL_PI_HOST_SOURCE`). The declared floor is now exercised - it caught the `isError` gap above. `npm run test:shared` carries the cross-cutting files instead of duplicating them in two suites.
- **Index-access sweep**: 127 `noUncheckedIndexedAccess` sites across 9 extensions / 30 files, cleared in four batches, then the flag turned on permanently in `tsconfig.json`. Fixed as type declarations, not assertions: the network guard's octet and IPv6-group reads became `Ipv4` / `Ipv6Groups` tuples built by length-checked constructors; loop bodies iterate `.entries()` instead of indexing a counter; render and restore loops read an element into a local and skip a hole. One real defect surfaced: `safeGitInvocation` with no arguments put an `undefined` slot into git's argv, which execFile rejects at the syscall rather than as a handled git error - pinned by `tests/git-guard.test.mjs`. Behavior proven unchanged by differential corpora against the committed tree: 712 guard verdicts, 456 bash-matcher/plan-title comparisons, 282 scoring/research comparisons, all identical.
- **Regression coverage**: mirrored host and git guards are drift-checked; generated-code child processes are checked against the environment allowlist; cross-extension seams reject missing, malformed and throwing counterparts. Coverage includes pinned redirects, compressed-response limits and cleanup, PDF buffers, page identity, branch-cache invalidation, installer ownership, package contents and exact UTF-8 plan caps. [Tests](README.md#tests)
- **Live testing instructions**: specifically intended to be used by agents/models to do in-session tests of all the opl-pi extensions present in this repo. [Tests](README.md#tests)

### Docs

- **`opl-ctxtrim`**: clarified context-mode-only tool scope in the extension README, source header, root README and `AGENTS.md`; added a provider tool-shape table and distinguished tool-name matching from server identity. [Provider tool shapes](extensions/opl-ctxtrim/README.md#provider-tool-shapes)
- **`opl-ctxtrim` re-framed everywhere** (extension README, source header, root README, `AGENTS.md`): a Pi description trimmer specifically for known context-mode `ctx_*` tools; provider-format support locates the same tools across serializers, and only own entries in `CTX_DESCRIPTIONS` match, so widening the policy is a source change; savings stated per shape (Responses -67.3%, Chat array -74.1%, Gemini -73.7%) with the ~4,700-6,300 token figure labelled as a Responses-shape byte heuristic. [Scope](extensions/opl-ctxtrim/README.md#scope)
- **Full documentation sweep**: every quantitative and behavioral claim in the root docs and all 11 extension READMEs was re-verified against the source that owns it. Wrong and now corrected: `opl-input`'s "45 theme tokens" (the schema defines 56 named colours) and a 256-color downconversion no code implements; `opl-simplebench`'s recommendation table, which described a `USABLE` outcome `report.ts` cannot produce, and an architecture list missing `coding.ts`/`research.ts`; `opl-guardian`'s corrupted sentence and a superseded paragraph still pointing at `err/guardian.jsonl`; `opl-init`'s unbounded-hashing description; `opl-modes` duplicating `opl-input`'s model-override paragraph; runtime cache paths hardcoded to `~/.pi/agent` instead of `<agent dir>`; `opl-browser` deferring DNS rebinding "with the loopback default flip" that had already shipped; and a root README whose browser estimate and token arithmetic disagreed with themselves. A source comment in `opl-simplebench/coding.ts` contradicted its own turn buckets and was fixed.
- Documented new defaults, ceilings, caches, cross-extension seams and command behavior; browser tool-schema overhead remains an estimate, and host-loader validation is distinguished from live TUI/provider behavior.

## [0.2.12]

### Fixed

- **`opl-footer`**: `codex_usage` & `openrouter_usage` segments now refresh after each assistant response and tool completion, not just when the agent settles. Non-blocking requests keep the 30-second floor and coalesce throttled or in-flight events into one trailing refresh.

### Tests

- **`opl-footer`**: added nine lifecycle tests for mid-run refreshes, trailing-request coalescing, message-role filtering, cancellation, and in-flight completion handling; these now run for both Codex and OpenRouter.

## [0.2.11] - 2026-10-02

### Added

- **`opl-footer`**: added the optional `openrouter_usage` segment for the selected `openrouter` provider. It renders the API key's configured cap as `$<limit - limit_remaining> / $<limit> (<percent>%)` and remains hidden when the key has no positive limit.

### Privacy and reliability

- **`opl-footer`**: resolves the active model's OpenRouter credential through Pi and sends `GET https://openrouter.ai/api/v1/key` directly from the local Pi process. The API key and response body are never written to disk, logged, or added to the Pi session; they are sent only to `openrouter.ai`.
  - Footer retains only the parsed usage and limit snapshot in process memory; refreshes after session start, model selection, and settled agent turns with a 30-second floor and 15-second timeout; failed refreshes retain and mark the prior snapshot `(stale)`.
  - Usage is derived from OpenRouter's `limit_remaining`, rather than the separate `usage` and `byok_usage` ledgers, which may not both count against a key limit.

### Tests

- **`opl-footer`**: added coverage for OpenRouter key-limit parsing, active-Pi-credential requests, rendering, stale fallback, provider gating, and configurator availability.

## [0.2.10] - 2026-10-02

### Added

- **`opl-footer`**: added the optional `codex_usage` segment for exact remaining ChatGPT Codex subscription quota. It displays server-reported 5-hour and weekly remaining percentages with reset countdowns for the OAuth-authenticated `openai-codex` provider, separate from OpenAI Platform API-key billing.

### Reliability

- **`opl-footer`**: Codex usage refreshes asynchronously after session start, model selection, and settled turns with request deduplication, a 30-second refresh floor, and a 15-second timeout
  - Footer rendering never performs network work; failed refreshes retain and label the last exact snapshot as `(stale)`, while disabling the segment prevents future requests, discards any in-flight result, and a first-request failure remains hidden.
  - OAuth credentials are resolved through Pi and are never logged or persisted by the footer.
  - Internal ChatGPT usage response is duration-based window parsing; unsupported or malformed responses fail closed without disrupting the footer.

### Tests

- **`opl-footer`**: added coverage for duration-based window parsing, OAuth/account request headers, exact and stale rendering, provider rejection, and stale fallback.

## [0.2.9] - 2026-09-29

### Changed

- `devDependencies` updated to `>=0.87.0`, conforming to latest pi 0.99.x release.
- **`opl-guardian`**: all notification, selection-prompt, and confirmation message text is fixed red regardless of Pi's theme; selection options keep their normal styling.

### Tests

- added `test-summary.mjs` for npm test summary results count
- **`opl-guardian`**: added assertions for red dangerous-command prompts, protected-path notifications, and destructive-session confirmations.

## [0.2.8] - 2026-09-29

### Security hardened

- **`opl-webaccess`**: `fetch_content` now blocks private-range, link-local, and reserved hosts by default and always blocks cloud-metadata endpoints (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`, `instance-data`, `fd00:ec2::254`). 
  - Loopback (`localhost`/`127.0.0.0/8`/`::1`) is allowed by default for local development. 
  - Redirects are no longer followed silently: each hop is re-validated against the same policy, so a public URL that bounces to a private/link-local host is rejected. 
  - Set `allowPrivateNetwork: true` in `opl-webaccess.json` to reach private ranges; provider API endpoints (`ddgs.apiUrl`, `searxng.instanceUrl`) are not subject to this guard.
- **`opl-browser`**: `navigate`/`new_page` block private/link-local ranges by default and always block cloud-metadata endpoints; loopback is allowed by default, and the final URL after a redirect is re-checked. 
- **`opl-browser`**: Screenshot paths must now end in `.png`/`.jpg`, stay inside the project directory, and are refused when the file already exists, so a bad `screenshot` action can no longer overwrite project files.

### Fixed

- **`opl-browser`**: `evaluate` no longer crashes the tool when the page script returns `undefined` (or another `JSON.stringify`-unsupported value). It returns `(undefined result)` instead, and the result-size gate defensively coerces the action text so a missing text can never throw outside the tool's error path.
- **`opl-browser`**: `browser` tool calls are serialized on the single shared Chromium context, so concurrent actions can no longer race on `activeIndex`, `ensure()`, or the page pointer.
- **`opl-webaccess`**: a multi-query `web_search` no longer loses sibling results when one provider response is non-JSON or otherwise throws. The batch is collected with `Promise.allSettled`, so a single bad query is reported per-query while the others still return. `gemini` and `tavily` report a clean `HTTP <status> (non-JSON response)` error instead of a JSON parse exception.
- **`opl-webaccess`** and **`opl-browser`**: stored-result TTL is now enforced on read, not only when another result is stored, so an entry that sits idle past its 1-hour expiry is no longer served.
- **`opl-webaccess`**: `loadConfig` validates the config shape and `resolveCaps` coerces non-positive/non-numeric caps to defaults, so a malformed `provider`, `providers`, or cap value falls back safely instead of truncating to an empty body.
- **`opl-modes`**: the shipped/documented cycle shortcut now matches the code default `ctrl+alt+m`. The sample config previously shipped `shift+tab`, which is also Pi's built-in `app.thinking.cycle`, so both fired on one press.
- **`opl-guardian`**: malformed tool calls (blank or missing id or name) are additionally blocked at the `tool_call` boundary as defense in depth, so they cannot execute even if the `message_end` filter is bypassed by a replay or streaming path.
- **`opl-guardian`**: the dangerous-command confirmation now defaults to "No" (fail closed) in both TUI and RPC, so an accidental or replayed confirmation denies the command instead of silently approving it; only an explicit "Yes" allows execution.

### Reliability

- **`opl-browser`**: `extract` reports a clear message when a selector matches zero or multiple elements instead of surfacing a strict-mode crash; `navigate: back`/`forward` reports when there is no history; per-page console/network buffers are capped at the most recent 200 entries so a long-lived page cannot grow memory without bound.
- **`opl-webaccess`**: `fetch_content` and `web_search` cap the inputs per call (`maxFetchUrls` default 20, `maxSearchQueries` default 10, now both configurable), so an oversized batch cannot spawn unbounded requests beyond the existing 3-at-a-time concurrency; excess inputs are skipped and reported in the tool output.
- **`opl-questionnaire`**: validation and headless errors are now marked as tool errors (`isError`) rather than mislabeled as cancellations, so the result card shows the message instead of "Cancelled". Blank question ids are rejected (they previously produced an answers entry keyed `""`).
- **`opl-modes`**: documented the top-level vs per-mode empty-pattern asymmetry — an empty top-level `bashPatterns` array falls back to the built-in list (it cannot opt out), while a per-mode empty array disables that policy.
- **`opl-guardian`**: incident timestamps no longer throw when a provider omits or zeroes the message timestamp; the forensic JSONL record is preserved with a current-time fallback. In mixed responses (valid tool calls remain) the diagnostic is now prepended as text before the tool calls, which round-trips through provider wire formats, instead of appending a trailing text block after `tool_use`.

### Tests

- **`opl-browser`**: added `assertHttpUrl` loopback-allowance, private-range blocking, and metadata hard-block coverage, plus `safeScreenshotPath` coverage for the image-extension and refuse-overwrite rules.
- **`opl-browser`**: added `pushLogEntry` coverage for the console/network buffer cap.
- **`opl-webaccess`**: added `assertHttpUrl` coverage for private/link-local ranges, loopback allowance (default and integer/IPv6-mapped forms), cloud-metadata hard-blocking (even with `allowPrivateNetwork: true`), and the `allowPrivateNetwork` opt-in.
- **`opl-webaccess`**: added `resolveCaps` fallback coverage for malformed cap values and read-path TTL expiry (no intervening store).
- **`opl-webaccess`**: added `fetchAllContent` coverage that the URL count is capped per call.
- **`opl-guardian`**: added coverage that blank id/name tool calls are blocked before any policy evaluation.
- **`opl-guardian`**: added coverage that the dangerous-command prompt presents a fail-closed default (`No` listed first).
- **`opl-guardian`**: added incident-timestamp fallback coverage and mixed-response diagnostic-ordering coverage.
- **`opl-questionnaire`**: added helpers coverage for the error-vs-cancellation flag and blank/duplicate/unselectable id validation.

## [0.2.7] - 2026-09-29

### Added

- **`opl-guardian`**: consolidates [dangerous-Bash confirmations, protected paths, destructive-session prompts](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions), and malformed-call filtering under `opl-guardian.json`. Confirmation works in TUI and RPC; configured actions block without UI by default.
- File-tool path checks follow symlinks and fail closed when protected targets cannot be resolved. Session-switch prompts consider only the active branch. Default recursive-delete matching covers reordered and separate `-r`/`-f` flags.
- Bash protected-path checks remain literal best-effort, not shell confinement. Existing custom pattern lists replace defaults and must be updated manually.

## [0.2.6] - 2026-09-25

### Changed

- **`opl-footer` post-compaction context UX**: when Pi intentionally reports `ctx.getContextUsage().percent` as unknown immediately after a manual, threshold, or overflow-recovery compaction, `context_pct` now estimates the rebuilt active projection with Pi’s `estimateTokens()`. 
  - The gradient bar remains visible and the percentage plus used-token figure are marked with `≈` until the next assistant response supplies exact provider-backed usage. 
  - It still renders `(--%)` if no active projection is available, never a stale pre-compaction percentage.

### Tests

- **`opl-footer`**: added regression coverage for the `≈` display and projected-context token estimation.

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

## [0.2.4] - 2026-09-22

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
  - This initial capability established the malformed-call filtering and incident-log behavior that remains part of the consolidated extension.

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
