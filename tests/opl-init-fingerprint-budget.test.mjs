import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprint, fingerprintGit } from "../extensions/opl-init/index.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "opl-init-budget-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

const LIMITS = { maxFileBytes: 8, maxTotalBytes: 16, maxPaths: 3 };
const T1 = new Date(1700000000000);
const T2 = new Date(1700003600000);

function freeze(root, rel, stamp = T1) {
  utimesSync(join(root, rel), stamp, stamp);
}

test("a file over the per-file cap is represented by metadata, not bytes", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "big.bin"), "a".repeat(64));
    freeze(root, "big.bin");
    const before = fingerprintGit(root, LIMITS);

    // Same size, same timestamps: this is the accepted blind spot of metadata mode.
    writeFileSync(join(root, "big.bin"), "b".repeat(64));
    freeze(root, "big.bin");
    assert.equal(fingerprintGit(root, LIMITS), before, "content of a capped file is not read");

    writeFileSync(join(root, "big.bin"), "b".repeat(96));
    freeze(root, "big.bin");
    assert.notEqual(fingerprintGit(root, LIMITS), before, "a size change is still detected");

    writeFileSync(join(root, "big.bin"), "b".repeat(64));
    freeze(root, "big.bin", T2);
    assert.notEqual(fingerprintGit(root, LIMITS), before, "a timestamp change is still detected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the byte budget stops the pass reading further files", () => {
  const root = makeRepo();
  const limits = { maxFileBytes: 12, maxTotalBytes: 25, maxPaths: 10 };
  try {
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      writeFileSync(join(root, name), "x".repeat(10));
      freeze(root, name);
    }
    const before = fingerprintGit(root, limits);

    // Sorted order is one.ts, three.ts, two.ts: the first two fit inside 25 bytes, so
    // two.ts is the entry that crosses maxTotalBytes and becomes metadata.
    writeFileSync(join(root, "two.ts"), "y".repeat(10));
    freeze(root, "two.ts");
    assert.equal(fingerprintGit(root, limits), before, "the over-budget file was never read");

    writeFileSync(join(root, "one.ts"), "y".repeat(10));
    freeze(root, "one.ts");
    assert.notEqual(fingerprintGit(root, limits), before, "files inside the budget are read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the path cap stays stable and still sees names", () => {
  const root = makeRepo();
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `f${i}.ts`), "content changed");
      freeze(root, `f${i}.ts`);
    }
    const first = fingerprintGit(root, LIMITS);
    assert.equal(fingerprintGit(root, LIMITS), first, "an over-cap tree must not oscillate");

    writeFileSync(join(root, "f6.ts"), "content changed");
    freeze(root, "f6.ts");
    assert.notEqual(fingerprintGit(root, LIMITS), first, "a new path is still visible past the cap");

    // Past maxPaths only the name is hashed, so neither content nor mtime is read.
    const capped = fingerprintGit(root, LIMITS);
    writeFileSync(join(root, "f4.ts"), "different bytes here");
    freeze(root, "f4.ts", T2);
    assert.equal(fingerprintGit(root, LIMITS), capped, "an over-cap path is name-only");

    writeFileSync(join(root, "f0.ts"), "different bytes here");
    freeze(root, "f0.ts", T2);
    assert.notEqual(fingerprintGit(root, LIMITS), capped, "paths inside the cap are read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with the shipped limits a large file is statted, not read", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.log("[opl-init] running as root; permission proof skipped");
    return;
  }
  const root = makeRepo();
  try {
    const body = "z".repeat(3 * 1024 * 1024);
    writeFileSync(join(root, "weights.dat"), body);
    freeze(root, "weights.dat");
    const readable = fingerprint(root);
    // If the pass still tried to hash these bytes it would read the file; as mode 000 it
    // cannot, so a content-hash implementation would return a different digest.
    chmodSync(join(root, "weights.dat"), 0o000);
    try {
      assert.equal(fingerprint(root), readable, "metadata mode never opens the file");
    } finally {
      chmodSync(join(root, "weights.dat"), 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged tree fingerprints identically with the shipped limits", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "note.md"), "hello\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    assert.equal(fingerprint(root), fingerprint(root));
    git(root, "add", ".");
    assert.notEqual(fingerprint(root), fingerprint(join(root, "src")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
