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

/** Assume "not a repo" immediately, then confirm asynchronously so a real repo recovers. */
function noteProbeFailure(): void {
  repoAbsentUntil = Date.now() + NOT_A_REPO_TTL_MS;
  if (repoCheckInFlight) return;
  repoCheckInFlight = true;
  void runGit(["rev-parse", "--is-inside-work-tree"]).then((out) => {
    if (out === "true") repoAbsentUntil = 0;
    repoCheckInFlight = false;
  });
}

function repoAbsent(): boolean {
  return Date.now() < repoAbsentUntil;
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

function runGit(args: string[], timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
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
  const now = Date.now();

  if (now < repoAbsentUntil) {
    return cachedBranch ? cachedBranch.branch : providerBranch;
  }

  if (cachedBranch && now - cachedBranch.timestamp < BRANCH_TTL_MS) {
    return cachedBranch.branch;
  }

  if (!pendingBranchFetch) {
    const fetchId = branchInvalidationCounter;
    pendingBranchFetch = fetchGitBranch().then((result) => {
      if (result === null) noteProbeFailure();
      if (fetchId === branchInvalidationCounter) {
        cachedBranch = {
          branch: result,
          timestamp: Date.now(),
        };
      }
      pendingBranchFetch = null;
    });
  }

  return cachedBranch ? cachedBranch.branch : providerBranch;
}

export function getGitStatus(providerBranch: string | null): GitStatus {
  const now = Date.now();

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
      if (result === null) noteProbeFailure();
      if (fetchId === invalidationCounter) {
        cachedStatus = result
          ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked, timestamp: Date.now() }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: Date.now() };
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
