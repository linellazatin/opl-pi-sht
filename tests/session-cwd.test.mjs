import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePlanDir, listPlanFiles, planFilePath } from "../extensions/opl-modes/utils.ts";
import { PLAN_DIR, PLAN_FILE_PREFIX } from "../extensions/opl-modes/config.ts";
import { getSessionCwd, setSessionCwd } from "../extensions/opl-modes/state.ts";
import { pathSegment } from "../extensions/opl-footer/segments/path.ts";
import { safeScreenshotPath } from "../extensions/opl-browser/validate.ts";

const repo = (rel) => readFileSync(new URL(rel, import.meta.url), "utf-8");

function scratch() {
  const base = join(realpathSync(tmpdir()), `opl-cwd-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

test("opl-modes writes and lists plans in the directory it is handed", () => {
  const session = scratch();
  const harnessPlans = join(process.cwd(), PLAN_DIR);
  const before = existsSync(harnessPlans) ? readdirSync(harnessPlans).sort() : null;
  try {
    const dir = ensurePlanDir(session);
    assert.equal(dir, join(session, PLAN_DIR));
    assert.ok(existsSync(dir), "the plan directory was not created in the session directory");

    const name = `${PLAN_FILE_PREFIX}resolved.md`;
    writeFileSync(planFilePath(session, name), "# Plan: Resolved\n", "utf-8");
    const listed = listPlanFiles(session);
    assert.deepEqual(listed.map((p) => p.name), [name]);
    assert.deepEqual(listed[0].title, "Resolved");
    if (before !== null) {
      assert.deepEqual(readdirSync(harnessPlans).sort(), before, "the harness plan directory was written to");
    }

    // A second, unrelated directory has no plans of its own.
    assert.deepEqual(listPlanFiles(scratch()), []);
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test("opl-modes remembers the session directory from the context, not from the process", () => {
  const session = scratch();
  const before = getSessionCwd();
  try {
    setSessionCwd(session);
    assert.equal(getSessionCwd(), session);
    assert.equal(planFilePath(getSessionCwd(), "plan-a.md"), join(session, PLAN_DIR, "plan-a.md"));
    // An empty value must not poison the remembered directory.
    setSessionCwd("");
    assert.equal(getSessionCwd(), session);
  } finally {
    setSessionCwd(before);
    rmSync(session, { recursive: true, force: true });
  }
});

test("the footer Path segment renders the session directory", () => {
  const ctx = {
    cwd: "/sessions/alpha-project/nested",
    options: { path: { mode: "basename" } },
    theme: { fg: (_color, text) => text },
    icons: { folder: "" },
  };
  const rendered = pathSegment.render(ctx);
  assert.ok(rendered.content.includes("nested"), `expected the session basename, got ${rendered.content}`);
  assert.ok(!rendered.content.includes(basename(process.cwd())), "the harness directory name leaked");

  const full = pathSegment.render({ ...ctx, options: { path: { mode: "full" } } });
  assert.ok(full.content.includes("/sessions/alpha-project/nested"), `full mode lost the session path: ${full.content}`);
});

test("the browser screenshot root is the session directory argument", () => {
  const session = scratch();
  try {
    const shot = safeScreenshotPath("capture.png", session);
    assert.equal(shot, join(session, "capture.png"));
    assert.ok(existsSync(shot));
    assert.ok(!existsSync(join(process.cwd(), "capture.png")), "the capture landed in the harness directory");
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});

test("only the documented fallbacks still consult process.cwd()", () => {
  // A write path must be resolved from the session directory. The allowed reads are the
  // pre-session fallbacks: modes' initial state, the footer's context-less render, and a
  // programmatic simplebench run with no ExtensionContext.
  const allowed = [
    "extensions/opl-modes/state.ts",
    "extensions/opl-footer/index.ts",
    "extensions/opl-footer/segments/path.ts",
    "extensions/opl-simplebench/benchmark.ts",
  ];
  const offenders = [];
  for (const file of [
    "extensions/opl-modes/index.ts",
    "extensions/opl-modes/utils.ts",
    "extensions/opl-browser/validate.ts",
    "extensions/opl-browser/browser.ts",
    "extensions/opl-browser/index.ts",
    "extensions/opl-simplebench/artifact.ts",
    "extensions/opl-guardian/policies.ts",
    "extensions/opl-init/index.ts",
    "extensions/opl-todo/index.ts",
    "extensions/opl-input/index.ts",
    "extensions/opl-questionnaire/index.ts",
    "extensions/opl-ctxtrim/index.ts",
    "extensions/opl-webaccess/index.ts",
  ]) {
    if (allowed.includes(file)) continue;
    const src = repo(`../${file}`);
    if (/process\.cwd\(\)/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `ambient cwd returned in: ${offenders.join(", ")}`);

  // The ambient-cwd default must be gone from the helpers that take an explicit directory.
  assert.ok(!/cwd: string = process\.cwd\(\)/.test(repo("../extensions/opl-browser/validate.ts")));
  assert.ok(!/join\(process\.cwd\(\), PLAN_DIR/.test(repo("../extensions/opl-modes/index.ts")));
  assert.ok(!/process\.cwd\(\)/.test(repo("../extensions/opl-modes/utils.ts")));
  assert.ok(!/path\.resolve\(process\.cwd\(\)/.test(repo("../extensions/opl-simplebench/artifact.ts")));
});
