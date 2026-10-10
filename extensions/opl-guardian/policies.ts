import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Op, PathEntry } from "./config.js";

function resolveConfiguredPath(path: string, cwd: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

function physicalPath(path: string, depth = 0): string | undefined {
  if (depth > 40) return undefined;
  let current = path;
  const missing: string[] = [];
  while (true) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.unshift(basename(current));
      current = parent;
      continue;
    }
    try {
      return resolve(realpathSync(current), ...missing);
    } catch {
      if (!stat.isSymbolicLink()) return undefined;
      try {
        return physicalPath(resolve(dirname(current), readlinkSync(current), ...missing), depth + 1);
      } catch {
        return undefined;
      }
    }
  }
}

function isAbsoluteOrHomeRelative(path: string): boolean {
  return isAbsolute(path) || path.startsWith("~/");
}

function matchesResolvedPath(toolPath: string, entryPath: string, cwd: string): boolean {
  const resolvedTool = resolveConfiguredPath(toolPath, cwd);
  const resolvedEntry = resolveConfiguredPath(entryPath, cwd);
  const directoryPrefix = resolvedEntry.endsWith(sep) ? resolvedEntry : `${resolvedEntry}${sep}`;
  return resolvedTool === resolvedEntry || resolvedTool.startsWith(directoryPrefix);
}

export function matchesProtectedPath(toolPath: string, entry: PathEntry, cwd: string): boolean {
  if (isAbsoluteOrHomeRelative(entry.path)) {
    return matchesResolvedPath(toolPath, entry.path, cwd);
  }

  const segment = entry.path.replace(/[\\/]+$/, "");
  return toolPath.split(/[\\/]/).some((part) => part === segment);
}

/**
 * Split a shell command into the words a path could appear as. Quotes, command
 * substitutions, redirections and separators are treated as boundaries, so
 * `python -c 'open(".env")'` yields `.env` while `"process.env"` stays one word.
 */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const raw of command.split(/[\s'"`|&;()<>:,=]+/)) {
    const token = raw.replace(/^[-+]+/, "").replace(/[,.;:]+$/, "");
    if (token.length >= 2) tokens.push(token);
  }
  return tokens;
}

/**
 * Does this command mention the protected path?
 *
 * Matching is per token and path-aware, so argument text no longer trips the
 * rule (`grep "process.env" src` is not a read of `.env`), and tokens are
 * resolved through symlinks the same way the read/write/edit rules are. It is
 * still advisory for bash: a command that builds a path at run time
 * (`x=.env; cat $x`, `cat .en""v`) cannot be recognised from text, and a
 * `cd`-then-relative-path sequence resolves against the session cwd.
 */
export function bashCommandMentionsPath(command: string, entry: PathEntry, cwd: string): boolean {
  for (const token of commandTokens(command)) {
    if (matchesProtectedPath(token, entry, cwd)) return true;
    const resolved = resolveConfiguredPath(token, cwd);
    if (matchesResolvedPath(resolved, entry.path, cwd)) return true;
    const physical = physicalPath(resolved);
    if (physical && (matchesProtectedPath(physical, entry, cwd) || matchesResolvedPath(physical, entry.path, cwd))) {
      return true;
    }
  }
  return false;
}

export function hasPendingUserWork(entries: SessionEntry[]): boolean {
  let pending = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") pending = false;
    else if (entry.message.role === "user") pending = true;
  }
  return pending;
}

export function getProtectedPathBlock(
  toolName: string,
  toolPath: string,
  paths: PathEntry[],
  cwd: string,
): { path: string; operation: Op; unresolved?: boolean } | undefined {
  if (toolName !== "read" && toolName !== "write" && toolName !== "edit" && toolName !== "bash") {
    return undefined;
  }

  const operation = toolName;
  const guardedPaths = paths.filter((entry) => entry.deny.includes(operation));
  if (guardedPaths.length === 0) return undefined;
  let normalizedTool = toolPath;
  if (operation !== "bash") {
    normalizedTool = toolPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  }
  if (operation !== "bash") {
    if (normalizedTool.startsWith("@")) normalizedTool = normalizedTool.slice(1);
    if (normalizedTool.startsWith("file://")) {
      try {
        normalizedTool = fileURLToPath(normalizedTool);
      } catch {
        return { path: toolPath, operation, unresolved: true };
      }
    }
  }
  const canonicalTool = operation === "bash" ? undefined : physicalPath(resolveConfiguredPath(normalizedTool, cwd));
  if (operation !== "bash" && !canonicalTool) {
    return { path: toolPath, operation, unresolved: true };
  }
  for (const entry of guardedPaths) {
    // Bash gets token/path matching; its `toolPath` is the whole command, so a
    // substring test there would police argument text instead of file access.
    const matches = operation === "bash"
      ? bashCommandMentionsPath(toolPath, entry, cwd)
      : matchesProtectedPath(normalizedTool, entry, cwd) || matchesProtectedPath(canonicalTool!, entry, cwd);
    if (!matches && operation !== "bash" && isAbsoluteOrHomeRelative(entry.path)) {
      const canonicalEntry = physicalPath(resolveConfiguredPath(entry.path, cwd));
      if (!canonicalEntry) return { path: entry.path, operation, unresolved: true };
      const matched = matchesResolvedPath(canonicalTool!, canonicalEntry, cwd);
      if (!matched) continue;
      return { path: entry.path, operation };
    }

    if (matches) return { path: entry.path, operation };
  }

  return undefined;
}
