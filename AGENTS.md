## What this is

`opl-pi-sht` is a portable collection of coding-agent extensions for Pi, focused on cutting token cost, running the agent safely, and replacing MCP servers. Repository directories and config files use the `opl-` prefix; established Pi-facing commands and tool names stay compatible.

## Commands

Tests run under `bun test`, invoked through npm scripts. `npm test` runs every slice below via `tests/test-summary.mjs`; each script runs one slice (`test:shared` plus one per extension, and `test:pi-host`):

```
npm test
```

Each extension has a targeted script that runs its unit tests followed by a smoke test with `OPL_EXTENSION` set:

```
npm run test:shared
npm run test:opl-browser
npm run test:opl-footer
npm run test:opl-guardian
npm run test:opl-init
npm run test:opl-input
npm run test:opl-modes
npm run test:opl-questionnaire
npm run test:opl-todo
npm run test:opl-webaccess
npm run test:opl-simplebench
npm run test:opl-ctxtrim
npm run test:pi-host
```

`test:shared` holds the cross-extension tests: agent-directory resolution, parity of the two duplicated guards (host guard and git guard), the installer, package metadata, and the `globalThis` seams between `opl-modes`, `opl-footer` and `opl-input`. `npm test` runs it first.

Typecheck separately; it is not part of `npm test`:

```
npm run typecheck
```

This runs `tsc -p tsconfig.json` in `strict` mode with `noUncheckedIndexedAccess` on, over `extensions/**/*.ts`. The flag was enabled after a four-batch sweep cleared 127 index-access sites across 9 extensions; keep it on - it is what stops the `arr[0]`-typed-as-`T` crash class (empty array read as an object) from coming back in payload parsers and render loops. CI runs the suite twice: once against the installed devDependency range, and once in a `floor` job that pins `@earendil-works/pi-coding-agent`, `pi-tui` and `pi-ai` to `0.87.0` with `typebox@1.3.27` and asserts the loader really used it (`OPL_PI_HOST_SOURCE`).

## Architecture

The repository is organized around individual Pi extensions, each with its own helpers and tests:

- `opl-browser`, `opl-webaccess` - web access with SSRF/host blocking applied to **resolved addresses**, per-hop redirect rechecking, page-request and page-WebSocket interception in the browser, screenshot safety, and `evaluate` hardening.
- `opl-footer`, `opl-guardian`, `opl-input`, `opl-modes`, `opl-questionnaire`, `opl-todo` - agent UI/behavior extensions.
- `opl-init` - crawling, fingerprinting, and packet handling.
- `opl-simplebench`, `opl-ctxtrim` - TypeScript-based utilities (their tests are `.ts`). `opl-ctxtrim` trims known context-mode `ctx_*` tool descriptions in Pi provider requests. Provider handlers locate different encodings of the same tools; they do not expand its scope. Only own entries in `CTX_DESCRIPTIONS` match, and widening that table is a source change, not a configuration.
- There is no `pi-host` extension directory. `test:pi-host` loads every package extension through Pi's host loader (`tests/pi-host-loader.test.mjs`), preferring the locally installed Pi build.

The test layout mirrors the extension layout: most tests are `.mjs`, with `.ts` tests for the TypeScript extensions. A shared smoke test at `tests/extension-smoke.test.mjs` is parameterized by `OPL_EXTENSION`. Cross-cutting concerns live in `tests/agent-dir-config.test.mjs`, `tests/net-guard-parity.test.mjs`, `tests/install-sh.test.mjs` and `tests/package-metadata.test.mjs`, `tests/git-guard.test.mjs`, `tests/cross-extension-seams.test.mjs` and `tests/session-cwd.test.mjs`, all under `test:shared`.

## Configuration and installation

Install a versioned release from npm or GitHub via:

```bash
pi install npm:@openlines/opl-pi-sht@<version>
pi install git:github.com/linellazatin/opl-pi-sht@<version.tag>
```

Both sources ship identical content. Install from only one source per machine: Pi treats the npm and Git entries as separate packages, so installing both loads every extension twice.

Installing from a clone (`./install.sh`) copies each `extensions/<name>` directory into the agent directory `PI_CODING_AGENT_DIR` names (`~/.pi/agent` by default; `PI_AGENT_DIR` is accepted as a legacy alias) and installs `configs/<name>.json` when the repo carries one, otherwise `configs/<name>.json.sample`. A config that already exists in the target is kept unless `--force-configs` is passed. What was installed is recorded in `<agent-dir>/extensions/.opl-pi-sht.installed`; on the next run, recorded directories the release no longer ships are pruned, because Pi auto-discovers `extensions/*/index.ts` and leftovers would load beside the new copy. `--no-prune` retains their ownership for later cleanup; failed pruning also retains ownership and exits nonzero for retry. Invalid manifest names are ignored, and skipped link destinations are never newly claimed. Use `--no-prune` to keep them, `--only <name>` for a subset (`opl-footer`, `opl-input` and `opl-modes` install as a bundle), and `--link` to symlink instead of copy. Omitting the version on the npm source tracks the latest published release; Git refs remain pinned.

Config samples are the tracked defaults. When `configs/<extension>.json.sample` gains, renames or documents a parameter, update the live `configs/<extension>.json` in the same change; the live file is git-ignored and operator-local.

## Key files

- `package.json` - root scripts and test commands.
- `CHANGELOG.md` - release history and safety changes.
- `tests/extension-smoke.test.mjs` - shared smoke test used by all extension test scripts.
- `tests/net-guard-parity.test.mjs` - drift check for the duplicated host guard; runs under `npm run test:shared`.
- `extensions/opl-webaccess/http.ts` - the pinned transport (`resolveSafeHostUrl` → `pinnedFetch`), the body cap enforced while reading, and the `transport` test seam that replaced the `globalThis.fetch` monkey-patch.
- `tests/agent-dir-config.test.mjs` - proves every extension reads its config from pi's agent directory.
- `install.sh` - the only installer; see Configuration and installation above for its flag surface.
- `tsconfig.json` - strict typecheck scope for `npm run typecheck`.
- `extensions/opl-simplebench/util/exec-env.ts` - the environment allowlist for processes that run model-authored code.
- `extensions/opl-guardian/policies.ts` - path rules for file tools and the word-based Bash matcher (`bashCommandMentionsPath`).
- `extensions/opl-guardian/index.ts` (`appendIncident`), `extensions/opl-guardian/config.ts` (`incidentLogPath`, rotation cap) and `extensions/opl-guardian/guardian.ts` (`summarizeRemovedToolCall`, keys not values).
- `extensions/opl-init/index.ts` and `extensions/opl-footer/git-status.ts` - the duplicated git guard (`safeGitInvocation`, `gitGuardEnv`), `FP_LIMITS` and `globToRegExp`.
- `extensions/opl-browser/browser.ts` and `extensions/opl-browser/validate.ts` - page targeting (`resolvePageIndex`, `indexAfterClose`, `pageAt`) and screenshot containment plus reservation (`safeScreenshotPath`, `discardEmptyFile`).
- `tests/session-cwd.test.mjs` - pins that plans, artifacts, screenshots and the footer Path segment resolve from the session directory.

## Operational notes

- Network policy is address-based (`opl-webaccess` and `opl-browser`): model-supplied hostnames are resolved and every DNS answer is classified, and each redirect hop is re-resolved. Private/link-local hosts are blocked unless `allowPrivateNetwork` is set; loopback is blocked unless `allowLoopback` is set (both default `false`). Cloud metadata and unspecified addresses (`0.0.0.0/8`, `::`) are never toggleable, and IPv6 literals that embed an IPv4 (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `::ffff:`, `::a.b.c.d`) are classified by the embedded address. `opl-browser` installs the same check as a context route **plus a WebSocket route** (Playwright's `route()` never sees `ws://`/`wss://`), blocks service workers on new contexts (routing does not see requests a worker already intercepted), and clears a page to `about:blank` when a server-side redirect lands it on a blocked host (a route handler is called for the first URL of a redirect chain only, so the second leg cannot be intercepted).
- `opl-webaccess` **pins the socket to the address it approved**: `resolveSafeHostUrl` returns a `SafeHttpTarget` (`url`, `host`, `addresses`) and `http.ts` dials it through a `lookup` that never reaches DNS. Node's global `fetch` has no resolver hook, which is why the URL path left `fetch` behind. The pin is per hop and per call - `inflightLookups` deduplicates concurrent lookups of one host and nothing else, and no validated answer is reused across requests. Sockets are never pooled (`keepAlive: false`, a fresh agent per request), because a keep-alive socket for a name would outlive the address its hop approved. `servername` and the `Host` header keep the hostname, so TLS and virtual hosting are unchanged. Residuals to keep documenting, not claiming: `opl-browser` rebinding (Chromium resolves internally, no Playwright resolver hook - a local CONNECT proxy is the only real fix, and the loopback/private defaults are the mitigation), blind side effects through redirects (`<img>`, no-cors fetch), and `evaluate` returning page-held data.
- The host guard is deliberately duplicated between `extensions/opl-webaccess/utils.ts` and `extensions/opl-browser/validate.ts` (between `// BEGIN SHARED HOST GUARD` / `// END SHARED HOST GUARD`) because `install.sh` installs one extension directory at a time, so it cannot be a shared import. `tests/net-guard-parity.test.mjs` fails if the two copies drift - edit both or neither.
- The git guard is duplicated between `extensions/opl-init/index.ts` and `extensions/opl-footer/git-status.ts` (`// BEGIN SHARED GIT GUARD` / `// END SHARED GIT GUARD`), for the same one-directory-at-a-time reason, and the parity test fails if the copies drift. Route every git call through `safeGitInvocation(args)` + `gitGuardEnv()`: global flags before the subcommand, `--no-ext-diff --no-textconv` after it, and note that a `-c` override alone does not stop a repository-declared textconv driver. Current probes are name-only, so the wiring is pinned from source, not only by behavior.
- `opl-guardian` writes malformed-call forensics to `<agent dir>/guardian-incidents.jsonl` (`incidentLogPath`) - never the session cwd - rotates at `logging.maxBytes`, and records tool name + sorted argument **keys** + byte size, never values (`appendIncident()` takes no cwd). Tests driving `guardMessageEnd` must point `PI_CODING_AGENT_DIR` at a fixture or they write into the real `~/.pi/agent`.
- `opl-init`'s fingerprint is capped by `FP_LIMITS` (2 MB per file, 32 MB total, 5,000 paths): above a per-file or total byte ceiling a file is hashed as `meta:size:mtime`, a path past the path cap contributes `OVER_CAP`, and budget state folds into the digest so it cannot oscillate. `globToRegExp` must keep escaping metacharacters - real workspace names contain them (`packages/app(one`, `libs/c++/*`) and an unescaped interpolation threw `SyntaxError` out of `crawl()`, aborting the whole crawl.
- Cross-extension state travels on `globalThis` (`__agentMode`, `__planMode`, `__chatMode`, `__footerRequestRender`; `__caveman` comes from other builds). Treat every read as optional, malformed and possibly dead: `typeof` + `try/catch` on the render trigger, validate shape and field types, delete what you publish on `session_shutdown`, re-publish on `session_start`. `opl-input` also matches pi-tui's literal border and `↑/↓ N more` text; that coupling lives in `isSolidBorder`/`scrollIndicatorText`/`isBorderLike` and `tests/opl-input-pi-tui-markers.test.mjs` pins it against the installed pi-tui dist.
- `opl-browser` resolves every page-scoped action through `resolvePageIndex(activeIndex, count, p.index)` and never falls back to the last page: a stale selection must surface as an error, because silently navigating or screenshotting a different document is worse than a failed call. `indexAfterClose` keeps the same page selected across a close, and `new_page` selects the page it created. Bind `index` once at the dispatcher (`const target = () => pageAt(p.index)`) rather than teaching each action about it.
- A write path must resolve from the session directory (`ExtensionContext.cwd`), never `process.cwd()`: plans (`.pi/plans/`), screenshots and `opl-simplebench` artifacts all follow it. The sanctioned `process.cwd()` reads are the pre-`session_start` fallback in `opl-modes/state.ts`, the footer context builder and its Path segment, and a programmatic simplebench run with no context; `tests/session-cwd.test.mjs` fails if another one appears.
- `safeScreenshotPath` creates the file with `wx` and returns the absolute path, so refusing to overwrite and handing the path to Playwright cannot race; the capture arm must call `discardEmptyFile` when the screenshot throws. Never reintroduce an `existsSync` pre-check, and keep containment on the **real** path (symlinks followed) so a linked directory inside the project cannot carry the write out of it.
- The `opl-todo` overlay takes its row budget from pi-tui's `visible(width, height)` callback (floor-verified: pi-tui calls it every frame with both dimensions). Do not read the terminal size off `process.stdout` inside a component - the harness terminal is not necessarily the one being drawn into.
- A bash tool call whose `command` is not a string is **blocked** by `opl-guardian` and `opl-modes` and ignored by `opl-footer`'s cache invalidation. Do not coerce: `String(["rm","-rf"])` reads as `rm,-rf` to a word matcher, and there is no inspection to perform on a value that is not a command.
- `opl-simplebench` **executes model-authored code**: `runCodingVerifier` runs `node --eval` over the model's files with the allowlisted environment from `extensions/opl-simplebench/util/exec-env.ts`. Keep new child processes of generated code behind that allowlist, and never forward `NODE_OPTIONS`/`NODE_PATH` - both make Node load attacker-chosen files. It limits what a child can read from the process; it is not a filesystem or network sandbox.
- External commands go through argv arrays, never shell strings, and environment-derived values that reach them are validated first (see `isValidAwsProfileName` in `extensions/opl-simplebench/benchmark.ts`). Prefer `execFile` over `execSync`: a blocking call stalls the TUI.
- `opl-guardian`'s Bash protected-path and dangerous-command rules match **words**, not substrings, and are advisory by design (`read`/`write`/`edit` is where paths are enforced through symlink resolution). When tightening either rule, keep the noise cases in `tests/opl-guardian.test.mjs` green - a rule that blocks `grep "process.env" src` gets disabled by users.
- Loopback is **opt-in** in both network extensions (`allowLoopback`, default `false`). Setting it to `true` lets a model reach dev servers, local Docker sockets and IDaaS callbacks on the machine; cloud metadata and unspecified addresses (`0.0.0.0/8`, `::`) stay blocked either way.
- Every extension resolves its config file, and `opl-simplebench` resolves `models.json`/`auth.json`, through the host's `getAgentDir()` per call. Do not reintroduce `homedir()`-based paths or read `PI_AGENT_DIR` directly: pi's variable is `PI_CODING_AGENT_DIR`, and `tests/agent-dir-config.test.mjs` fails if a loader drifts.
- Only `opl-browser` and `opl-webaccess` carry a nested `package.json` (CI audits their runtime dependencies there). They are `private`, have no `main` and no `scripts`, and keep their **own version line** (`0.2.0`) instead of mirroring the collection version; `tests/package-metadata.test.mjs` enforces this.
- Keep secrets and generated output out of tracked configuration. The npm `files` allowlist ships only `configs/*.json.sample`, never checkout live configs; package tests exercise actual npm packing. Release validation runs `npm ci`, strict typechecking and the full suite.
- `opl-webaccess` keeps full search/fetch bodies **out of the session**: `persistResult` spills to `<agent-dir>/web-access-cache/<responseId>.json` and appends a preview entry (512 B per item, `truncated: true`, `file` path). Spill ids are filenames, so they must keep matching `/^[a-z0-9]+$/i`; anything else is refused. `pruneCache` enforces the 1 h TTL and the 32 MB ceiling. Providers and URL fetches share the `timeoutMs` deadline (default 30 s), composed with the caller's abort signal.
- `opl-modes` caps plan text: `capPlan` is the only path from a plan file to a prompt, the cap is applied **before** a custom `{plan}` template substitutes, and truncation must stay on a line boundary so multi-byte characters are never split. Count the marker and UTF-8 source path inside the budget; fall back to a generic reference or shortened notice when necessary, while session entries retain the full path separately.
- `opl-footer` renders only the rows that have visible segments, with dividers between existing rows. Keep the per-segment `try`/`catch` in `renderSegmentWithWidth` and the memoised `deriveBranchFacts` (keyed on branch length and context window): both exist because one bad input used to blank the whole footer on every frame.
- The network guard intercepts page traffic at three points: navigation (plus a frame-URL re-check that clears a page a redirect landed on a blocked host, because a route handler only sees the first URL of a redirect chain), the context route for subresources, and `routeWebSocket` for `ws://`/`wss://` handshakes. Adding a fourth Playwright traffic path (workers, CDP sessions, proxies) means extending `installGuard`, not just `makeRouteHandler`.
- `.gitignore` marks `research/`, `docs/`, `err/`, `.pi/`, `.nanomneme/` and the live `configs/opl-*.json` files as local material, not source of truth. Inspect the owning source file before changing behavior.

<!-- opl-init:fp c2f157ba4dc50c08 -->
