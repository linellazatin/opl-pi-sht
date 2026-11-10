// One seam for tests that read Pi's own source or load extensions through it.
//
// Pi tests must exercise the build this machine actually runs, so resolution prefers the
// managed install (PI_CODING_AGENT_DIR, else ~/.pi/agent; PI_MANAGED_INSTALL_ROOT overrides
// the install root) and falls back to the resolved devDependency when there is none, e.g. in
// CI. Keeping this in one place is what stops one host-coupling test from pinning an older
// pi-tui than another. CI neutralises managed-install discovery and pins the selected host
// with OPL_PI_HOST_SOURCE, so a job cannot silently run against the machine's own pi.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function managedInstall() {
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

/** Which Pi build this run uses, without importing it. */
export function hostDescriptor() {
  const installed = managedInstall();
  if (installed) {
    return { entry: installed.entry, version: installed.version, source: `installed pi ${installed.version}` };
  }
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return { entry, version: null, source: "devDependency" };
}

/** Load the Pi host module the same way pi does, preferring the managed install. */
export async function loadHost() {
  const descriptor = hostDescriptor();
  const module = await import(pathToFileURL(descriptor.entry).href);
  if (descriptor.source !== "devDependency") return { ...descriptor, module };
  const version = module.VERSION ?? "unknown";
  return { ...descriptor, module, version, source: `devDependency pi ${version}` };
}

/** Absolute path to a file inside a host package, resolved from the host itself. */
export function hostFile(descriptor, specifier) {
  return fileURLToPath(import.meta.resolve(specifier, pathToFileURL(descriptor.entry).href));
}

/** Version of a host package as the selected host sees it (its own sibling, not node_modules). */
export function hostPackageVersion(descriptor, packageName) {
  const file = hostFile(descriptor, `${packageName}/package.json`);
  return JSON.parse(readFileSync(file, "utf8")).version;
}
