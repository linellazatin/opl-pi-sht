## What this is

`opl-pi-sht` is a portable collection of coding-agent extensions for Pi, focused on cutting token cost, running the agent safely, and replacing MCP servers. Repository directories and config files use the `opl-` prefix; established Pi-facing commands and tool names stay compatible.

## Commands

All tests run with `bun test`. The full suite is:

```
npm test
```

Each extension has a targeted script that runs its unit tests followed by a smoke test with `OPL_EXTENSION` set:

```
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

The `extensions/opl-webaccess/package.json` defines `test` as an error stub (`echo "Error: no test specified" && exit 1`); ignore that script and use the root-level `test:opl-webaccess` instead.

## Architecture

The repository is organized around individual Pi extensions, each with its own helpers and tests:

- `opl-browser`, `opl-webaccess` — web access with SSRF/host blocking, per-hop redirect rechecking, screenshot safety, and `evaluate` hardening.
- `opl-footer`, `opl-guardian`, `opl-input`, `opl-modes`, `opl-questionnaire`, `opl-todo` — agent UI/behavior extensions.
- `opl-init` — crawling, fingerprinting, and packet handling.
- `opl-simplebench`, `opl-ctxtrim` — TypeScript-based utilities (their tests are `.ts`).
- `pi-host` — host loader; tested via `tests/pi-host-loader.test.mjs`.

The test layout mirrors the extension layout: most tests are `.mjs`, with `.ts` tests for the TypeScript extensions. A shared smoke test at `tests/extension-smoke.test.mjs` is parameterized by `OPL_EXTENSION`.

## Configuration and installation

Install a versioned release from npm or GitHub via:

```bash
pi install npm:@openlines/opl-pi-sht@<version>
pi install git:github.com/linellazatin/opl-pi-sht@<version.tag>
```

Both sources ship identical content. Install from only one source per machine: Pi treats the npm and Git entries as separate packages, so installing both loads every extension twice. Omitting the version on the npm source tracks the latest published release; Git refs remain pinned.

## Operational notes

- Version v0.2.8 includes SSRF and tool-safety hardening for `opl-webaccess` and `opl-browser`: private/link-local hosts are blocked by default (localhost remains available for dev), cloud metadata is always blocked, screenshots refuse to overwrite existing files, and `evaluate` handles `undefined` without crashing.
- Keep secrets and generated output out of tracked configuration.
- Inspect specific files before changing behavior; the top-level inventory includes generated outputs such as `.log` files and `plan-path` entries that should not be treated as source of truth.

## Key files

- `package.json` — root scripts and test commands.
- `CHANGELOG.md` — release history and safety changes.
- `tests/extension-smoke.test.mjs` — shared smoke test used by all extension test scripts.
- `extensions/opl-webaccess/package.json` — contains a non-functional stub test script; do not rely on it.
<!-- opl-init:fp a766ea02db1e5882 -->
