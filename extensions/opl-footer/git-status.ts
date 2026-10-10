import { spawn } from "node:child_process";
import type { GitStatus } from "./types.js";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

const CACHE_TTL_MS = 1000;
const BRANCH_TTL_MS = 500;
// Outside a repository git exits non-zero on every probe. Arm a long back-off on the first
// failure so an idle footer stops spawning git once per second, and clear it when
// `rev-parse --is-inside-work-tree` proves the failure was transient — or when `git init`
// happens mid-session and a cache invalidation/`git init` match clears it.
const NOT_A_REPO_TTL_MS = 30_000;
let cachedStatus: CachedGitStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let pendingFetch: Promise<void> | null = null;
let pendingBranchFetch: Promise<void> | null = null;
let invalidationCounter = 0;
let branchInvalidationCounter = 0;
let repoAbsentUntil = 0;
let repoCheckInFlight = false;

let clock: () => number = () => Date.now();

/** Test seam: override the time source so TTL/back-off behaviour is deterministic. */
export function setClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

/** Assume "not a repo" immediately, then confirm asynchronously so a real repo recovers. */
function noteProbeFailure(): void {
  repoAbsentUntil = clock() + NOT_A_REPO_TTL_MS;
  if (repoCheckInFlight) return;
  repoCheckInFlight = true;
  void runGit(["rev-parse", "--is-inside-work-tree"]).then((out) => {
    if (out === "true") repoAbsentUntil = 0;
    repoCheckInFlight = false;
  });
}

function repoAbsent(): boolean {
  return clock() < repoAbsentUntil;
}

function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    if (x && x !== " " && x !== "?") {
      staged++;
    }

    if (y && y !== " ") {
      unstaged++;
    }
  }

  return { staged, unstaged, untracked };
}

// BEGIN SHARED GIT GUARD
// A repository is attacker-chosen data: its local config, `.gitattributes` and system
// config can name programs that git runs while answering what looks like a read-only query.
// Measured on git 2.54: `git diff HEAD` executes a declared `[diff "x"] textconv` driver,
// while `--name-only`, `status --porcelain`, `ls-files` and `rev-parse` do not. Every call
// still goes through this guard so a future content-diff call cannot reintroduce the
// execution path. Duplicated per extension because install.sh installs one directory at a
// time; tests/net-guard-parity.test.mjs fails if the copies drift.
const SAFE_GIT_GLOBAL_ARGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "credential.helper=",
];

/** Refuse external content handlers. Diff-family subcommands only: plumbing rejects them. */
const SAFE_GIT_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];
const GIT_DIFF_COMMANDS = new Set(["diff", "log", "show", "stash", "range-diff", "format-patch"]);

const SAFE_GIT_ENV: Record<string, string> = {
  // /etc/gitconfig and the user's own config can name helpers; a repo probe must not read them.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_PAGER: "cat",
  // A credential prompt would hang the caller instead of failing fast.
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  // Read-only plumbing must not create or wait on index.lock.
  GIT_OPTIONAL_LOCKS: "0",
};

export function safeGitInvocation(args: string[]): string[] {
  const [subcommand, ...rest] = args;
  const diffFlags = subcommand && GIT_DIFF_COMMANDS.has(subcommand) ? SAFE_GIT_DIFF_FLAGS : [];
  // A missing subcommand must not reach execFileSync/spawn as an undefined argv slot.
  return subcommand
    ? [...SAFE_GIT_GLOBAL_ARGS, subcommand, ...diffFlags, ...rest]
    : [...SAFE_GIT_GLOBAL_ARGS, ...rest];
}

export function gitGuardEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...SAFE_GIT_ENV };
}
// END SHARED GIT GUARD

function runGit(args: string[], timeoutMs = 200): Promise<string | null> {
  // Porcelain/name-only only; the guard above refuses patch content.
  return new Promise((resolve) => {
    const proc = spawn("git", safeGitInvocation(args), {
      env: gitGuardEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function fetchGitBranch(): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"]);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"]);
  return sha ? `${sha} (detached)` : "detached";
}

async function fetchGitStatus(): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--porcelain"], 500);
  if (output === null) return null;
  return parseGitStatusOutput(output);
}

export function getCurrentBranch(providerBranch: string | null): string | null {
  const now = clock();

  if (now < repoAbsentUntil) {
    return cachedBranch ? cachedBranch.branch : providerBranch;
  }

  if (cachedBranch && now - cachedBranch.timestamp < BRANCH_TTL_MS) {
    return cachedBranch.branch;
  }

  if (!pendingBranchFetch) {
    const fetchId = branchInvalidationCounter;
    pendingBranchFetch = fetchGitBranch().then((result) => {
      // Everything below belongs to the pre-invalidation directory state: a probe that
      // started before `git init` must not re-arm the back-off or publish a null branch.
      if (fetchId === branchInvalidationCounter) {
        if (result === null) noteProbeFailure();
        cachedBranch = {
          branch: result,
          timestamp: clock(),
        };
      }
      pendingBranchFetch = null;
    });
  }

  return cachedBranch ? cachedBranch.branch : providerBranch;
}

export function getGitStatus(providerBranch: string | null): GitStatus {
  const now = clock();

  if (now < repoAbsentUntil) {
    const branch = cachedBranch ? cachedBranch.branch : providerBranch;
    return cachedStatus
      ? { branch, staged: cachedStatus.staged, unstaged: cachedStatus.unstaged, untracked: cachedStatus.untracked }
      : { branch, staged: 0, unstaged: 0, untracked: 0 };
  }

  const branch = getCurrentBranch(providerBranch);

  if (cachedStatus && now - cachedStatus.timestamp < CACHE_TTL_MS) {
    return {
      branch,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  if (!pendingFetch) {
    const fetchId = invalidationCounter;
    pendingFetch = fetchGitStatus().then((result) => {
      // Same as the branch probe: a failure from before an invalidation is stale, and
      // arming the 30 s not-a-repo back-off from it would hide a just-created repository.
      if (fetchId === invalidationCounter) {
        if (result === null) noteProbeFailure();
        cachedStatus = result
          ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked, timestamp: clock() }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: clock() };
      }
      pendingFetch = null;
    });
  }

  if (cachedStatus) {
    return {
      branch,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  return { branch, staged: 0, unstaged: 0, untracked: 0 };
}

export function invalidateGitStatus(): void {
  cachedStatus = null;
  invalidationCounter++;
  repoAbsentUntil = 0;
}

export function invalidateGitBranch(): void {
  cachedBranch = null;
  branchInvalidationCounter++;
  repoAbsentUntil = 0;
}
