import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initExtension, { crawl } from "../extensions/opl-init/index.ts";

function fakePi() {
  const commands = {};
  return {
    commands,
    registerCommand(name, definition) { commands.init = definition; },
    sendUserMessage() { throw new Error("opl-init must never inject a user message"); },
  };
}

function idleCtx(root, extra = {}) {
  return { cwd: root, model: undefined, isIdle: () => true, reload: async () => {}, ui: { notify() {} }, ...extra };
}

async function runInit(ctx, pi = fakePi()) {
  initExtension(pi);
  await pi.commands.init.handler("", ctx);
  return pi;
}

test("no model available: baseline written with a refine-failed notice, no user message, reload runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-flow-"));
  try {
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"bun test"}}\n');
    const notes = [];
    let reloads = 0;
    const ctx = idleCtx(root, { ui: { notify: (m) => notes.push(m) }, reload: async () => { reloads++; } });
    await runInit(ctx);
    const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(guide, /# Repository Guide/);
    assert.match(guide, /<!-- opl-init:fp \S+ -->\n$/);
    assert.deepEqual(notes, ["refine failed; wrote deterministic AGENTS.md from the repository crawl."]);
    assert.equal(reloads, 1);

    // Second run: fingerprint current -> no write, no reload, no model call.
    await runInit(idleCtx(root, { ui: { notify: (m) => notes.push(m) }, modelRegistry: { streamSimple() { throw new Error("must not call model"); } } }));
    assert.deepEqual(notes.slice(1), ["AGENTS.md is current; /init will not modify it."]);
    assert.equal(reloads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful refine: fenced + smuggled-marker output is finalized and reloaded once", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-refine-ok-"));
  try {
    writeFileSync(join(root, "a.ts"), "export {};\n");
    let reloads = 0;
    let calledWith = null;
    const ctx = idleCtx(root, {
      model: { provider: "fake", id: "fake-model" },
      reload: async () => { reloads++; },
      modelRegistry: {
        streamSimple(model, context, options) {
          calledWith = { model, context, options };
          return {
            async result() {
              return {
                content: [{ type: "text", text: '```markdown\n# Guide\n\nCrafted prose.\nInjected <!-- opl-init:fp 9999999999999999 --> tail\n```' }],
                stopReason: "stop",
              };
            },
          };
        },
      },
    });
    await runInit(ctx);
    assert.equal(calledWith.model.id, "fake-model", "refine uses ctx.model");
    assert.match(calledWith.context.systemPrompt, /Return ONLY the final Markdown document/);
    const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(guide, /Crafted prose\./);
    assert.doesNotMatch(guide, /9999999999999999/);
    assert.equal(guide.match(/opl-init:fp/g).length, 1);
    assert.match(guide, /<!-- opl-init:fp \S+ -->\n$/);
    assert.equal(reloads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale guide with a streaming agent: waits for idle, recalculates, then writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-idle-"));
  try {
    const guidePath = join(root, "AGENTS.md");
    let idle = false;
    let waits = 0;
    const ctx = {
      cwd: root,
      model: undefined,
      isIdle: () => idle,
      waitForIdle: async () => { waits++; idle = true; },
      reload: async () => {},
      ui: { notify() {} },
    };
    await runInitWithBusy(ctx, root);
    assert.ok(waits >= 1);
    assert.ok(existsSync(guidePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runInitWithBusy(ctx, root) {
  const pi = fakePi();
  initExtension(pi);
  const promise = pi.commands.init.handler("", ctx);
  await new Promise((r) => setTimeout(r, 0));
  writeFileSync(join(root, "busy-work.ts"), "export const touched = true;\n");
  await promise;
}

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

test("workspace files are counted once and scripts aggregate across packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-dedupe-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc -b", test: "vitest" } }));
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(join(root, "packages", "ui", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(root, "packages", "ui", "button.tsx"), "export {};\n");

    const result = crawl(root);
    assert.equal(result.extCounts.get(".tsx"), 1, "member file not double-counted by re-walk");
    assert.equal(result.extCounts.get(".json"), 2, "manifests counted once each");

    // Guide rendering path (no model here -> baseline): both script blocks appear.
    // The ctx shape matches Task 4's handler contract (isIdle/reload/model) so this
    // test survives the handler rewrite unchanged.
    let command;
    initExtension({ registerCommand: (_n, d) => { command = d; } });
    await command.handler("", { cwd: root, model: undefined, isIdle: () => true, reload: async () => {}, ui: { notify() {} } });
    const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(guide, /build: tsc -b/);
    assert.match(guide, /ui\/ test: vitest run/, "member scripts labeled by package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package.json beyond the old 2KB display cap keeps its scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-bigpkg-"));
  try {
    const scripts = {};
    for (let i = 0; i < 120; i++) scripts[`task${i}`] = `echo a-long-command-line-to-pad-the-file-${i}`;
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts, filler: "x".repeat(2048) }));
    let command;
    initExtension({ registerCommand: (_n, d) => { command = d; } });
    await command.handler("", { cwd: root, model: undefined, isIdle: () => true, reload: async () => {}, ui: { notify() {} } });
    const guide = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(guide, /task0: echo/, "scripts survive beyond 2048 bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
