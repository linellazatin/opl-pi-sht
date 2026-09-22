import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

test("Pi 0.87 host loader loads every package extension without errors", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "opl-pi-host-loader-"));
  try {
    const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
    const result = await discoverAndLoadExtensions(["extensions"], process.cwd(), agentDir);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 11);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
