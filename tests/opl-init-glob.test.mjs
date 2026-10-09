import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crawl } from "../extensions/opl-init/index.ts";

function workspace(dirs, globs, file = "pnpm-workspace.yaml") {
  const root = mkdtempSync(join(tmpdir(), "opl-init-glob-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  const body =
    file === "Cargo.toml"
      ? `[workspace]\nmembers = [${globs.map((g) => `"${g}"`).join(", ")}]\n`
      : `packages:\n${globs.map((g) => `  - "${g}"`).join("\n")}\n`;
  writeFileSync(join(root, file), body);
  try {
    return crawl(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// P2-5: these patterns used to reach `new RegExp` raw and throw SyntaxError out of
// crawl(), which aborted /init on a file pnpm itself accepts.
test("regex-syntax directory names no longer abort the crawl", () => {
  const a = workspace(["packages/app(s", "packages/ok"], ["packages/app(s", "packages/*"]);
  assert.deepEqual(a.workspaceMembers, ["packages/app(s", "packages/ok"]);
  assert.deepEqual(a.skippedGlobs, [], "an escaped literal compiles, so nothing is skipped");

  const b = workspace(["packages/a[", "packages/b"], ["packages/a[", "packages/b"]);
  assert.deepEqual(b.workspaceMembers, ["packages/a[", "packages/b"]);

  const c = workspace(["libs/c++/util", "libs/plain"], ["libs/c++/*", "libs/plain"]);
  assert.deepEqual(c.workspaceMembers, ["libs/c++/util", "libs/plain"], "`+` is not a quantifier");
});

test("metacharacters match literally rather than by accident", () => {
  const result = workspace(
    ["packages/a.b", "packages/axb", "packages/a|b", "packages/a^b"],
    ["packages/a.b", "packages/a|b", "packages/a^b"],
  );
  assert.deepEqual(
    [...result.workspaceMembers].sort(),
    ["packages/a.b", "packages/a^b", "packages/a|b"].sort(),
  );
});

test("scoped packages, single-character wildcards and trailing slashes work", () => {
  const result = workspace(
    ["packages/@scope/one", "packages/two", "pkg-x/app", "pkg-y/app", "pkg-zz/app"],
    ["packages/@scope/*", "packages/*/", "pkg-?/app"],
  );
  assert.ok(result.workspaceMembers.includes("packages/@scope/one"), "scoped packages match");
  assert.ok(result.workspaceMembers.includes("packages/two"), "trailing slash stays optional");
  assert.deepEqual(
    result.workspaceMembers.filter((m) => m.startsWith("pkg-")).sort(),
    ["pkg-x/app", "pkg-y/app"],
    "? matches exactly one character",
  );
});

test("a mid-pattern ** still spans segments", () => {
  const result = workspace(["apps/a/b/src", "apps/a/src"], ["apps/**/src"]);
  assert.deepEqual(result.workspaceMembers, ["apps/a/b/src", "apps/a/src"]);
});

test("a glob that trims to nothing is skipped and reported in the tree", () => {
  const result = workspace(["packages/x"], ["/", "packages/*"]);
  assert.deepEqual(result.workspaceMembers, ["packages/x"]);
  assert.deepEqual(result.skippedGlobs, ["/"]);
  assert.ok(
    result.tree.some((l) => l.includes("skipped workspace glob") && l.includes("/")),
    `the tree must name what it dropped, got ${JSON.stringify(result.tree.slice(-3))}`,
  );
});

test("a Cargo workspace entry with regex syntax does not throw", () => {
  const result = workspace(["crates/ok", "crates/(bad"], ["crates/ok", "crates/(bad"], "Cargo.toml");
  assert.deepEqual(result.workspaceMembers, ["crates/(bad", "crates/ok"]);
  assert.deepEqual(result.skippedGlobs, []);
});
