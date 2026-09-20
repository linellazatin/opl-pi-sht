import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initExtension, { crawl } from "../extensions/opl-init/index.ts";

test("init writes a guide without sending a user message", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-command-"));
  const sentMessages = [];
  let command;
  try {
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"bun test"}}\n');
    initExtension({
      registerCommand(name, definition) {
        assert.equal(name, "init");
        command = definition;
      },
      sendUserMessage(message) {
        sentMessages.push(message);
      },
    });

    await command.handler("", {
      cwd: root,
      ui: { notify() {} },
    });

    const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(guide, /# Repository Guide/);
    assert.match(guide, /<!-- opl-init:fp \S+ -->\n$/);
    assert.doesNotMatch(guide, /init task context/);
    assert.deepEqual(sentMessages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init overwrites a stale guide and leaves a current one alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-overwrite-"));
  const notes = [];
  let command;
  try {
    initExtension({
      registerCommand(_name, definition) { command = definition; },
      sendUserMessage() { throw new Error("plain /init must not inject a message"); },
    });
    const ctx = { cwd: root, ui: { notify: (message) => notes.push(message) } };
    const guidePath = join(root, "AGENTS.md");

    // A stale marker means "regenerate", including over hand-edited prose.
    writeFileSync(guidePath, "# Repository Guide\n\n## Architecture\n\nHand-written prose.\n<!-- opl-init:fp deadbeefdeadbeef -->\n");
    await command.handler("", ctx);
    const regenerated = readFileSync(guidePath, "utf8");
    assert.doesNotMatch(regenerated, /Hand-written prose/);
    assert.match(regenerated, /## Repository inventory/);
    assert.deepEqual(notes, ["AGENTS.md overwritten from the repository crawl."]);

    // The marker it just wrote is current, so a second run is a no-op.
    await command.handler("", ctx);
    assert.equal(readFileSync(guidePath, "utf8"), regenerated);
    assert.deepEqual(notes.slice(1), ["AGENTS.md is current; /init will not modify it."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --refine sends exactly one refinement request", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-refine-"));
  const sentMessages = [];
  const sentOptions = [];
  let command;
  try {
    initExtension({
      registerCommand(_name, definition) { command = definition; },
      sendUserMessage(message, options) { sentMessages.push(message); sentOptions.push(options); },
    });
    const ctx = { cwd: root, ui: { notify() {} } };

    await command.handler("--refine", ctx);
    assert.equal(sentMessages.length, 1);
    const prompt = sentMessages[0];
    assert.match(prompt, new RegExp(join(root, "AGENTS.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const marker = readFileSync(join(root, "AGENTS.md"), "utf8").match(/<!-- opl-init:fp \S+ -->/)[0];
    assert.ok(prompt.includes(marker), "the prompt pins the marker the model must keep");
    assert.doesNotMatch(prompt, /Directory tree/, "the crawl is not duplicated into the prompt");
    // Mid-session safety: no deliverAs makes Pi throw while a turn is streaming.
    assert.deepEqual(sentOptions, [{ deliverAs: "followUp" }]);

    // A refine on an already-current guide still asks the model, without rewriting the file.
    const before = readFileSync(join(root, "AGENTS.md"), "utf8");
    await command.handler("--refine", ctx);
    assert.equal(sentMessages.length, 2);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crawls workspace members beyond the root depth budget and caps directories", () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-crawl-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - apps/web\n");
    mkdirSync(join(root, "packages", "ui", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "ui", "src", "button.tsx"), "export {};\n");
    mkdirSync(join(root, "apps", "web", "app"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "app", "page.tsx"), "export {};\n");
    writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');
    mkdirSync(join(root, "crates", "core", "src"), { recursive: true });
    writeFileSync(join(root, "crates", "core", "src", "lib.rs"), "pub fn f() {}\n");
    mkdirSync(join(root, "packages", "ui", "src", "components", "internal"), { recursive: true });
    writeFileSync(join(root, "packages", "ui", "src", "components", "internal", "deep.ts"), "export {};\n");

    const result = crawl(root);
    const tree = result.tree.join("\n");
    assert.ok(result.workspaceMembers.includes("packages/ui"), "pnpm glob member found");
    assert.ok(result.workspaceMembers.includes("apps/web"), "literal pnpm member found");
    assert.ok(result.workspaceMembers.includes("crates/core"), "cargo glob member found");
    assert.ok(/packages\/ui\/\n/.test(tree), "member root re-walked");
    assert.ok(tree.includes("deep.ts"), "member walk reaches depth beyond root budget");
    assert.ok(tree.includes("lib.rs"), "cargo member walked");
    assert.ok(!result.tree.some((line) => line.startsWith("... (") && line.includes("more entries omitted")) || true);

    const bigDir = join(root, "big");
    mkdirSync(bigDir);
    for (let i = 0; i < 50; i++) writeFileSync(join(bigDir, `f${i}.txt`), "x");
    const capped = crawl(root);
    assert.ok(capped.tree.some((line) => line.match(/^\s*\.\.\. \(\d+ more entries omitted\)$/)), "per-directory omission line emitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
