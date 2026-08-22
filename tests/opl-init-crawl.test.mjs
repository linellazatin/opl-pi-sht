import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawl } from "../extensions/opl-init/index.ts";

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
