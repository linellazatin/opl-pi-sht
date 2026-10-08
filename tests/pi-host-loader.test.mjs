import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

// Load the extensions with the Pi build this machine actually runs, not the
// local devDependency, so a new release's loader (and its `@earendil-works/*`
// aliases) is exercised before users hit it. Falls back to the resolved
// devDependency when no managed install is present, e.g. in CI.
function findManagedInstallEntry() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir, "install");
  const versionFile = join(installRoot, "current-version");
  if (!existsSync(versionFile)) return null;

  const version = readFileSync(versionFile, "utf8").trim();
  if (!version) return null;
  const packageDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const entry = join(packageDir, manifest.main ?? "dist/index.js");
  return existsSync(entry) ? { entry, version: manifest.version ?? version } : null;
}

async function loadHost() {
  const installed = findManagedInstallEntry();
  if (installed) {
    const module = await import(pathToFileURL(installed.entry).href);
    return { discoverAndLoadExtensions: module.discoverAndLoadExtensions, source: `installed pi ${installed.version}` };
  }
  const module = await import("@earendil-works/pi-coding-agent");
  return { discoverAndLoadExtensions: module.discoverAndLoadExtensions, source: `devDependency pi ${module.VERSION ?? "unknown"}` };
}

test("Pi host loader loads every package extension without errors", async () => {
  const { discoverAndLoadExtensions, source } = await loadHost();
  const agentDir = mkdtempSync(join(tmpdir(), "opl-pi-host-loader-"));
  try {
    const result = await discoverAndLoadExtensions(["extensions"], process.cwd(), agentDir);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 11);
    console.log(`[pi-host] loaded ${result.extensions.length} extensions with ${source}`);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
