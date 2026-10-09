## What this is

`opl-pi-sht` is a portable collection of coding-agent extensions for Pi, focused on cutting token cost, running the agent safely, and replacing MCP servers. Repository directories and config files use the `opl-` prefix; established Pi-facing commands and tool names stay compatible.

## Commands

All tests run with `bun test`. The full suite is:

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

`test:shared` holds the cross-extension tests: agent-directory resolution, the duplicated network guard's parity, `install.sh`, and package metadata. `npm test` runs it first.

Typecheck separately; it is not part of `npm test`:

```
npm run typecheck
```

This runs `tsc -p tsconfig.json` in `strict` mode over `extensions/**/*.ts`. `noUncheckedIndexedAccess` is deliberately off — it reports 127 pre-existing index-access gaps, scheduled as its own sweep. CI runs the suite twice: once against the installed devDependency range, and once in a `floor` job that pins `@earendil-works/pi-coding-agent`, `pi-tui` and `pi-ai` to `0.87.0` with `typebox@1.3.27` and asserts the loader really used it (`OPL_PI_HOST_SOURCE`).

## Architecture

The repository is organized around individual Pi extensions, each with its own helpers and tests:

- `opl-browser`, `opl-webaccess` — web access with SSRF/host blocking applied to **resolved addresses**, per-hop redirect rechecking, page-request and page-WebSocket interception in the browser, screenshot safety, and `evaluate` hardening.
- `opl-footer`, `opl-guardian`, `opl-input`, `opl-modes`, `opl-questionnaire`, `opl-todo` — agent UI/behavior extensions.
- `opl-init` — crawling, fingerprinting, and packet handling.
- `opl-simplebench`, `opl-ctxtrim` — TypeScript-based utilities (their tests are `.ts`).
- `pi-host` — host loader; tested via `tests/pi-host-loader.test.mjs`.

The test layout mirrors the extension layout: most tests are `.mjs`, with `.ts` tests for the TypeScript extensions. A shared smoke test at `tests/extension-smoke.test.mjs` is parameterized by `OPL_EXTENSION`. Cross-cutting concerns live in `tests/agent-dir-config.test.mjs`, `tests/net-guard-parity.test.mjs`, `tests/install-sh.test.mjs` and `tests/package-metadata.test.mjs`, all under `test:shared`.

## Configuration and installation

Install a versioned release from npm or GitHub via:

```bash
pi install npm:@openlines/opl-pi-sht@<version>
pi install git:github.com/linellazatin/opl-pi-sht@<version.tag>
```

Both sources ship identical content. Install from only one source per machine: Pi treats the npm and Git entries as separate packages, so installing both loads every extension twice.

Installing from a clone (`./install.sh`) copies each `extensions/<name>` directory into the agent directory `PI_CODING_AGENT_DIR` names (`~/.pi/agent` by default; `PI_AGENT_DIR` is accepted as a legacy alias) and installs `configs/<name>.json` when the repo carries one, otherwise `configs/<name>.json.sample`. A config that already exists in the target is kept unless `--force-configs` is passed. What was installed is recorded in `<agent-dir>/extensions/.opl-pi-sht.installed`; on the next run, recorded directories the release no longer ships are pruned, because Pi auto-discovers `extensions/*/index.ts` and leftovers would load beside the new copy. Use `--no-prune` to keep them, `--only <name>` for a subset (`opl-footer`, `opl-input` and `opl-modes` install as a bundle), and `--link` to symlink instead of copy. Omitting the version on the npm source tracks the latest published release; Git refs remain pinned.

## Operational notes

- Version v0.2.8 includes SSRF and tool-safety hardening for `opl-webaccess` and `opl-browser`: private/link-local hosts are blocked by default (localhost remains available for dev), cloud metadata is always blocked, screenshots refuse to overwrite existing files, and `evaluate` handles `undefined` without crashing.
- Version v0.2.13 makes that policy address-based: model-supplied hostnames are resolved and every DNS answer is classified, each redirect hop is re-resolved, and `opl-browser` installs the same check as a context route **plus a WebSocket route** (Playwright's `route()` never sees `ws://`/`wss://`), blocks service workers on new contexts (routing does not see requests a worker already intercepted), and clears a page to `about:blank` when a server-side redirect lands it on a blocked host (a route handler is called for the first URL of a redirect chain only, so the second leg cannot be intercepted). Cloud metadata and unspecified addresses (`0.0.0.0/8`, `::`) are never toggleable, and IPv6 literals that embed an IPv4 (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `::ffff:`, `::a.b.c.d`) are classified by the embedded address; `allowLoopback` gates loopback in both extensions and now defaults to `false` (opt-in). Residuals to keep documenting, not claiming: resolve-then-connect rebinding (no IP pinning), blind side effects through redirects (`<img>`, no-cors fetch), and `evaluate` returning page-held data.
- The host guard is deliberately duplicated between `extensions/opl-webaccess/utils.ts` and `extensions/opl-browser/validate.ts` (between `// BEGIN SHARED HOST GUARD` / `// END SHARED HOST GUARD`) because `install.sh` installs one extension directory at a time, so it cannot be a shared import. `tests/net-guard-parity.test.mjs` fails if the two copies drift — edit both or neither.
- `opl-simplebench` **executes model-authored code**: `runCodingVerifier` runs `node --eval` over the model's files with the allowlisted environment from `extensions/opl-simplebench/util/exec-env.ts`. Keep new child processes of generated code behind that allowlist, and never forward `NODE_OPTIONS`/`NODE_PATH` — both make Node load attacker-chosen files. It limits what a child can read from the process; it is not a filesystem or network sandbox.
- External commands go through argv arrays, never shell strings, and environment-derived values that reach them are validated first (see `isValidAwsProfileName` in `extensions/opl-simplebench/benchmark.ts`). Prefer `execFile` over `execSync`: a blocking call stalls the TUI.
- `opl-guardian`'s Bash protected-path and dangerous-command rules match **words**, not substrings, and are advisory by design (`read`/`write`/`edit` is where paths are enforced through symlink resolution). When tightening either rule, keep the noise cases in `tests/opl-guardian.test.mjs` green — a rule that blocks `grep "process.env" src` gets disabled by users.
- Loopback is **opt-in** in both network extensions (`allowLoopback`, default `false`). Setting it to `true` lets a model reach dev servers, local Docker sockets and IDaaS callbacks on the machine; cloud metadata and unspecified addresses (`0.0.0.0/8`, `::`) stay blocked either way.
- Every extension resolves its config file, and `opl-simplebench` resolves `models.json`/`auth.json`, through the host's `getAgentDir()` per call. Do not reintroduce `homedir()`-based paths or read `PI_AGENT_DIR` directly: pi's variable is `PI_CODING_AGENT_DIR`, and `tests/agent-dir-config.test.mjs` fails if a loader drifts.
- Only `opl-browser` and `opl-webaccess` carry a nested `package.json` (CI audits their runtime dependencies there). They are `private`, have no `main` and no `scripts`, and keep their **own version line** (`0.2.0`) instead of mirroring the collection version; `tests/package-metadata.test.mjs` enforces this.
- Keep secrets and generated output out of tracked configuration.
- `opl-webaccess` keeps full search/fetch bodies **out of the session**: `persistResult` spills to `<agent-dir>/web-access-cache/<responseId>.json` and appends a preview entry (512 B per item, `truncated: true`, `file` path). Spill ids are filenames, so they must keep matching `/^[a-z0-9]+$/i`; anything else is refused. `pruneCache` enforces the 1 h TTL and the 32 MB ceiling. Providers and URL fetches share the `timeoutMs` deadline (default 30 s), composed with the caller's abort signal.
- `opl-modes` caps plan text: `capPlan` is the only path from a plan file to a prompt, the cap is applied **before** a custom `{plan}` template substitutes, and truncation must stay on a line boundary so multi-byte characters are never split.
- `opl-footer` renders only the rows that have visible segments, with dividers between existing rows. Keep the per-segment `try`/`catch` in `renderSegmentWithWidth` and the memoised `deriveBranchFacts` (keyed on branch length and context window): both exist because one bad input used to blank the whole footer on every frame.
- The network guard intercepts page traffic at three points: navigation (plus a frame-URL re-check that clears a page a redirect landed on a blocked host, because a route handler only sees the first URL of a redirect chain), the context route for subresources, and `routeWebSocket` for `ws://`/`wss://` handshakes. Adding a fourth Playwright traffic path (workers, CDP sessions, proxies) means extending `installGuard`, not just `makeRouteHandler`.
- Inspect specific files before changing behavior; the top-level inventory includes generated outputs such as `.log` files and `plan-path` entries that should not be treated as source of truth.

## Key files

- `package.json` — root scripts and test commands.
- `CHANGELOG.md` — release history and safety changes.
- `tests/extension-smoke.test.mjs` — shared smoke test used by all extension test scripts.
- `tests/net-guard-parity.test.mjs` — drift check for the duplicated host guard; runs under `npm run test:shared`.
- `tests/agent-dir-config.test.mjs` — proves every extension reads its config from pi's agent directory.
- `install.sh` — the only installer; see Configuration and installation above for its flag surface.
- `tsconfig.json` — strict typecheck scope for `npm run typecheck`.
- `extensions/opl-simplebench/util/exec-env.ts` — the environment allowlist for processes that run model-authored code.
- `extensions/opl-guardian/policies.ts` — path rules for file tools and the word-based Bash matcher (`bashCommandMentionsPath`).
<!-- opl-init:fp a766ea02db1e5882 -->
