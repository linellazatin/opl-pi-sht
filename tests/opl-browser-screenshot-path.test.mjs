import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { safeScreenshotPath, discardEmptyFile } from "../extensions/opl-browser/validate.ts";

let count = 0;
function workspace() {
  const base = join(realpathSync(tmpdir()), `opl-shot-${process.pid}-${count++}`);
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, outside };
}

function cleanup(root) {
  return () => rmSync(dirname(root), { recursive: true, force: true });
}

test("a screenshot path must stay inside the session directory", () => {
  const { root, outside } = workspace();
  try {
    assert.throws(() => safeScreenshotPath("../escape.png", root), /within the project directory/);
    assert.throws(() => safeScreenshotPath(join(outside, "escape.png"), root), /within the project directory/);
    assert.ok(!existsSync(join(dirname(root), "escape.png")), "the rejected path was created anyway");
  } finally {
    cleanup(root)();
  }
});

test("a symlinked parent directory cannot carry the write outside the session directory", () => {
  const { root, outside } = workspace();
  try {
    const victim = join(outside, "credentials.png");
    writeFileSync(victim, "keep me\n");
    symlinkSync(outside, join(root, "shots"), "dir");
    assert.throws(
      () => safeScreenshotPath("shots/credentials.png", root),
      /resolves outside the project directory/,
      "a symlinked directory let the write escape",
    );
    assert.equal(readFileSync(victim, "utf-8"), "keep me\n", "the file behind the symlink changed");
  } finally {
    cleanup(root)();
  }
});

test("a symlink as the target is refused even when it points inside the session directory", () => {
  const { root } = workspace();
  try {
    const real = join(root, "important.png");
    writeFileSync(real, "original\n");
    symlinkSync(real, join(root, "link.png"));
    assert.throws(() => safeScreenshotPath("link.png", root), /already exists/, "a symlink target was reserved");
    assert.equal(readFileSync(real, "utf-8"), "original\n", "the symlinked file was overwritten");
    assert.ok(lstatSync(join(root, "link.png")).isSymbolicLink(), "the symlink itself was replaced");
  } finally {
    cleanup(root)();
  }
});

test("an existing regular file is refused and left untouched", () => {
  const { root } = workspace();
  try {
    const existing = join(root, "done.png");
    writeFileSync(existing, "previous capture\n");
    assert.throws(() => safeScreenshotPath("done.png", root), /already exists/);
    assert.equal(readFileSync(existing, "utf-8"), "previous capture\n");
  } finally {
    cleanup(root)();
  }
});

test("the reservation is atomic: a second request for the same path is refused, not raced", () => {
  const { root } = workspace();
  try {
    const first = safeScreenshotPath("capture.png", root);
    assert.equal(first, join(root, "capture.png"));
    assert.equal(statSync(first).size, 0, "the reservation should leave an empty file");
    // Playwright writes into this path next; a second tool call must not be able to claim it.
    assert.throws(() => safeScreenshotPath("capture.png", root), /already exists/);
  } finally {
    cleanup(root)();
  }
});

test("missing parent directories are created and the extension is validated first", () => {
  const { root } = workspace();
  try {
    const nested = safeScreenshotPath(join("shots", "2026", "page.jpg"), root);
    assert.equal(nested, join(root, "shots", "2026", "page.jpg"));
    assert.ok(existsSync(dirname(nested)));
    assert.equal(statSync(nested).size, 0);
    // Uppercase extensions are still images.
    assert.ok(safeScreenshotPath("UPPER.PNG", root));
    assert.throws(() => safeScreenshotPath("notes.txt", root), /\.png or \.jpg/);
    assert.throws(() => safeScreenshotPath("no-extension", root), /\.png or \.jpg/);
    assert.ok(!existsSync(join(root, "notes.txt")), "a rejected name was created");
  } finally {
    cleanup(root)();
  }
});

test("the session directory is a required argument, never an ambient cwd", () => {
  const { root } = workspace();
  const source = readFileSync(new URL("../extensions/opl-browser/validate.ts", import.meta.url), "utf-8");
  const body = source.slice(source.indexOf("export function safeScreenshotPath"));
  try {
    assert.throws(
      // exercising the JS surface: a missing cwd must not fall back to process.cwd()
      () => safeScreenshotPath(),
      /project directory|cwd|undefined/,
    );
    assert.ok(!/cwd: string = process\.cwd\(\)/.test(body), "the ambient-cwd default returned");
    assert.ok(!/existsSync\(abs\)/.test(body), "the existsSync TOCTOU check returned");
  } finally {
    cleanup(root)();
  }
});

test("discardEmptyFile removes only a leftover empty reservation", () => {
  const { root } = workspace();
  try {
    const empty = safeScreenshotPath("left-over.png", root);
    discardEmptyFile(empty);
    assert.ok(!existsSync(empty), "the empty reservation was not cleaned up");

    const written = safeScreenshotPath("captured.png", root);
    writeFileSync(written, "PNG-bytes");
    discardEmptyFile(written);
    assert.equal(readFileSync(written, "utf-8"), "PNG-bytes", "a real screenshot was deleted");

    discardEmptyFile(join(root, "never-existed.png"));
    unlinkSync(written);
  } finally {
    cleanup(root)();
  }
});
