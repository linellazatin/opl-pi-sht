// opl-input config persistence for the configurator tab. The tab writes only boxedView,
// companion.enabled and companion.type, and must preserve every other live key (including
// user-defined companion.types and color) so a save is additive, never a rewrite from defaults.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { readInputConfig, saveInputConfig } from "../extensions/opl-input/config.ts";
import { inputFieldPatch } from "../extensions/opl-input/configure.ts";

function withAgentDir(fn) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "opl-input-agent-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads {} when no config exists", () => {
  withAgentDir(() => {
    assert.deepEqual(readInputConfig(), {});
  });
});

test("a no-op patch writes nothing and reports unchanged", () => {
  withAgentDir((dir) => {
    assert.equal(saveInputConfig({}), false);
    assert.equal(saveInputConfig({ companion: {} }), false);
    assert.deepEqual(readInputConfig(), {});
    assert.equal(existsSync(join(dir, "configs", "opl-input.json")), false);
  });
});

test("merges the editable fields without dropping unknown or companion keys", () => {
  withAgentDir((dir) => {
    const file = join(dir, "configs", "opl-input.json");
    writeFileSync(file, JSON.stringify({
      boxedView: true,
      boxPadX: 2,
      menuGap: 1,
      extraMenuIndent: 4,
      futureKey: "keep",
      companion: {
        enabled: false,
        color: "#c07898",
        ears: " /)_(\\ ",
        type: "cat",
        types: [{ typeName: "otter", top: " ^.^ " }],
      },
    }));

    assert.equal(saveInputConfig({ boxedView: false }), true);
    assert.equal(saveInputConfig({ companion: { enabled: true, type: "otter" } }), true);

    const next = readInputConfig();
    assert.equal(next.boxedView, false);
    assert.equal(next.boxPadX, 2, "unknown numeric keys survive");
    assert.equal(next.menuGap, 1);
    assert.equal(next.extraMenuIndent, 4);
    assert.equal(next.futureKey, "keep", "unknown future keys survive");
    assert.equal(next.companion.enabled, true);
    assert.equal(next.companion.type, "otter");
    assert.equal(next.companion.color, "#c07898", "colour is untouched");
    assert.equal(next.companion.ears, " /)_(\\ ", "ears are untouched");
    assert.deepEqual(next.companion.types, [{ typeName: "otter", top: " ^.^ " }], "declared types survive");
  });
});

test("the same value written twice is unchanged the second time", () => {
  withAgentDir((dir) => {
    const file = join(dir, "configs", "opl-input.json");
    writeFileSync(file, JSON.stringify({ boxedView: false }));

    assert.equal(saveInputConfig({ boxedView: false }), false, "re-selecting the current value must not write or notify");
    assert.deepEqual(readInputConfig(), { boxedView: false });
    assert.equal(saveInputConfig({ boxedView: true }), true);
    assert.equal(saveInputConfig({ boxedView: true }), false);
  });
});

test("inputFieldPatch routes known ids and refuses unknown ones", () => {
  assert.deepEqual(inputFieldPatch("boxedView", "true"), { boxedView: true });
  assert.deepEqual(inputFieldPatch("boxedView", "false"), { boxedView: false });
  assert.deepEqual(inputFieldPatch("companion.enabled", "true"), { companion: { enabled: true } });
  assert.deepEqual(inputFieldPatch("companion.type", "dog"), { companion: { type: "dog" } });
  assert.equal(inputFieldPatch("companion.typo", "dog"), null);
  assert.equal(inputFieldPatch("", "x"), null);
});