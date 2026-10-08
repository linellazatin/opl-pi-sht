import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

// The host guard is deliberately duplicated: install.sh installs one extension directory at
// a time, so opl-browser cannot import from opl-webaccess. This test is what keeps the two
// copies honest — it compares the marked region with comments and whitespace stripped.
test("the two SSRF guard copies have not drifted", () => {
  const grab = (rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    const m = src.match(/\/\/ BEGIN SHARED HOST GUARD[\s\S]*?\/\/ END SHARED HOST GUARD/);
    assert.ok(m, `${rel} must contain the SHARED HOST GUARD region`);
    return m[0]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  assert.equal(
    grab("../extensions/opl-webaccess/utils.ts"),
    grab("../extensions/opl-browser/validate.ts"),
    "host guard drifted between opl-webaccess and opl-browser — re-copy the region",
  );
});
