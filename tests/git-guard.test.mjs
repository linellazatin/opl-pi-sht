import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  fingerprintGit,
  gitGuardEnv as initGuardEnv,
  safeGitInvocation as initSafeArgs,
} from "../extensions/opl-init/index.ts";
import {
  gitGuardEnv as footerGuardEnv,
  safeGitInvocation as footerSafeArgs,
} from "../extensions/opl-footer/git-status.ts";

/**
 * A repository whose own config names a program: `* diff=canary` plus
 * `[diff "canary"] textconv` fires whenever git is asked for patch content.
 */
async function hostileRepo() {
  const root = await mkdtemp(join(tmpdir(), "opl-git-guard-"));
  const marker = join(root, "CANARY");
  const repo = join(root, "repo");
  const spawn = (args, cwd = repo) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

  const initialized = spawn(["init", "-q", repo], root);
  assert.equal(initialized.status, 0, initialized.stderr);
  spawn(["-c", "user.email=a@example.invalid", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"]);
  await writeFile(join(repo, "notes.txt"), "one\n");
  await writeFile(join(repo, ".gitattributes"), "* diff=canary\n");
  spawn(["add", "-A"]);
  spawn(["-c", "user.email=a@example.invalid", "-c", "user.name=Test", "commit", "-qm", "files"]);
  spawn(["config", "diff.canary.textconv", `sh -c 'echo ran > "${marker}"; cat'`]);
  await writeFile(join(repo, "notes.txt"), "one\ntwo\n"); // dirty worktree, so a diff has content
  return root;
}

const markerOf = (root) => join(root, "CANARY");
const repoOf = (root) => join(root, "repo");

test("the fixture really executes a declared textconv driver", async () => {
  const root = await hostileRepo();
  try {
    const result = spawnSync("git", ["diff", "HEAD"], {
      cwd: repoOf(root),
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(markerOf(root)), true, "unsanitised patch content ran the driver");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the guard keeps a patch request from executing repository-declared programs", async () => {
  const root = await hostileRepo();
  try {
    const result = spawnSync("git", initSafeArgs(["diff", "HEAD"]), {
      cwd: repoOf(root),
      encoding: "utf8",
      env: initGuardEnv({ PATH: process.env.PATH ?? "" }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /notes\.txt/, "the diff still reports the change");
    assert.equal(existsSync(markerOf(root)), false, "textconv must not run through the guard");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opl-init fingerprints a hostile worktree without executing its driver", async () => {
  const root = await hostileRepo();
  try {
    const digest = fingerprintGit(repoOf(root));
    assert.match(digest, /^[0-9a-f]{16}$/, "the short fingerprint form, unchanged by the guard");
    assert.equal(existsSync(markerOf(root)), false);
    assert.equal(existsSync(join(root, "CANARY")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opl-footer porcelain calls work and stay marker-free under the guard", async () => {
  const root = await hostileRepo();
  try {
    const status = spawnSync("git", footerSafeArgs(["status", "--porcelain"]), {
      cwd: repoOf(root),
      encoding: "utf8",
      env: footerGuardEnv(),
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /notes\.txt/);
    const branch = spawnSync("git", footerSafeArgs(["branch", "--show-current"]), {
      cwd: repoOf(root),
      encoding: "utf8",
      env: footerGuardEnv(),
    });
    assert.equal(branch.status, 0, branch.stderr);
    assert.equal(existsSync(markerOf(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff flags are inserted after the subcommand, plumbing is left alone", () => {
  assert.deepEqual(initSafeArgs(["rev-parse", "HEAD"]), [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "credential.helper=",
    "rev-parse",
    "HEAD",
  ]);
  const diff = initSafeArgs(["diff", "HEAD", "--name-only", "-z"]);
  const at = diff.indexOf("diff");
  assert.ok(at > 0, "the subcommand comes after the global guard");
  assert.deepEqual(diff.slice(at, at + 3), ["diff", "--no-ext-diff", "--no-textconv"], "refusal flags bind to the subcommand");
  assert.deepEqual(diff.slice(at + 3), ["HEAD", "--name-only", "-z"], "caller arguments keep their order");
  assert.ok(diff.includes("--name-only"));
  assert.ok(initSafeArgs(["log", "--oneline"]).includes("--no-textconv"));
  assert.ok(!initSafeArgs(["ls-files", "-z"]).includes("--no-textconv"));
  assert.deepEqual(footerSafeArgs(["diff", "HEAD"]), initSafeArgs(["diff", "HEAD"]));
});

test("the guard environment is additive and refuses prompts and locks", () => {
  const env = initGuardEnv({ PATH: "/usr/bin", NOISE: undefined });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal("NOISE" in env, false, "undefined values are dropped");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.deepEqual(footerGuardEnv({ PATH: "/usr/bin" }), initGuardEnv({ PATH: "/usr/bin" }));
});

test("neither copy reads the user's own git config when probing", async () => {
  const root = await hostileRepo();
  const globalConfig = join(root, "gitconfig");
  await writeFile(globalConfig, '[diff "canary"]\n\ttextconv = sh -c \'echo ran > "' + markerOf(root) + '"; cat\'\n');
  try {
    // HOME points at an empty fixture so a real ~/.gitconfig cannot be consulted either.
    const env = { ...initGuardEnv(), HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_GLOBAL: globalConfig };
    const result = spawnSync("git", initSafeArgs(["diff", "HEAD"]), {
      cwd: repoOf(root),
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(markerOf(root)), false, "GIT_CONFIG_NOSYSTEM plus HOME pinning keep user config out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both call sites wire every git probe through the guard", () => {
  // These probes ask for name-only or porcelain output, which cannot execute a textconv
  // driver anyway, so the wiring itself is asserted from source: nothing may call git with
  // raw args, through a shell string, or without the guard environment.
  const init = readFileSync(new URL("../extensions/opl-init/index.ts", import.meta.url), "utf8");
  const footer = readFileSync(new URL("../extensions/opl-footer/git-status.ts", import.meta.url), "utf8");
  for (const source of [init, footer]) {
    assert.ok(!/execSync\(\s*["`]git/.test(source), "no shell interpolation of git calls");
  }
  assert.ok(init.includes('execFileSync("git", safeGitInvocation(args)'));
  assert.ok(init.includes("env: gitGuardEnv(),"));
  assert.ok(footer.includes('spawn("git", safeGitInvocation(args)'));
  assert.ok(footer.includes("env: gitGuardEnv(),"));
  assert.equal(init.split('"git"').length - 1, 1, "one git entry point per extension");
  assert.equal(footer.split('"git"').length - 1, 1);
});
