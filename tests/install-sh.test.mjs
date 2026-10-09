import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

const INSTALL = new URL("../install.sh", import.meta.url).pathname;
const ALL = [
	"opl-browser", "opl-ctxtrim", "opl-footer", "opl-guardian", "opl-init", "opl-input",
	"opl-modes", "opl-questionnaire", "opl-simplebench", "opl-todo", "opl-webaccess",
];

/** A repo clone with extension dirs and only .sample configs, the way git ships it. */
function fakeRepo() {
	const root = mkdtempSync(join(tmpdir(), "opl-install-repo-"));
	mkdirSync(join(root, "configs"), { recursive: true });
	for (const name of ALL) {
		mkdirSync(join(root, "extensions", name), { recursive: true });
		writeFileSync(join(root, "extensions", name, "index.ts"), "// extension\n");
		if (name !== "opl-ctxtrim") {
			writeFileSync(join(root, "configs", `${name}.json.sample`), JSON.stringify({ shipped: name }));
		}
	}
	// install.sh derives its repo root from its own location, so the script under test must live
	// inside the fake clone.
	copyFileSync(INSTALL, join(root, "install.sh"));
	return root;
}

function agentDir() {
	return mkdtempSync(join(tmpdir(), "opl-install-agent-"));
}

async function run(repo, env = [], args = []) {
	const proc = Bun.spawn(["bash", join(repo, "install.sh"), ...args], {
		env: { ...process.env, PI_CODING_AGENT_DIR: "", PI_AGENT_DIR: "", ...Object.fromEntries(env) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code: await proc.exited, stdout, stderr };
}

test("installs shipped sample configs from a clone", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]]);
		assert.equal(r.code, 0, r.stderr);
		for (const name of ALL) {
			if (name === "opl-ctxtrim") continue;
			const dest = join(agent, "configs", `${name}.json`);
			assert.ok(existsSync(dest), `${name}.json was not installed from its sample`);
			assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), { shipped: name });
			assert.ok(r.stdout.includes(`${dest} (copied, shipped default)`), "sample installs must be announced");
		}
		for (const name of ALL) {
			assert.ok(existsSync(join(agent, "extensions", name, "index.ts")), `${name} extension not copied`);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("a live config in the repo wins over the sample", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		writeFileSync(join(repo, "configs", "opl-todo.json"), JSON.stringify({ live: true }));
		const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "configs", "opl-todo.json"), "utf8")), { live: true });
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("an existing user config survives a reinstall, --force-configs replaces it", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		mkdirSync(join(agent, "configs"), { recursive: true });
		writeFileSync(join(agent, "configs", "opl-guardian.json"), JSON.stringify({ mine: true }));
		let r = await run(repo, [["PI_CODING_AGENT_DIR", agent]]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "configs", "opl-guardian.json"), "utf8")), { mine: true });
		assert.ok(r.stdout.includes("(exists, keeping it)"));

		r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--force-configs"]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(agent, "configs", "opl-guardian.json"), "utf8")), { shipped: "opl-guardian" });
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("prunes a manifested directory the release no longer ships, and only that one", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		mkdirSync(join(agent, "extensions", "opl-legacy"), { recursive: true });
		writeFileSync(join(agent, "extensions", "opl-legacy", "index.ts"), "// stale\n");
		mkdirSync(join(agent, "extensions", "opl-user"), { recursive: true });
		writeFileSync(join(agent, "extensions", "opl-user", "index.ts"), "// user extension\n");
		writeFileSync(
			join(agent, "extensions", ".opl-pi-sht.installed"),
			"# Installed by install.sh\nopl-legacy\n",
		);

		const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]]);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!existsSync(join(agent, "extensions", "opl-legacy")), "manifested stale dir must be pruned");
		assert.ok(existsSync(join(agent, "extensions", "opl-user")), "a directory outside the manifest must never be touched");
		assert.ok(r.stdout.includes("pruned"));

		const manifest = readFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), "utf8").split("\n").filter(Boolean);
		for (const name of ALL) assert.ok(manifest.includes(name), `${name} missing from the manifest`);
		assert.ok(!manifest.includes("opl-legacy"), "a pruned name must be forgotten");

		// --no-prune keeps the stale directory.
		mkdirSync(join(agent, "extensions", "opl-legacy"), { recursive: true });
		const kept = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--no-prune"]);
		assert.equal(kept.code, 0, kept.stderr);
		assert.ok(existsSync(join(agent, "extensions", "opl-legacy")), "--no-prune must keep the stale dir");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("--only expands the UI bundle", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--only", "opl-footer"]);
		assert.equal(r.code, 0, r.stderr);
		for (const name of ["opl-footer", "opl-input", "opl-modes"]) {
			assert.ok(existsSync(join(agent, "extensions", name)), `${name} should install with the bundle`);
		}
		assert.ok(!existsSync(join(agent, "extensions", "opl-todo")), "unselected extensions must not install");
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("the target honours PI_CODING_AGENT_DIR, then PI_AGENT_DIR as a legacy alias", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	const legacy = agentDir();
	try {
		let r = await run(repo, [["PI_AGENT_DIR", legacy]]);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.stdout.includes(`Target: ${legacy}`), "PI_AGENT_DIR alone must still be honoured");
		assert.ok(r.stdout.includes("legacy alias"));

		r = await run(repo, [["PI_AGENT_DIR", legacy], ["PI_CODING_AGENT_DIR", agent]]);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.stdout.includes(`Target: ${agent}`), "PI_CODING_AGENT_DIR must win over the legacy alias");

		mkdirSync(join(legacy, "extensions"), { recursive: true });
		// Never let this run touch the developer's real ~/.pi/agent: point HOME at a temp dir.
		const fakeHome = mkdtempSync(join(tmpdir(), "opl-install-home-"));
		r = await run(repo, [["HOME", fakeHome]], []);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.stdout.includes("default (~/.pi/agent)"), "with no env var the default target must be reported");
		assert.ok(existsSync(join(fakeHome, ".pi", "agent", "configs", "opl-todo.json")), "default target must receive configs");
		rmSync(fakeHome, { recursive: true, force: true });
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
		rmSync(legacy, { recursive: true, force: true });
	}
});

test("link mode installs sample configs and records the manifest", async () => {
	const repo = fakeRepo();
	const agent = agentDir();
	try {
		const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--link"]);
		assert.equal(r.code, 0, r.stderr);
		for (const name of ["opl-browser", "opl-todo"]) {
			const link = join(agent, "configs", `${name}.json`);
			assert.ok(existsSync(link), `${name}.json should be linked from the sample`);
			assert.deepEqual(JSON.parse(readFileSync(link, "utf8")), { shipped: name });
		}
		assert.ok(existsSync(join(agent, "extensions", ".opl-pi-sht.installed")));
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

for (const mode of [[], ["--link"]]) {
 test(`retained stale ownership survives --no-prune (${mode.length ? "link" : "copy"})`, async () => {
  const repo = fakeRepo(), agent = agentDir();
  const manifest = join(agent, "extensions", ".opl-pi-sht.installed");
  try {
   mkdirSync(join(agent, "extensions", "opl-legacy"), { recursive: true });
   mkdirSync(join(agent, "extensions", "opl-user"));
   writeFileSync(manifest, "opl-legacy\n");
   const kept = await run(repo, [["PI_CODING_AGENT_DIR", agent]], [...mode, "--no-prune", "--only", "opl-todo"]);
   assert.equal(kept.code, 0, kept.stderr);
   assert.ok(readFileSync(manifest, "utf8").split("\n").includes("opl-legacy"));
   const pruned = await run(repo, [["PI_CODING_AGENT_DIR", agent]], [...mode, "--only", "opl-browser"]);
   assert.equal(pruned.code, 0, pruned.stderr);
   assert.ok(!existsSync(join(agent, "extensions", "opl-legacy")));
   assert.ok(existsSync(join(agent, "extensions", "opl-user")));
   const names = readFileSync(manifest, "utf8").split("\n");
   assert.ok(names.includes("opl-todo") && names.includes("opl-browser"));
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
 });
}

test("link mode does not claim an existing unowned extension", async () => {
 const repo = fakeRepo(), agent = agentDir();
 try {
  mkdirSync(join(agent, "extensions", "opl-todo"), { recursive: true });
  const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--link", "--only", "opl-todo"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!readFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), "utf8").split("\n").includes("opl-todo"));
 } finally { rmSync(repo, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
});

test("failed pruning retains ownership for the next run", async () => {
 const repo = fakeRepo(), agent = agentDir();
 const manifest = join(agent, "extensions", ".opl-pi-sht.installed");
 try {
  mkdirSync(join(agent, "extensions", "opl-legacy"), { recursive: true });
  mkdirSync(join(repo, "bin"));
  writeFileSync(manifest, "opl-legacy\n");
  const shim = join(repo, "bin", "rm");
  writeFileSync(shim, '#!/bin/bash\ncase "$*" in *opl-legacy*) exit 1;; esac\nexec /bin/rm "$@"\n');
  chmodSync(shim, 0o755);
  const failed = await run(repo, [["PI_CODING_AGENT_DIR", agent], ["PATH", `${join(repo, "bin")}:${process.env.PATH}`]], ["--only", "opl-todo"]);
  assert.notEqual(failed.code, 0);
  assert.ok(readFileSync(manifest, "utf8").split("\n").includes("opl-legacy"));
  const retry = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--only", "opl-todo"]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.ok(!existsSync(join(agent, "extensions", "opl-legacy")));
 } finally { rmSync(repo, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
});

test("manifest traversal is ignored and stale symlinks do not delete their targets", async () => {
 const repo = fakeRepo(), agent = agentDir();
 try {
  mkdirSync(join(agent, "extensions"));
  mkdirSync(join(agent, "protected"));
  writeFileSync(join(agent, "protected", "sentinel"), "keep");
  symlinkSync(join(agent, "protected"), join(agent, "extensions", "opl-legacy"));
  writeFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), `../protected\n${join(agent, "protected")}\nopl-legacy\n`);
  const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--only", "opl-todo"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(agent, "protected", "sentinel")));
  assert.ok(!existsSync(join(agent, "extensions", "opl-legacy")));
  assert.ok(!readFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), "utf8").includes("../"));
 } finally { rmSync(repo, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
});

test("unexpected stale files are retained and reported instead of deleted", async () => {
 const repo = fakeRepo(), agent = agentDir();
 try {
  mkdirSync(join(agent, "extensions"));
  writeFileSync(join(agent, "extensions", "opl-legacy"), "user file");
  writeFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), "opl-legacy");
  const r = await run(repo, [["PI_CODING_AGENT_DIR", agent]], ["--only", "opl-todo"]);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(join(agent, "extensions", "opl-legacy"), "utf8"), "user file");
  assert.ok(readFileSync(join(agent, "extensions", ".opl-pi-sht.installed"), "utf8").split("\n").includes("opl-legacy"));
 } finally { rmSync(repo, { recursive: true, force: true }); rmSync(agent, { recursive: true, force: true }); }
});
