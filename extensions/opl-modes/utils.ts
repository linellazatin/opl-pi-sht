/** Pure utilities: read-only Bash gate, plan file I/O, color helpers */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { PLAN_DIR, PLAN_FILE_PREFIX } from "./config.js";
import type { PlanFileSummary } from "./types.js";

/** Serialize async model changes so the final requested model wins. */
export function createLatestModelQueue() {
  let latest = 0;
  let tail = Promise.resolve();

  return <T>(change: () => Promise<T>): Promise<T | undefined> => {
    const request = ++latest;
    tail = tail.catch(() => undefined).then(() => request === latest ? change() : undefined);
    return tail as Promise<T | undefined>;
  };
}

/** Shell operators that start a new command: chaining, pipes, separators, substitutions. */
const SEGMENT_SPLIT = /\$\(|`|[<>]\(|&&|\|\||[;|\n]/;

/** Replace quoted runs with empty pairs so operators inside strings are not read as separators. */
function blankQuotes(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

const stripQuotes = (text: string): string => text.replace(/["'\\]/g, "");

/**
 * Split a command into shell segments (chaining, pipes, `$(...)`, backticks, process
 * substitution). Segments are trimmed and empty ones dropped. `blankQuoted` hides
 * quoted string contents from the separator scan — use it for the allowlist check,
 * never for the blocklist check, because `$(...)` inside double quotes still executes.
 */
function commandSegments(command: string, blankQuoted = false): string[] {
  const source = blankQuoted ? blankQuotes(command) : command;
  return source.split(SEGMENT_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whether a destructive pattern matches the command, any of its segments, or either
 *  with quotes/backslashes stripped, so `r"m"` and `-del"ete"` cannot dodge the list. */
export function isDestructive(command: string, patterns: RegExp[]): boolean {
  const haystacks = [
    command,
    stripQuotes(command),
    ...commandSegments(command).flatMap((s) => [s, stripQuotes(s)]),
  ];
  return patterns.some((p) => haystacks.some((h) => p.test(h)));
}

/**
 * Why a Bash command must be blocked in a read-only mode, or null when it is allowed.
 * Every shell segment has to match a safe pattern (so `cat f && node -e '...'` cannot
 * ride the first command's allowance), and no destructive pattern may match anywhere.
 * An undefined or empty safe list means "no allowlist gate".
 */
export function bashBlockReason(
  command: string,
  safePatterns?: RegExp[],
  destructivePatterns?: RegExp[],
): string | null {
  if (safePatterns && safePatterns.length > 0) {
    const offender = commandSegments(command, true).find((s) => !safePatterns.some((p) => p.test(s)));
    if (offender !== undefined) return `not in safe pattern list: ${offender}`;
  }
  if (destructivePatterns && destructivePatterns.length > 0 && isDestructive(command, destructivePatterns)) {
    return `destructive pattern in: ${command}`;
  }
  return null;
}

const PLAN_ACTION_VERB = /^\s*\d+\.\s+(?:\*{1,2})?(?:add|creat|updat|fix|remov|refactor|implement|modif|chang|edit|writ|build|run|install|configur|set\s+up|delet|mov|renam|inject|migrat|replac|extract|test|deploy|integrat|convert)/i;

/** Heuristic: does text look like a plan? (numbered steps, checkboxes, structured). */
export function isPlanLike(text: string): boolean {
  const lines = text.split('\n');
  const numberedSteps = lines.filter(l => /^\s*\d+\.\s/.test(l));
  if (numberedSteps.length >= 3 && text.length > 200 && lines.some(l => PLAN_ACTION_VERB.test(l))) return true;
  const checkboxes = lines.filter(l => /^\s*- \[[ xX]\]/.test(l));
  if (checkboxes.length >= 3 && text.length > 150) return true;
  return false;
}

/** Extract the raw text under the "Plan:" header from a message. Falls back to entire message if plan-like. Returns null if no plan found. */
export function extractPlanText(message: string): string | null {
  const planMatch = message.match(/^\s*(?:#{1,6}\s*)?(?:\*{1,2})?Plan:(?:\*{1,2})?[^\n]*$/im);
  if (planMatch) {
    const afterPlan = message.slice(planMatch.index! + planMatch[0].length);
    return afterPlan.trim();
  }
  // Fallback: if message looks like a plan, use entire message
  if (isPlanLike(message)) return message.trim();
  return null;
}

// ─── Plan File I/O ────────────────────────────────────────────────────────────

/** Ensure .pi/plans/ exists, return its absolute path. */
export function ensurePlanDir(): string {
  const dir = join(process.cwd(), PLAN_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Derive display title from filename.
 *  For named plans (e.g. plan-add-auth.md) → "Add Auth".
 *  For timestamp plans (e.g. plan-2026-05-10-14-30.md) → "May 10, 2026 14:30". */
export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/^plan-/ , "").replace(/\.md$/, "");

  // Detect timestamp pattern: YYYY-MM-DD-HH-MM
  const tsMatch = stem.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (tsMatch) {
    const [, y, m, d, h, min] = tsMatch;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[parseInt(m, 10) - 1] ?? m;
    return `${month} ${parseInt(d, 10)}, ${y} ${h}:${min}`;
  }

  // Named plan: hyphens → spaces, title-case
  return stem.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Sanitize a plan name — reject path traversal and invalid characters. Returns null if invalid. */
export function sanitizePlanName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  if (!/^[\w\s.-]+$/.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, "-");
}

/** List available plan files in .pi/plans/ with titles from # Plan: heading. */
export function listPlanFiles(): PlanFileSummary[] {
  const dir = join(process.cwd(), PLAN_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.startsWith(PLAN_FILE_PREFIX) && f.endsWith(".md"))
    .sort();

  return files.map((filename) => {
    const content = readFileSync(join(dir, filename), "utf-8");
    const titleMatch = content.match(/^# Plan:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : titleFromFilename(filename);
    return { name: filename, title };
  });
}

/** Extract text content from an LLM message (string or array of content blocks). */
export function extractTextFromMessage(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: unknown): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && "type" in block && (block as { type: string }).type === "text",
      )
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return null;
}

// ─── Color Utilities ────────────────────────────────────────────────────────

/** Check if a color string is a hex color (e.g. "#ff6600"). */
export function isHexColor(color: string): boolean {
  return color.startsWith("#");
}

/** Convert hex color string to ANSI truecolor escape. */
function hexToAnsi(hex: string): string {
  // Accept the #abc shorthand so a three-digit value renders the same as #aabbcc.
  let h = hex.replace("#", "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Apply a color to text — supports pi theme tokens and hex values. */
export function applyLabelColor(theme: Theme, color: string, text: string): string {
  if (isHexColor(color)) {
    const ansi = hexToAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[39m`;
  }
  try {
    return theme.fg(color as ThemeColor, text);
  } catch {
    return text;
  }
}