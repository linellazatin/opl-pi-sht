import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

// ponytail: fixed ignore list instead of a full .gitignore parser.
const IGNORE = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", "out",
  "coverage", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  ".idea", ".vscode", "vendor", ".turbo", ".cache",
]);
const MANIFESTS = new Set([
  "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml",
  "build.gradle", "Gemfile",
  // Monorepo structure declarations. turbo.json/nx.json are listed for context
  // only; package locations come from the package manager's workspace config.
  "pnpm-workspace.yaml", "turbo.json", "nx.json",
]);
const MAX_DEPTH = 3;
const MAX_MEMBER_DEPTH = 3;
const MAX_TREE_LINES = 300;
const MAX_MANIFEST_PARSE_BYTES = 262144;
const MAX_DIR_ENTRIES = 40;
// Bumping this constant is how generator upgrades invalidate every
// previously-written guide: it is a fingerprint input.
const GUIDE_SCHEMA_VERSION = 1;

type Crawl = {
  tree: string[];
  extCounts: Map<string, number>;
  manifests: { path: string; content: string }[];
  workspaceMembers: string[];
  seen: Set<string>;
};

// Marker the model appends to AGENTS.md so future runs can detect staleness exactly.
const FP_MARKER = /<!-- opl-init:fp (\S+) -->/;

// Exact snapshot of git-tracked + untracked state. Respects .gitignore for free.
// Content-based: HEAD + per-path content hashes of every dirty tracked file
// (vs HEAD, so staged changes count) and every untracked file. Only the root
// AGENTS.md is excluded, so writing the guide does not make it stale;
// subdirectory AGENTS.md files are repository facts.
// Returns null for non-git directories (caller falls back to fingerprintFallback).
function fingerprintGit(root: string): string | null {
  const head = gitOutput(root, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const hash = createHash("sha256").update(`schema:${GUIDE_SCHEMA_VERSION}\0head:${head}\0`);
  // --relative keeps diff paths cwd-relative and cwd-scoped, matching
  // ls-files --others and the crawl; without it a subdirectory session would
  // resolve every dirty path to a nonexistent file and hash "DELETED".
  for (const path of (gitOutput(root, ["diff", "HEAD", "--name-only", "-z", "--relative"]) ?? "").split("\0")) {
    if (!path || path === "AGENTS.md") continue;
    hash.update(`${path}\0`).update(hashFile(join(root, path))).update("\0");
  }
  for (const path of (gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split("\0")) {
    if (!path || path === "AGENTS.md") continue;
    hash.update(`${path}\0`).update(hashFile(join(root, path))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "DELETED";
  }
}

// ponytail: stat-only (path|size|mtime), not content hashing. Catches add/delete/
// rename but shares the touch-without-change blind spot; only used for non-git dirs.
function fingerprintFallback(root: string): string {
  const parts: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry)) continue;
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(path);
      } else if (entry !== "AGENTS.md") {
        parts.push(`${relative(root, path)}|${stats.size}|${stats.mtimeMs}`);
      }
    }
  }

  walk(root);
  parts.sort();
  return createHash("sha256").update(`schema:${GUIDE_SCHEMA_VERSION}\n`).update(parts.join("\n")).digest("hex").slice(0, 16);
}

function fingerprint(root: string): string {
  return fingerprintGit(root) ?? fingerprintFallback(root);
}

function crawl(root: string): Crawl {
  const result: Crawl = {
    tree: [],
    extCounts: new Map(),
    manifests: [],
    workspaceMembers: [],
    seen: new Set(),
  };

  function walk(dir: string, depth: number, prefix: string, maxDepth: number) {
    if (result.tree.length >= MAX_TREE_LINES) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (IGNORE.has(entry)) continue;
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        dirs.push(entry);
        continue;
      }

      files.push(entry);
      // Dedupe by absolute path: declared-member re-walks overlap the root
      // walk, and the inventory must not double-count. Tree lines still
      // accept shallow overlap for completeness.
      if (!result.seen.has(path)) {
        result.seen.add(path);
        const extension = extname(entry) || entry;
        result.extCounts.set(extension, (result.extCounts.get(extension) ?? 0) + 1);

        if (MANIFESTS.has(entry)) {
          try {
            result.manifests.push({
              path: relative(root, path),
              content: readFileSync(path, "utf8").slice(0, MAX_MANIFEST_PARSE_BYTES),
            });
          } catch {
            // Skip unreadable manifests.
          }
        }
      }
    }

    dirs.sort();
    files.sort();
    // ponytail: single combined per-directory cap; one omission line instead of
    // a priority queue. Revisit if real repos starve important branches.
    const all = [...dirs.map((d) => `${d}/`), ...files];
    for (let i = 0; i < all.length; i++) {
      if (result.tree.length >= MAX_TREE_LINES) break;
      if (i >= MAX_DIR_ENTRIES) {
        result.tree.push(`${prefix}... (${all.length - MAX_DIR_ENTRIES} more entries omitted)`);
        break;
      }
      const entry = all[i];
      result.tree.push(`${prefix}${entry}`);
      if (entry.endsWith("/") && depth < maxDepth) {
        walk(join(dir, entry.slice(0, -1)), depth + 1, `${prefix}  `, maxDepth);
      }
    }
  }

  walk(root, 0, "", MAX_DEPTH);

  // Manifest-first monorepo expansion: enumerate declared workspace members
  // with a fresh depth budget so packages/foo/src is not penalized by its
  // grouping prefix.
  for (const member of workspaceMembers(root)) {
    if (result.tree.length >= MAX_TREE_LINES) break;
    const abs = join(root, member);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    // Always re-walk declared members with a full fresh budget: partial root-
    // walk coverage must not truncate member internals. Shallow overlap with
    // the root tree is accepted as the cost of completeness.
    result.workspaceMembers.push(member);
    result.tree.push(`${member}/`);
    walk(abs, 0, "  ", MAX_MEMBER_DEPTH);
  }

  // Explicit truncation signal — never leave the model guessing whether the
  // tree is complete.
  if (result.tree.length >= MAX_TREE_LINES) {
    result.tree.push(`(tree truncated at ${MAX_TREE_LINES} entries)`);
  }
  return result;
}

// ponytail: naive glob matcher supporting only what workspace files use in
// practice: `**` across segments, `*` within a segment, optional trailing "/".
function globToRegExp(pattern: string): RegExp {
  const cleaned = pattern.replace(/\/$/, "");
  const source = cleaned
    .split("/**/")
    .map((seg) => seg.replace(/[*]/g, "[^/]*"))
    .join("(?:/.*)?");
  return new RegExp(`^${source}$`);
}

// ponytail: line-based subset parsing of pnpm-workspace.yaml and Cargo.toml
// [workspace] members. Full YAML/TOML parsing not warranted for glob lists.
function workspaceMembers(root: string): string[] {
  const globs: string[] = [];

  try {
    const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const line of yaml.split("\n")) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
      } else if (/^\S/.test(line)) {
        inPackages = false;
      } else if (inPackages) {
        const match = line.match(/^\s*-\s*["']?([^"'#]+)/);
        if (match) globs.push(match[1].trim());
      }
    }
  } catch {
    // No pnpm-workspace.yaml.
  }

  try {
    const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
    const section = toml.match(/\[workspace\]([\s\S]*?)(?:\n\[|\s*$)/);
    const membersBlock = section?.[1].match(/members\s*=\s*\[([^\]]*)\]/s);
    if (membersBlock) {
      for (const m of membersBlock[1].matchAll(/["']([^"']+)["']/g)) {
        globs.push(m[1]);
      }
    }
  } catch {
    // No Cargo.toml.
  }

  const members = new Set<string>();
  for (const glob of globs) {
    const re = globToRegExp(glob);
    // Match against shallow candidate paths from the tree we already walked,
    // plus one extra readdir of likely parent dirs. Simple approach: test every
    // tree dir line's relative path.
    for (const line of result_tree_paths(root)) {
      if (re.test(line)) members.add(line);
    }
  }
  return [...members].sort();
}

// Candidate relative paths for glob matching: all directory paths up to
// MAX_DEPTH derived from a fresh cheap listing (not the truncated tree).
function result_tree_paths(root: string): string[] {
  const paths: string[] = [];
  function walkList(dir: string, rel: string, depth: number) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry)) continue;
      try {
        if (!statSync(join(dir, entry)).isDirectory()) continue;
      } catch {
        continue;
      }
      const childRel = rel ? `${rel}/${entry}` : entry;
      paths.push(childRel);
      if (depth < MAX_DEPTH + 1) walkList(join(dir, entry), childRel, depth + 1);
    }
  }
  walkList(root, "", 0);
  return paths;
}

// Root-first, per-package-labeled script lines, bounded at 30 entries total.
function aggregateScripts(manifests: { path: string; content: string }[]): string | null {
  const lines: string[] = [];
  const sorted = [...manifests].sort((a, b) =>
    a.path === "package.json" ? -1 : b.path === "package.json" ? 1 : a.path.localeCompare(b.path));
  for (const manifest of sorted) {
    if (!manifest.path.endsWith("package.json") || lines.length >= 30) continue;
    let parsed;
    try {
      parsed = JSON.parse(manifest.content);
    } catch {
      continue;
    }
    const scripts = parsed?.scripts;
    if (!scripts || typeof scripts !== "object") continue;
    const label = manifest.path === "package.json" ? "" : `${manifest.path.replace(/\/package\.json$/, "")}/ `;
    for (const [name, command] of Object.entries(scripts)) {
      if (lines.length >= 30) break;
      lines.push(`  ${label}${name}: ${command}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

function buildGuide(root: string, crawlResult: Crawl, marker: string): string {
  const topLevel = crawlResult.tree.filter(line => !line.startsWith("  ")).slice(0, 30).join(", ");
  const scripts = aggregateScripts(crawlResult.manifests);
  const commandBlock = scripts ? "Package scripts:\n```\n" + scripts + "\n```" : "No package scripts were detected by the repository crawl.";
  return `# Repository Guide\n\n## What this is\n\nRepository at \`${root}\`. Use the repository files as the source of truth; the top-level inventory includes ${topLevel || "(not available)"}.\n\n## Commands\n\n${commandBlock}\n\n## Repository inventory\n\n- File types: ${[...crawlResult.extCounts.entries()].map(([extension, count]) => `${extension} (${count})`).join(", ") || "none detected"}.\n- Inspect specific files before changing behavior; this guide is a starting point, not a substitute for reading the code.\n\n## Agent workflow\n\nKeep changes focused on the requested behavior, preserve existing interfaces, and run the narrowest relevant test before the full suite. Keep secrets and generated output out of tracked configuration.\n${marker}\n`;
}

const MAX_EVIDENCE_BYTES = 24576;
const MAX_README_HEAD_BYTES = 2048;

// Evidence the model cannot fetch itself: the deterministic stand-in for the
// tools the refine call does not have, under a hard byte budget. The spec's
// three parts: baseline guide, full per-package scripts blocks, readme heads.
function evidencePacket(
  root: string,
  baseline: string,
  crawlResult: { manifests: { path: string; content: string }[]; workspaceMembers: string[] },
): string {
  const parts = [baseline];
  let used = Buffer.byteLength(baseline, "utf8");
  const push = (block: string): boolean => {
    const bytes = Buffer.byteLength(block, "utf8") + 1;
    if (used + bytes > MAX_EVIDENCE_BYTES) {
      parts.push("(evidence truncated)");
      return false;
    }
    used += bytes;
    parts.push(block);
    return true;
  };
  for (const manifest of crawlResult.manifests) {
    if (!manifest.path.endsWith("package.json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(manifest.content);
    } catch {
      continue;
    }
    const scripts = parsed?.scripts;
    if (!scripts || typeof scripts !== "object") continue;
    const block = `=== scripts: ${manifest.path} ===\n${Object.entries(scripts).map(([name, command]) => `${name}: ${command}`).join("\n")}`;
    if (!push(block)) return parts.join("\n");
  }
  const candidates = ["README.md", "readme.md", "README", "CLAUDE.md"];
  const paths = [...candidates, ...crawlResult.workspaceMembers.flatMap((m) => candidates.map((c) => `${m}/${c}`))];
  for (const rel of paths) {
    let head: string;
    try {
      head = readFileSync(join(root, rel), "utf8").slice(0, MAX_README_HEAD_BYTES);
    } catch {
      continue;
    }
    if (!push(`=== ${rel} ===\n${head}`)) break;
  }
  return parts.join("\n");
}

const REFINE_SYSTEM_PROMPT = [
  "You are rewriting a repository guide for an AI coding agent.",
  "Input: a draft guide generated from a deterministic repository crawl, plus bounded file excerpts.",
  "Return ONLY the final Markdown document: no preamble, no code fence around the document, no HTML comments.",
  "Do not invent facts unsupported by the input; keep the factual inventory (commands, file types, workspace members).",
  'Prefer these sections when evidence supports them: "## What this is", "## Commands", "## Architecture", "## Configuration and installation", "## Testing and operational quirks", "## Key files". Omit unsupported sections.',
  "Usually 250-700 words. Avoid generic contribution, Git, or pull-request advice.",
].join("\n");

// The model never owns the marker line: every opl-init:fp comment is stripped
// and the extension's exact marker is appended as the final line.
function finalizeRefinedGuide(text: string, marker: string): string {
  let body = text.trim();
  // Strip a wrapper fence only when it opens *and* closes; a guide ending in
  // a legitimate code block keeps its closing fence.
  if (/^```[a-zA-Z]*\s*\n/.test(body)) {
    body = body.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```\s*$/, "");
  }
  body = body.replace(/<!-- opl-init:fp \S+ -->/g, "").trimEnd();
  return `${body}\n${marker}\n`;
}

// One out-of-band completion on the current model. No tools, no session
// message: any failure returns null and the caller writes the baseline.
// Bounded so a stalled provider cannot leave /init hanging with no UI signal
// (the old injected turn was Esc-cancellable; this replaces that escape hatch).
const REFINE_TIMEOUT_MS = 120000;

async function refineGuide(ctx: any, evidence: string, marker: string): Promise<string | null> {
  const model = ctx.model;
  if (!model || typeof ctx.modelRegistry?.streamSimple !== "function") return null;
  ctx.ui?.notify?.("opl-init: refining the guide with the current model...", "info");
  try {
    const stream = ctx.modelRegistry.streamSimple(
      model,
      { systemPrompt: REFINE_SYSTEM_PROMPT, messages: [{ role: "user", content: evidence, timestamp: Date.now() }], tools: [] },
      { reasoning: false, signal: AbortSignal.timeout(REFINE_TIMEOUT_MS) },
    );
    const result = await stream.result();
    if (!result || result.stopReason === "error" || result.stopReason === "aborted") return null;
    const text = (result.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    return text.trim() ? finalizeRefinedGuide(text, marker) : null;
  } catch {
    return null;
  }
}

// Named exports for fixture tests (tests/opl-init-*.test.mjs).
export { crawl, fingerprint, evidencePacket, finalizeRefinedGuide, refineGuide };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "[opl-init] Crawl + refine AGENTS.md out-of-band; zero model calls when current",
    handler: async (_args, ctx) => {
      const root = ctx.cwd;
      const agentsPath = join(root, "AGENTS.md");
      const storedFp = () => {
        try {
          return readFileSync(agentsPath, "utf8").match(FP_MARKER)?.[1] ?? null;
        } catch {
          return null;
        }
      };

      let currentFp = fingerprint(root);
      if (existsSync(agentsPath) && storedFp() === currentFp) {
        ctx.ui.notify("AGENTS.md is current; /init will not modify it.", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("opl-init: waiting for the current agent run to settle before writing AGENTS.md.", "info");
        await ctx.waitForIdle();
        // The settling run may have moved the tree; recompute before crawling.
        currentFp = fingerprint(root);
        if (existsSync(agentsPath) && storedFp() === currentFp) {
          ctx.ui.notify("AGENTS.md is current; /init will not modify it.", "info");
          return;
        }
      }

      const marker = `<!-- opl-init:fp ${currentFp} -->`;
      // Regenerating replaces the whole file, including hand-edited prose; the
      // repository's version control is the recovery path.
      const crawlResult = crawl(root);
      const baseline = buildGuide(root, crawlResult, marker);
      const refined = await refineGuide(ctx, evidencePacket(root, baseline, crawlResult), marker);

      try {
        writeFileSync(agentsPath, refined ?? baseline, "utf8");
      } catch (error: any) {
        ctx.ui.notify(`Could not write AGENTS.md: ${error?.message || error}`, "error");
        return;
      }

      ctx.ui.notify(
        refined
          ? "AGENTS.md written from the repository crawl (model-refined)."
          : "refine failed; wrote deterministic AGENTS.md from the repository crawl.",
        "info",
      );
      // Terminal: pi docs say code after ctx.reload() runs in the old frame.
      await ctx.reload();
      return;
    },
  });
}
