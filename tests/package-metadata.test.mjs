import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname;
const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const nested = ["opl-browser", "opl-webaccess"];

// Two extensions carry their own package.json so CI can audit their runtime deps separately.
// They are not published, and drift silently: stale versions, a `main` that points at a file
// that never exists, an `npm test` stub that only errors (AGENTS.md has to warn people away
// from it), and an ISC license inherited from `npm init`. This pins the shape.
// Their versions are deliberately NOT the release version of the collection: browser and
// webaccess keep their own line (decided 2026-10-08), because their behaviour changes at a
// different cadence from the rest of the repo.
test("nested extension manifests keep their own version line", () => {
	for (const name of nested) {
		const manifest = JSON.parse(readFileSync(join(ROOT, "extensions", name, "package.json"), "utf8"));
		assert.equal(manifest.name, name, "name must match the extension directory");
		assert.match(manifest.version, /^\d+\.\d+\.\d+$/, `${name} needs a concrete semver`);
		assert.notEqual(
			manifest.version,
			root.version,
			`${name} must not mirror the collection version; it carries its own line`,
		);
		assert.equal(manifest.private, true, `${name} is not published on its own`);
		assert.equal(manifest.license, root.license, `${name} license must match the root`);
		assert.ok(!("main" in manifest), `${name} has no built index.js; pi discovers extensions/*/index.ts`);
		assert.ok(!("scripts" in manifest), `${name} must not ship an npm test stub`);

		for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
			assert.equal(
				root.dependencies?.[dep],
				range,
				`${name} pins ${dep}@${range}, which the root manifest does not carry at the same range`,
			);
		}
	}
});

test("the live-config ignore rule is anchored to configs/", () => {
	const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	assert.ok(ignore.includes("/configs/opl-*.json"), "configs/*.json must stay ignored");
	assert.ok(
		!ignore.some((line) => line === "opl-*.json"),
		"an unanchored opl-*.json rule silently ignores fixtures under extensions/",
	);
});

test("the root manifest declares the extension floor and the pi extension glob", () => {
	assert.deepEqual(root.pi?.extensions, ["./extensions/*/index.ts"]);
	const floor = root.devDependencies?.["@earendil-works/pi-coding-agent"] ?? "";
	assert.match(
		floor,
		/^>=\d+\.\d+\.\d+$/,
		"the pi devDependency must state the floor this collection claims to support",
	);
});

// Operator rule (2026-10-08): a new sample parameter must be added to the live repo
// config in the same change, and the sync is additive — existing live parameters are
// never edited. So "in sample, not in live" is always drift: either the live config is
// missing the new key, or the sample renamed one out from under it.
test("every tracked sample parameter is present in the live config", () => {
  // Only sample keys are checked. Keys that exist solely in a live config are the
  // operator's own additions and are never drift.
  const configDir = join(ROOT, "configs");
  const sampleNames = readdirSync(configDir).filter((n) => n.endsWith(".json.sample"));
  assert.ok(sampleNames.length >= 8, `expected the tracked samples, found ${sampleNames.length}`);
  for (const sampleName of sampleNames) {
    const name = sampleName.replace(/\.sample$/, "");
    const livePath = join(configDir, name);
    if (!existsSync(livePath)) continue; // extension ships a sample but no live config yet
    const sample = JSON.parse(readFileSync(join(configDir, sampleName), "utf-8"));
    const live = JSON.parse(readFileSync(livePath, "utf-8"));
    for (const key of Object.keys(sample)) {
      if (key.startsWith("_comment")) continue;
      assert.ok(
        Object.hasOwn(live, key),
        `${name}: sample documents "${key}" but the live config does not carry it — add it (additively)`,
      );
    }
  }
});
