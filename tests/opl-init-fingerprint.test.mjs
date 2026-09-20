import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../extensions/opl-init/index.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "opl-init-fp-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "foo.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("fingerprint moves when dirty tracked content changes under an unchanged status line", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "foo.ts"), "export const a = 2;\n");
    const fp1 = fingerprint(root);
    writeFileSync(join(root, "foo.ts"), "export const a = 3;\n// plus 500 more lines of intent\n");
    const fp2 = fingerprint(root);
    assert.notEqual(fp1, fp2, "same ` M foo.ts` status line must not hide content changes");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "wip");
    assert.notEqual(fingerprint(root), fp2, "committing moves the fingerprint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fingerprint hashes untracked content and distinguishes root vs subdir AGENTS.md", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "note.txt"), "one\n");
    const fp1 = fingerprint(root);
    writeFileSync(join(root, "note.txt"), "two\n");
    assert.notEqual(fingerprint(root), fp1, "untracked content is hashed");
    const before = fingerprint(root);
    writeFileSync(join(root, "AGENTS.md"), "<!-- opl-init:fp deadbeefdeadbeef -->\n");
    assert.equal(fingerprint(root), before, "root AGENTS.md is excluded");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "AGENTS.md"), "local guide\n");
    assert.notEqual(fingerprint(root), before, "subdir AGENTS.md counts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subdirectory session fingerprints dirty content of files under the cwd", () => {
  const root = makeRepo();
  try {
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "f.ts"), "a\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "pkg");
    const sub = join(root, "pkg");
    writeFileSync(join(sub, "f.ts"), "b\n");
    const fp1 = fingerprint(sub);
    writeFileSync(join(sub, "f.ts"), "c-entirely-different\n");
    assert.notEqual(fingerprint(sub), fp1, "content edits under a subdir cwd must move the fingerprint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-git fingerprint reacts to content changes", () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-nogit-"));
  try {
    writeFileSync(join(root, "a.txt"), "x");
    const fp1 = fingerprint(root);
    writeFileSync(join(root, "a.txt"), "yy");
    assert.notEqual(fingerprint(root), fp1);
    assert.equal(fingerprint(root).length, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
