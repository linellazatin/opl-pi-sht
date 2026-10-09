# Live extension test manual

Use this runbook when an operator asks to test this checkout's extensions in a running Pi session. Run one extension per phase, in the order below. These instructions test the loaded runtime; automated suites provide separate checkout coverage. Do not treat either as a substitute for the other.

## Ground rules

- Read `AGENTS.md`, root `README.md`, `package.json`, and the current phase's extension README and entrypoint before probing it. Source and current tool schemas take precedence over these examples if they change.
- Execute inline. Do not delegate unless the operator explicitly requests delegation. Track phases with the todo tool and mark each assessed phase immediately, including phases with documented gaps.
- Preserve existing source edits, configuration, tasks, tabs, and session state. Default to no source/config changes, no dependency installation, no reload, no mode/model switching, and no generated files in the checkout. Live todo entries and webaccess cache/session entries are expected side effects; browser startup and lazy activation also change process state.
- Ask for approval before paid model benchmarks, generated-code execution, `/init`, screenshots that create files, destructive confirmations, branch/session changes, or reloads. Never test guards with a command that would be dangerous if the guard failed.
- Never inspect credentials, dump the environment, or print whole settings/config files. Inspect only installation paths and necessary non-secret fields. Do not bypass a guard to make a test pass.
- Run a phase's targeted script once and read both unit and smoke results. Capture command, exit status, counts, and failures. Do not hardcode counts from a previous run.
- Use actual registered tools for live checks. A shell process importing an extension or a mocked handler is not evidence about the current session. Do not send a slash command to Bash or imply that writing `/mode` in a reply executes it.
- Ask the operator to observe terminal-only behavior. Use `questionnaire` when available; if it fails or is unavailable, ask in plain text. Record observations as user-confirmed, not agent-inspected.
- Expected policy denials and validation errors are successful negative tests. A network timeout, missing dependency, unavailable UI, or disabled configuration is not a successful live test. Record the exact result and investigate before labeling it a code defect.
- If an unexpected failure occurs, stop that phase, retain the smallest reproduction and exact error, inspect the relevant code/configuration without exposing secrets, and report the blocker. Do not silently repair the extension or weaken policy during a test run.

## 0. Inventory and evidence setup

1. Announce the scope: sequential extension phases, safe probes, no source/config edits, and explicit live-versus-automated evidence. Unless the operator requested a pause after each phase, continue safe phases and pause only for necessary observations or approvals.
2. Record `pwd`, `git status --short`, checkout extension names, and agent-directory extension symlink targets. Use Pi's resolved agent directory when available; otherwise report the documented `PI_CODING_AGENT_DIR` location or default `~/.pi/agent`. A legacy `PI_AGENT_DIR` value alone does not prove where this host loads extensions.
3. Compare checkout entries with symlinks and resource settings. Inspect only relevant `extensions`/`packages` path entries from user/project settings and project `.pi/extensions`; do not expose authentication or unrelated settings. A missing symlink might be supplied by a package, glob, explicit CLI path, or project resource. Record uncertainty instead of declaring it unloaded.
4. Inventory tools visible to the current model. If `load_tools` exists, activate only tools needed for a phase. Activating a schema proves registration/activation, not that its implementation works.
5. Distinguish three facts: checkout source exists; an installation path points to it; the running process executed observed behavior. Symlinks do not hot-reload modules. If edits occurred after startup or the runtime version cannot be established, state that latest-source activation is unconfirmed. Reload only with approval after the current turn settles.
6. Define per-phase success criteria and use the evidence labels below. Take a baseline before any approved repository mutation so final verification can detect unintended changes.

Evidence labels:

- **Live observed:** current-session tool result reproduced the expected behavior.
- **User-confirmed UI:** operator observed rendering/input behavior in this session.
- **Automated passed/failed:** fresh targeted suite output; includes whether its entrypoint smoke check ran.
- **Skipped/unverified:** capability unavailable, approval absent, installation uncertain, or scenario not exercised. Include the reason.

## 1. opl-todo

Run `npm run test:opl-todo`.

1. Call `todo({ action: "list" })` and record existing tasks. Do not clear them. Adding after an entirely completed list starts a fresh batch and resets IDs; if preserving that completed list matters, request approval or skip the add probe.
2. Add one clearly named live-test task. Use the returned ID, not an assumed ID. List it, toggle it complete, toggle it incomplete, and list again. Expected: the same task survives and its completion flag changes both ways.
3. Choose a nonexistent ID after inspecting the list and toggle it. Expected: a not-found result and no mutation of other tasks. List again to verify preservation.
4. Mark only test/phase tasks completed when done. Do not call `clear` on an existing user list. Note that completing every task can trigger overlay auto-hide and the next add can reset the batch.
5. Ask whether the overlay appeared/updated without taking editor focus. Below 80 columns, hidden overlay behavior is expected. Height budgets, shortcuts, `/todos`, branch restoration, and all-done reset remain automated-only unless separately observed with approval.

## 2. opl-questionnaire

Run `npm run test:opl-questionnaire`.

1. Invoke a valid two-question questionnaire with unique IDs, selectable options, and short labels. Useful questions are the todo-overlay observation and whether to continue safe phases or pause after each extension.
2. Ask the operator to navigate/select and submit. Expected: both answer IDs and selected values return; neither question is silently omitted. Follow the returned pacing preference.
3. Later UI-observation calls can exercise the single-question form. Custom text, cancellation, narrow-terminal rendering, and incomplete-submit prevention are not live-verified merely because normal submission worked.
4. If the tool reports non-interactive mode, record the live UI limitation and continue with plain-text questions. Do not infer that the TUI is broken from a headless-session error.

## 3. opl-modes

Run `npm run test:opl-modes`.

1. If `load_tools` is registered, call it with a deliberately unknown name such as `opl_live_probe_unknown_tool`. Expected: no tool enabled, with a clear no-op result.
2. Request `browser`, then request it again. Expected in a permitting mode: first call enables it if withheld; second call is a no-op. If already active, both can be no-ops. If the active mode forbids it, refusal is expected; do not change modes to circumvent policy.
3. Record that loader checks do not establish restricted-mode enforcement. Do not issue destructive Bash probes in normal mode or deliberately malformed schema inputs that the host will reject before extension handlers.
4. Optional operator-assisted transition check: with approval, have the operator enter `/mode chat`, verify the restricted tool set and appearance, then return to the original mode. Use only intrinsically safe Bash probes, such as a harmless quoted command substitution, for denial checks. Account for configured mode/model overrides before switching. Do not create or execute plans during the default run.

## 4. opl-guardian

Run `npm run test:opl-guardian`.

1. After checking the applicable non-secret path policy, attempt `read` on `.env/opl-live-test-nonexistent.txt`, not on a real secret file. Under the default rule, expect an explicit `[opl-guardian]` protected-path denial before filesystem access. If `.env` protection was intentionally disabled, this is a configuration gap, not proof of a regression; do not retry against a real secret.
2. Run a harmless text search such as `grep -n 'process.env' extensions/opl-guardian/config.ts`. Expected: execution is allowed. Exit 1 with no matches is normal for grep and does not indicate a guard failure.
3. Do not execute recursive deletion, `sudo`, environment dumps, or credential reads to test confirmation. Destructive-session confirmations, malformed-provider-call filtering, incident rotation/redaction, and non-string Bash handling remain automated-only by default. Tests that write incident logs must use fixture agent directories, never the real operator directory.

## 5. opl-webaccess

Run `npm run test:opl-webaccess`.

1. Call `fetch_content` with a public documentation URL, for example `https://example.com`, and one permanently blocked address. A negative probe can use `http://169.254.169.254/opl-live-test-nonexistent` to avoid credential routes; never request metadata credential/token endpoints. Verify from current code that the literal is rejected before connection. Expected: readable public content and a blocked-host error for the negative sibling, rather than losing both results.
2. Capture the returned `responseId`. Call `get_search_content` with that ID and the exact successful URL. Expected: matching stored content. Use a definitely out-of-range `urlIndex`; expect a clear missing-URL error.
3. If a configured provider is available and provider traffic is approved, issue one short `web_search` query such as `IANA example domains reserved documentation`. Expected: answer/results with source URLs where supported and a new response ID. If credentials/provider/network are unavailable, record search as blocked or skipped; successful fetch does not prove search works.
4. Do not reuse old response IDs. Full bodies spill into the agent cache and bounded previews enter session entries; this is an expected live side effect. Cache TTL, disk rehydration after restart, pagination under large bodies, redirect pinning, PDF extraction, compression, and byte/deadline limits remain automated-only unless explicitly exercised.

## 6. opl-browser

Run `npm run test:opl-browser`. Activate `browser` through `load_tools` if necessary and permitted.

1. Establish whether the session already owns valuable browser tabs. `pages` initializes a browser if none exists. If existing tabs are in use, request approval for isolated test tabs and record original selection; otherwise skip destructive tab/close checks. Never close unrelated tabs or the entire shared browser.
2. In a fresh, disposable browser, call `pages`, navigate to a public documentation URL, then call `snapshot` and `extract` with a known unique selector such as `p:first-of-type`. Expected: correct URL/title, accessibility content, and scoped Markdown.
3. Call `evaluate` with `script: "undefined"`. Expected: an explicit undefined-result message, not a crash.
4. Open a blank `new_page`. In this disposable browser, close the earlier test page by its recorded index. Evaluate `({ title: document.title, url: location.href })` without an index. Expected: selection still identifies the blank page, with its index adjusted after the earlier close.
5. Evaluate with an out-of-range explicit index. Expected: an index error, never fallback to another tab.
6. Navigate to the permanently blocked address used in phase 5. Expected: host-policy denial. Request a screenshot path outside the session project, for example `/tmp/opl-live-test-outside-project.png` on a Unix host. Expected: containment denial and no file creation. Do not capture an actual screenshot by default.
7. Open another disposable blank page and evaluate `window.close()`. After closure is observed, call a page-scoped action without an index. Expected: selected-page-closed error, not silent retargeting. Recover with `select_page` and an index obtained from `pages`. If closure is asynchronous, establish that it occurred before interpreting the result; do not assume a timing race is a regression.
8. Close the browser only if this phase created a disposable browser with no pre-existing tabs. Otherwise close only test tabs and restore the original selection. Record cleanup. WebSocket/subresource guards, redirects, DNS-rebinding residuals, screenshot overwrite/symlink protection, and large-result paging are separate coverage areas, not established by these navigation checks.

## 7. opl-simplebench

Run `npm run test:opl-simplebench`.

1. Activate `simplebench` if allowed. It has no status/discovery tool action; omitting a model normally benchmarks the selected model, so do not call it with empty arguments.
2. After verifying that current code rejects tags before benchmark work, call `simplebench({ no_artifact: true, tag: "live probe invalid tag" })`. Expected: single-word-tag validation error with no inference, credential lookup, artifact, or generated-code execution.
3. This proves only live registration and early validation. The suite covers benchmark orchestration and verifier-environment canaries; it does not establish current provider credentials or live inference.
4. Run a real benchmark only with explicit approval for model, suite, cost/runtime, artifact policy, and generated-code risk. Prefer `no_artifact: true` when no files are requested. Coding-lite executes model-authored code under the user's filesystem/network permissions; its environment allowlist is not a sandbox. Do not run `test_all` merely for extension smoke coverage.

## 8. opl-init

Run `npm run test:opl-init`.

1. Default to automated-only assessment. `/init` can call the selected model, replace `AGENTS.md`, and reload the runtime. Do not invoke it in a dirty checkout without explicit approval, even if an existing fingerprint looks current.
2. If approved, first preserve the operator's guide and record the model-call/write/reload expectations. Have the operator invoke `/init` when the session can settle safely. A current fingerprint should skip model/write/reload work; a stale guide may run all three. Observe the actual outcome, not just a notification that the command was registered.
3. Do not claim live crawl/refinement/reload coverage from mocked tests or from the separate host-loader test. Restore only test-owned changes with approval; never overwrite concurrent operator edits.

## 9. opl-ctxtrim

Run `npm run test:opl-ctxtrim`.

1. Check installation resources if activation is uncertain. This extension exposes no tool or command. A missing symlink is a finding to investigate, not permission to install or reload it.
2. Report fresh provider-shape/schema measurements separately from runtime evidence. The suite may use the installed context-mode server and prints measured savings; those are schema-byte measurements, not current-session billing/token measurements. If that server is absent, report the suite's actual behavior without substituting historical counts.
3. A session without allowlisted `ctx_*` declarations has no applicable live trimming case. Proving runtime transformation requires an approved request-inspection setup with before/after tool descriptions and unchanged schema semantics. Never dump provider payloads containing prompts or credentials. If this capability is unavailable, mark current-session trimming unverified.

## 10. opl-input

Run `npm run test:opl-input`.

1. Ask whether the custom editor framing/prefix is normal and whether typing and slash-menu behavior have worked in this session. Offer separate choices for full observation, visual-only, a problem, and not observed.
2. Do not execute slash commands solely to obtain a positive answer. A questionnaire's custom text editor is not evidence about `opl-input`'s main editor.
3. Record operator confirmation precisely. Normal appearance does not prove mode-style transitions, companion animation, long-input scrolling, paste/history, narrow-terminal fallback, or timer cleanup. Tests cover style helpers, timer behavior, and coupling to pi-tui's emitted border/scroll markers.

## 11. opl-footer

Run `npm run test:opl-footer`.

1. Ask whether enabled footer rows remained visible and values updated during the preceding tool calls, without unexpected clipping or blanking. Offer visual-only and unobserved options; do not require segments absent from the operator's layout.
2. Record the observed fields. During an active run, status need not be `Ready`; that transition happens only after the agent settles. Do not claim post-settle behavior while the current turn is still running.
3. Do not alter `/configure-opl`, switch providers, or enable quota endpoints just for a smoke check. Branch/compaction cache invalidation, optional quota refreshes, configuration persistence, empty-row budgets, and fault isolation remain automated-only unless separately exercised with approval.

## Final integration and integrity

After all requested phases are assessed, run these separately from the extension phases:

```bash
npm run test:shared
npm run typecheck
npm run test:pi-host
```

Read every exit status. Shared tests cover configuration resolution, duplicated guards, seams, installer/package behavior, and session-directory handling. The host-loader test loads checkout entrypoints in a separate runtime and reports the Pi build it actually used; do not assume it used the installed build if it reports a devDependency fallback. Passing it does not prove the current session loaded the latest source.

Compare final `git status --short`, `git diff --stat`, and untracked files against the baseline. If approved files were created, list them and remove only test-owned artifacts with permission. Verify browser cleanup, mark the final tracking task assessed, and report any state changes such as lazy tools now remaining active. Do not reset the user's modes or tasks to tidy the run.

## Reporting template

For each phase, provide a short result before moving on:

```text
Phase N: opl-<name>
Automated: command, exit status, unit/smoke pass/fail counts.
Live observed: probes and actual results, including expected denials.
User-confirmed UI: exact observed behavior, or unavailable.
Skipped/unverified: scenarios and reasons.
Side effects/cleanup: test-owned state or artifacts, and cleanup result.
Findings: unexpected failure/configuration gap/activation uncertainty, if any.
```

The final summary must separate automated totals, directly observed live behavior, user observations, and unresolved gaps. Do not say “all extensions live-tested” when some were automated-only. Never copy this runbook's original session results as fresh evidence. If troubleshooting is needed, start with a concise TL;DR, then the exact reproduction and remaining uncertainty.
