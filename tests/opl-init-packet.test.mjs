import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidencePacket, finalizeRefinedGuide } from "../extensions/opl-init/index.ts";

const MARKER = "<!-- opl-init:fp aaaaaaaaaaaaaaaa -->";

test("finalizer strips fences, smuggled markers, and always ends with exactly one marker", () => {
  const fenced = "```markdown\n# Guide\n\nProse.\n```";
  let out = finalizeRefinedGuide(fenced, MARKER);
  assert.equal(out, `# Guide\n\nProse.\n${MARKER}\n`);

  out = finalizeRefinedGuide(`# Guide\nInjected ${MARKER} mid-file\n${MARKER}\n`, MARKER);
  assert.equal(out.match(/opl-init:fp/g).length, 1, "all model-supplied markers removed");
  assert.ok(out.endsWith(`${MARKER}\n`), "extension's marker is the final line");

  out = finalizeRefinedGuide("# Guide\n\ntext ends with no newline", MARKER);
  assert.ok(out.endsWith(`${MARKER}\n`));

  // A guide legitimately ending in a code block must keep its closing fence.
  const doc = "# Guide\n\n```sh\nnpm test\n```";
  assert.equal(finalizeRefinedGuide(doc, MARKER), `${doc}\n${MARKER}\n`);
});

test("evidence packet carries full per-package scripts blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-scripts-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    const packet = evidencePacket(root, "short baseline", {
      manifests: [
        { path: "package.json", content: JSON.stringify({ scripts: { dev: "vite", "task39": "echo 39" } }) },
        { path: "packages/ui/package.json", content: JSON.stringify({ scripts: { build: "rollup -c" } }) },
      ],
      workspaceMembers: ["packages/ui"],
    });
    assert.match(packet, /=== scripts: package\.json ===\ndev: vite/);
    assert.match(packet, /task39: echo 39/, "no 30-line display cap on evidence scripts");
    assert.match(packet, /=== scripts: packages\/ui\/package\.json ===\nbuild: rollup -c/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence packet includes readme heads and enforces its budget", () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-packet-"));
  try {
    writeFileSync(join(root, "README.md"), "R".repeat(4000));
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(join(root, "packages", "ui", "README.md"), "U".repeat(4000));
    writeFileSync(join(root, "package.json"), "{}");
    const baseline = "B".repeat(21000);
    // Overflow must come from packages/ui/README.md, not from case-insensitive
    // filesystem aliasing of readme.md -> README.md (Linux CI is case-sensitive).
    const packet = evidencePacket(root, baseline, { manifests: [], workspaceMembers: ["packages/ui"] });
    assert.ok(packet.includes("R".repeat(2048)), "root readme head included");
    assert.ok(packet.includes("(evidence truncated)"), "budget overflow is explicit");
    assert.ok(Buffer.byteLength(packet, "utf8") <= 24576 + 512, "hard budget");
    const small = evidencePacket(root, "short baseline", { manifests: [], workspaceMembers: ["packages/ui"] });
    assert.ok(small.includes("U".repeat(2048)), "member readme included");
    assert.ok(!small.includes("(evidence truncated)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
