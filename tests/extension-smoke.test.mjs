import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const names = new Set(["opl-footer", "opl-init", "opl-input", "opl-modes", "opl-questionnaire", "opl-todo", "opl-webaccess", "opl-simplebench"]);
const extension = process.env.OPL_EXTENSION;
assert.ok(extension && names.has(extension), `OPL_EXTENSION must name a known extension; got ${extension || "(unset)"}`);

test(`bundles ${extension} extension entrypoint`, () => {
  const config = `configs/${extension}.json`;
  if (existsSync(config)) JSON.parse(readFileSync(config, "utf8"));

  if (extension === "opl-init") {
    const source = readFileSync(`extensions/${extension}/index.ts`, "utf8");
    for (const heading of ["What this is", "Commands", "Architecture", "Key files"]) assert.match(source, new RegExp(`## ${heading}`));
    assert.match(source, /Avoid generic contribution, Git, or pull-request advice/);
    assert.match(source, /pnpm-workspace\.yaml/);
    assert.match(source, /MAX_MEMBER_DEPTH/);
    assert.match(source, /MAX_DIR_ENTRIES/);
    assert.match(source, /tree truncated at/);
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
    "--outfile", `/tmp/${extension}.js`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
