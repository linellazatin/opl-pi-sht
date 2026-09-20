import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const names = new Set(["opl-browser", "opl-footer", "opl-init", "opl-input", "opl-modes", "opl-questionnaire", "opl-todo", "opl-webaccess", "opl-simplebench", "opl-ctxtrim"]);
const extension = process.env.OPL_EXTENSION;
assert.ok(extension && names.has(extension), `OPL_EXTENSION must name a known extension; got ${extension || "(unset)"}`);

test(`bundles ${extension} extension entrypoint`, () => {
  const config = `configs/${extension}.json`;
  if (existsSync(config)) JSON.parse(readFileSync(config, "utf8"));

  if (extension === "opl-init") {
    const source = readFileSync(`extensions/${extension}/index.ts`, "utf8");
    assert.doesNotMatch(source, /sendUserMessage/, "the refinement path never injects a user turn");
    assert.match(source, /streamSimple/, "refinement goes through modelRegistry");
    assert.match(source, /await ctx\.reload\(\)/, "context reloads after a successful write");
    assert.doesNotMatch(source, /deliverAs/);
    assert.match(source, /buildGuide/);
    assert.match(source, /GUIDE_SCHEMA_VERSION/);
    assert.match(source, /MAX_EVIDENCE_BYTES/);
    assert.match(source, /pnpm-workspace\.yaml/);
    assert.match(source, /MAX_DIR_ENTRIES/);
    assert.match(source, /tree truncated at/);
  }

  if (extension === "opl-footer") {
    const source = readFileSync(`extensions/${extension}/index.ts`, "utf8");
    assert.match(source, /registerCommand\("configure-opl"/);
  }

  if (extension === "opl-modes") {
    const source = readFileSync(`extensions/${extension}/index.ts`, "utf8");
    assert.match(source, /executeHandoffAllowed/);
    assert.match(source, /withPlanComplete/);
  }

  const result = spawnSync("bun", [
    "build", "--bundle", "--target=node", `extensions/${extension}/index.ts`,
    "--external", "@earendil-works/pi-coding-agent",
    "--external", "@earendil-works/pi-tui",
    "--external", "@earendil-works/pi-ai",
    "--external", "typebox",
    "--external", "turndown",
    "--external", "linkedom",
    "--external", "@mozilla/readability",
    "--external", "unpdf",
    "--external", "playwright",
    "--outfile", `/tmp/${extension}.js`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
