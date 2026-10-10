// The footer invalidates its git caches from tool results and `!` commands. Both paths take
// provider- or user-supplied values, so only a genuine string is matched: coercion would turn
// an array into a comma-joined near-miss or an object into "[object Object]" noise.
import assert from "node:assert/strict";
import { test } from "bun:test";

import { mentionsGitBranchChange } from "../extensions/opl-footer/index.ts";

test("branch-changing commands invalidate, ordinary ones do not", () => {
  for (const command of [
    "git checkout -b feature",
    "git switch main",
    "git branch -d old",
    "git merge other",
    "git rebase origin/main",
    "git pull",
    "git reset --hard HEAD~1",
    "git init",
    "git clone url",
    "git worktree add ../w",
    "git stash pop",
    "npm ci && git checkout v1",
  ]) {
    assert.equal(mentionsGitBranchChange(command), true, command);
  }
  for (const command of [
    "npm test",
    "ls",
    "grep git README.md",
    "git status",
    "git log --oneline",
    "git diff",
    "git stash",
    "git stash list",
    "",
  ]) {
    assert.equal(mentionsGitBranchChange(command), false, command);
  }
});

test("a non-string command is refused instead of coerced", () => {
  const coercible = { toString: () => "git checkout main" };
  for (const value of [
    ["git", "checkout", "main"],
    { command: "git checkout main" },
    coercible,
    42,
    null,
    undefined,
    true,
  ]) {
    assert.equal(mentionsGitBranchChange(value), false, JSON.stringify(value) ?? String(value));
  }
});
