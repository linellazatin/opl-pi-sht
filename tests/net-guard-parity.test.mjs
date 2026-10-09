import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

// The host guard is deliberately duplicated: install.sh installs one extension directory at
// a time, so opl-browser cannot import from opl-webaccess. This test is what keeps the two
// copies honest — it compares the marked region with comments and whitespace stripped.
function grab(rel, marker) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const m = src.match(new RegExp(`// BEGIN ${marker}[\\s\\S]*?// END ${marker}`));
  assert.ok(m, `${rel} must contain the ${marker} region`);
  return m[0]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("the two SSRF guard copies have not drifted", () => {
  assert.equal(
    grab("../extensions/opl-webaccess/utils.ts", "SHARED HOST GUARD"),
    grab("../extensions/opl-browser/validate.ts", "SHARED HOST GUARD"),
    "host guard drifted between opl-webaccess and opl-browser — re-copy the region",
  );
});

// The git guard has the same duplication reason: opl-init and opl-footer are installed as
// separate directories and can neither share a module nor see each other's copy.
test("the two git guard copies have not drifted", () => {
  assert.equal(
    grab("../extensions/opl-init/index.ts", "SHARED GIT GUARD"),
    grab("../extensions/opl-footer/git-status.ts", "SHARED GIT GUARD"),
    "git guard drifted between opl-init and opl-footer — re-copy the region",
  );
});
