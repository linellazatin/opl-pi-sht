import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";

import { capPlan, buildExecutePrompt, buildRefinePrompt } from "../extensions/opl-modes/config.ts";

const REPO = join(import.meta.dirname, "..");

// A plan body with predictable lines: `line NNNN…` so truncation lands on a boundary.
function bigPlan(lines) {
  return `# Plan: big\n` + Array.from({ length: lines }, (_, i) => `step ${i}: do a thing worth writing down`).join("\n") + "\n";
}

function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * USER_CONFIG is resolved at module load, so config-driven behaviour must run in a
 * child process with PI_CODING_AGENT_DIR pointed at a fixture. The child prints JSON
 * and the parent asserts, because a throw in `bun -e` still exits 0.
 */
function evalUnderConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), "opl-modes-budget-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  if (config !== null) writeFileSync(join(dir, "configs", "opl-modes.json"), JSON.stringify(config));
  const script = join(dir, "probe.mjs");
  writeFileSync(
    script,
    `import { USER_CONFIG, capPlan, buildExecutePrompt, buildRefinePrompt } from ${JSON.stringify(join(REPO, "extensions/opl-modes/config.ts"))};
const plan = Array.from({ length: 800 }, (_, i) => "step " + i + ": " + "x".repeat(60)).join("\\n");
const capped = capPlan(plan, USER_CONFIG.plan.maxInjectBytes, "/tmp/plan.md");
console.log(JSON.stringify({
  maxInjectBytes: USER_CONFIG.plan.maxInjectBytes,
  maxEntryBytes: USER_CONFIG.plan.maxEntryBytes,
  planBytes: Buffer.byteLength(plan, "utf8"),
  injectBytes: Buffer.byteLength(buildExecutePrompt(plan, "/tmp/plan.md"), "utf8"),
  refineBytes: Buffer.byteLength(buildRefinePrompt(plan, "/tmp/plan.md"), "utf8"),
  cappedBytes: Buffer.byteLength(capped.text, "utf8"),
  marker: capped.text.slice(capped.text.lastIndexOf("[…")),
}));
`,
  );
  const run = spawnSync("bun", [script], {
    cwd: REPO,
    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
    encoding: "utf-8",
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
  return fn(JSON.parse(run.stdout.trim().split("\n").pop()));
}

test("capPlan leaves a plan under the ceiling untouched", () => {
  const plan = bigPlan(20);
  const capped = capPlan(plan, 24000, "/tmp/plan.md");
  assert.equal(capped.truncated, false);
  assert.equal(capped.omittedBytes, 0);
  assert.equal(capped.text, plan);
});

test("capPlan truncates on a line boundary, announces the omission and fits the ceiling", () => {
  const plan = bigPlan(600);
  assert.ok(bytes(plan) > 6000, "fixture must exceed the test ceiling");
  const capped = capPlan(plan, 6000, "/repo/.pi/plans/plan-x.md");
  assert.equal(capped.truncated, true);
  assert.ok(bytes(capped.text) <= 6000, `capped output is ${bytes(capped.text)} bytes`);
  assert.match(capped.text, /plan truncated: showing \d+ of \d+ bytes/);
  assert.ok(capped.text.includes("/repo/.pi/plans/plan-x.md"), "marker must name the file to read");
  // Everything kept is a prefix of the original, broken between lines.
  const head = capped.text.slice(0, capped.text.indexOf("\n\n[…"));
  assert.ok(plan.startsWith(head));
  assert.ok(!head.endsWith("\n"), "cut lands before the newline that starts the next line");
  assert.equal(capped.omittedBytes, bytes(plan) - bytes(head));
});

test("capPlan never splits a multi-byte character", () => {
  const plan = "é".repeat(4000); // 2 bytes each
  const capped = capPlan(plan, 1001, "p.md");
  assert.equal(capped.text.startsWith("\uFFFD"), false);
  assert.ok(!capped.text.includes("\uFFFD"));
  assert.ok(bytes(capped.text) <= 1001);
});

test("capPlan treats a non-positive ceiling as no ceiling", () => {
  const plan = bigPlan(50);
  assert.equal(capPlan(plan, 0, "p.md").text, plan);
  assert.equal(capPlan(plan, -5, "p.md").truncated, false);
});

test("execute and refine prompts cap the plan and keep the default 24 KB ceiling", () => {
  evalUnderConfig(null, (r) => {
    assert.equal(r.maxInjectBytes, 24000);
    assert.equal(r.maxEntryBytes, 4096);
    assert.ok(r.planBytes > r.maxInjectBytes * 2, "fixture must be well over the ceiling");
    assert.ok(r.cappedBytes <= 24000, `capped body is ${r.cappedBytes}`);
    assert.ok(r.marker.includes("/tmp/plan.md"));
    // The prompts add their own instruction text, so assert the plan body inside them is bounded.
    assert.ok(r.injectBytes < r.planBytes, "execute prompt must not carry the whole plan");
    assert.ok(r.refineBytes < r.planBytes, "refine prompt must not carry the whole plan");
    assert.match(r.marker, /plan truncated/);
  });
});

test("plan.maxInjectBytes from config is honoured", () => {
  evalUnderConfig({ plan: { maxInjectBytes: 3000, maxEntryBytes: 500 } }, (r) => {
    assert.equal(r.maxInjectBytes, 3000);
    assert.equal(r.maxEntryBytes, 500);
    assert.ok(r.cappedBytes <= 3000, `capped body is ${r.cappedBytes}`);
  });
});

test("a bogus plan budget falls back to the default instead of disabling the cap", () => {
  for (const bad of [0, -1, 1500.5, "24000", null, true]) {
    evalUnderConfig({ plan: { maxInjectBytes: bad } }, (r) => {
      assert.equal(r.maxInjectBytes, 24000, `value ${JSON.stringify(bad)} must not be trusted`);
    });
  }
});

test("the shipped sample documents both ceilings at the code defaults", () => {
  const sample = JSON.parse(readFileSync(join(REPO, "configs", "opl-modes.json.sample"), "utf-8"));
  assert.equal(sample.plan.maxInjectBytes, 24000);
  assert.equal(sample.plan.maxEntryBytes, 4096);
  assert.ok((sample.plan._comment ?? "").length > 60, "the sample must explain what each ceiling does");
});
