# Repository Guide

## What this is

`opl-pi-sht` is a portable collection of Pi coding-agent extensions. Repository directories and configuration files use the `opl-` prefix, while established Pi-facing commands and tool names remain compatible.

The repository includes extension code, tests, optional configuration files, documentation, research material, images, and project metadata. The top-level directories are:

- `.github/`, `.nanomneme/`, `.pi/`, `.superpowers/`
- `configs/`, `docs/`, `extensions/`, `images/`, `research/`, `tests/`

Important root files include `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`, `install.sh`, and `package.json`.

## Commands

The test suite uses Bun. Run the full suite with:

```bash
npm test
```

This invokes the extension-specific scripts in sequence:

```bash
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
```

Each extension script runs focused tests and, where applicable, an extension smoke test using `OPL_EXTENSION`. Examples:

```bash
npm run test:opl-browser
npm run test:opl-init
npm run test:opl-todo
npm run test:opl-ctxtrim
```

The focused test files are under `tests/`, including helper, lifecycle, configuration, rendering, crawl, fingerprint, packet, and TypeScript tests. The `extensions/opl-webaccess/package.json` script is only a placeholder and exits with an error; use the root `test:opl-webaccess` script instead.

## Architecture

Extension implementations live under `extensions/`. The currently represented extension names are:

- `opl-browser`
- `opl-footer`
- `opl-guardian`
- `opl-init`
- `opl-input`
- `opl-modes`
- `opl-questionnaire`
- `opl-todo`
- `opl-webaccess`
- `opl-simplebench`
- `opl-ctxtrim`

Their behavior is exercised by extension-specific tests and shared smoke tests in `tests/extension-smoke.test.mjs`. Optional extension configuration is kept separately in `configs/`.

## Configuration and installation

Install a versioned release from npm or GitHub, choosing one source per machine:

```bash
pi install npm:@openlines/opl-pi-sht@<version>
pi install git:github.com/linellazatin/opl-pi-sht@<version.tag>
```

Installing both sources causes Pi to treat them as separate packages and load every extension twice. npm installs track the latest published release when no version is supplied; Git refs remain pinned.

Pi installs the package below `~/.pi/agent/npm/node_modules/@openlines/opl-pi-sht` or the corresponding Git checkout and runs root `npm install`. Optional extension configuration is not installed automatically; copy only the required files from that checkout’s `configs/` directory to `~/.pi/agent/configs/`.

`opl-browser` additionally requires Chromium to be installed once after package installation.

## Testing and operational quirks

Inspect the relevant extension and test files before changing behavior. Keep changes focused, preserve existing interfaces, and run the narrowest relevant test before `npm test`. Keep secrets and generated output out of tracked configuration.

## Key files

- `package.json` — root test scripts
- `extensions/` — extension implementations and package metadata
- `tests/` — extension-focused and smoke tests
- `configs/` — optional Pi extension configuration
- `README.md` — installation and package usage
- `AGENTS.md` — repository agent guidance
- `CHANGELOG.md` — project history
- `install.sh` — installation script
- `LICENSE` — license terms
<!-- opl-init:fp 52f8ab5069bcbe59 -->
