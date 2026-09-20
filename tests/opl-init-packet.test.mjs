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
});

test("evidence packet includes readme heads and enforces its budget", () => {
  const root = mkdtempSync(join(tmpdir(), "opl-init-packet-"));
  try {
    writeFileSync(join(root, "README.md"), "R".repeat(4000));
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(join(root, "packages", "ui", "README.md"), "U".repeat(4000));
    writeFileSync(join(root, "package.json"), "{}");
    const baseline = "B".repeat(20000);
    const packet = evidencePacket(root, baseline, ["packages/ui"]);
    assert.ok(packet.includes("R".repeat(2048)), "root readme head included");
    assert.ok(packet.includes("(evidence truncated)"), "budget overflow is explicit");
    assert.ok(Buffer.byteLength(packet, "utf8") <= 24576 + 512, "hard budget");
    const small = evidencePacket(root, "short baseline", ["packages/ui"]);
    assert.ok(small.includes("U".repeat(2048)), "member readme included");
    assert.ok(!small.includes("(evidence truncated)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
