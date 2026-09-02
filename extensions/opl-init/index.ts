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
const MAX_MANIFEST_BYTES = 2048;
const MAX_DIR_ENTRIES = 40;
const MAX_RULE_SOURCE_BYTES = 2048;

// Instruction sources other coding agents use (see research/harness-init-comparison.md).
// AGENTS.md is deliberately absent — it is this command's output.
const RULE_SOURCES = [
  ".cursorrules",
  ".cursor/rules",
  ".github/copilot-instructions.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude/rules",
  ".windsurfrules",
  ".windsurf/rules",
  ".clinerules",
  ".devin/rules",
];

type Crawl = {
  tree: string[];
  extCounts: Map<string, number>;
  manifests: { path: string; content: string }[];
  workspaceMembers: string[];
};

// Marker the model appends to AGENTS.md so future runs can detect staleness exactly.
const FP_MARKER = /<!-- opl-init:fp (\S+) -->/;

// Exact snapshot of git-tracked + untracked state. Respects .gitignore for free.
// Returns null for non-git directories (caller falls back to fingerprintFallback).
function fingerprintGit(root: string): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const relevantStatus = status.split("\n").filter(line => !line.endsWith("AGENTS.md")).join("\n");
    return createHash("sha256").update(head).update(relevantStatus).digest("hex").slice(0, 16);
  } catch {
    return null;
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
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
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
      const extension = extname(entry) || entry;
      result.extCounts.set(extension, (result.extCounts.get(extension) ?? 0) + 1);

      if (MANIFESTS.has(entry)) {
        try {
          result.manifests.push({
            path: relative(root, path),
            content: readFileSync(path, "utf8").slice(0, MAX_MANIFEST_BYTES),
          });
        } catch {
          // Skip unreadable manifests.
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

function packageScripts(content: string): string | null {
  try {
    const packageJson = JSON.parse(content);
    if (!packageJson.scripts || !Object.keys(packageJson.scripts).length) return null;
    return Object.entries(packageJson.scripts)
      .map(([name, command]) => `  ${name}: ${command}`)
      .join("\n");
  } catch {
    return null;
  }
}

function findRuleSources(root: string): { path: string; detail: string }[] {
  const found: { path: string; detail: string }[] = [];
  for (const name of RULE_SOURCES) {
    const path = join(root, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      // ponytail: filenames only for rule dirs; model can read entries itself.
      let entries: string[] = [];
      try {
        entries = readdirSync(path).slice(0, 20);
      } catch {
        continue;
      }
      found.push({ path: `${name}/ (${entries.length} file${entries.length === 1 ? "" : "s"})`, detail: entries.join(", ") });
    } else {
      try {
        found.push({ path: name, detail: readFileSync(path, "utf8").slice(0, MAX_RULE_SOURCE_BYTES) });
      } catch {
        found.push({ path: name, detail: "(unreadable)" });
      }
    }
  }
  return found;
}

function buildContext(root: string, crawlResult: Crawl): string {
  const extensions = [...crawlResult.extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([extension, count]) => `${extension} (${count})`)
    .join(", ");
  const sections = [
    `## Repository crawl for: ${root}`,
    `### Directory tree (depth ${MAX_DEPTH}; declared workspace members get their own depth-${MAX_MEMBER_DEPTH} walk; per-directory entries capped at ${MAX_DIR_ENTRIES})\n\`\`\`\n${crawlResult.tree.join("\n")}\n\`\`\``,
    `### File counts by extension\n${extensions || "(none)"}`,
  ];

  if (crawlResult.workspaceMembers.length) {
    sections.push(`### Declared workspace members (expanded above)\n${crawlResult.workspaceMembers.join(", ")}`);
  }

  if (crawlResult.manifests.length) {
    // ponytail: send paths + package.json scripts only; the model can read a
    // manifest itself if it needs the raw body. Keeps the prompt small and stable.
    sections.push("### Manifests (read these files directly if you need more detail)");
    for (const manifest of crawlResult.manifests) {
      sections.push(`**${manifest.path}**`);
      if (manifest.path.endsWith("package.json")) {
        const scripts = packageScripts(manifest.content);
        if (scripts) sections.push(`Scripts:\n\`\`\`\n${scripts}\n\`\`\``);
      }
    }
  }

  const ruleSources = findRuleSources(root);
  if (ruleSources.length) {
    sections.push("### Existing agent rule sources (from other coding agents)");
    for (const source of ruleSources) {
      sections.push(`**${source.path}**\n\`\`\`\n${source.detail}\n\`\`\``);
    }
  }

  return sections.join("\n\n");
}

function fallbackGuide(root: string, crawlResult: Crawl, marker: string): string {
  const topLevel = crawlResult.tree.filter(line => !line.startsWith("  ")).slice(0, 30).join(", ");
  const scripts = crawlResult.manifests
    .map(manifest => manifest.path.endsWith("package.json") ? packageScripts(manifest.content) : null)
    .find(Boolean);
  const commandBlock = scripts ? "Package scripts:\n```\n" + scripts + "\n```" : "No package scripts were detected by the repository crawl.";
  return `# Repository Guide\n\n## What this is\n\nRepository at \`${root}\`. Use the repository files as the source of truth; the top-level inventory includes ${topLevel || "(not available)"}.\n\n## Commands\n\n${commandBlock}\n\n## Repository inventory\n\n- File types: ${[...crawlResult.extCounts.entries()].map(([extension, count]) => `${extension} (${count})`).join(", ") || "none detected"}.\n- The full crawl is available in the init task context. Inspect specific files before changing behavior.\n\n## Agent workflow\n\nKeep changes focused on the requested behavior, preserve existing interfaces, and run the narrowest relevant test before the full suite. Keep secrets and generated output out of tracked configuration.\n${marker}\n`;
}

const PROMPT = `Generate or update AGENTS.md as an agent guide for this repository. This is an execution task, not a request for prose in chat. You MUST use the write tool to write the guide to the repository's AGENTS.md path; a response containing Markdown without writing the file is a failure. After writing, use the read tool to verify the file exists and ends with the exact fingerprint marker. Do not modify, refactor, or create any other file.
If AGENTS.md already exists and the repository crawl below says it is current, do not overwrite or modify it. If it is marked stale, update it. If it does not exist, create it.

The repository crawl below (directory tree, file counts, manifests, and any existing rule sources) is the primary source of truth. It was produced for you, so do not re-crawl, re-list, or re-scan the tree, and do not spawn subagents or task lists for this. Read a small number of specific files directly only when you must confirm a repository-specific fact the crawl does not already answer.

Produce a concise, useful Markdown guide, usually 250-700 words:
- Start with a project-specific title such as "# Repository Guide" or "# <project>".
- Prefer these sections when supported by evidence: "## What this is", "## Commands", "## Architecture", "## Configuration and installation", "## Testing and operational quirks", and "## Key files".
- State meaningful absences when known, such as no build, lint, or typecheck command.
- Capture non-obvious constraints, state, deployment, security, or test-order invariants when they materially affect contributors.
- Avoid generic contribution, Git, or pull-request advice unless the repository supplies specific facts for it.
- Omit unsupported sections rather than inventing details.
- If existing agent rule sources are listed below, incorporate their relevant project-specific content into the guide. Do not copy them verbatim and do not treat them as authoritative over evidence from this repository.
- IMPORTANT: when you write or update AGENTS.md, make the very last line exactly the fingerprint marker given below (verbatim, no changes). This lets future runs detect staleness.

---
`;

// Named export for fixture tests (tests/opl-init-crawl.test.mjs).
export { crawl };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "[opl-init] Crawl the repository and generate an AGENTS.md contributor guide",
    handler: async (_args, ctx) => {
      const root = ctx.cwd;
      const agentsPath = join(root, "AGENTS.md");
      const currentFp = fingerprint(root);
      const exists = existsSync(agentsPath);

      let storedFp: string | null = null;
      if (exists) {
        try {
          storedFp = readFileSync(agentsPath, "utf8").match(FP_MARKER)?.[1] ?? null;
        } catch {
          storedFp = null;
        }
      }

      if (exists && storedFp === currentFp) {
        ctx.ui.notify("AGENTS.md is current; /init will not modify it.", "info");
        return;
      }

      const status = !exists
        ? "AGENTS.md status: missing; create it."
        : storedFp === null
          ? "AGENTS.md status: no fingerprint marker found; treat as stale and update it."
          : "AGENTS.md status: stale (fingerprint mismatch); update it.";
      const marker = `<!-- opl-init:fp ${currentFp} -->`;
      const crawlResult = crawl(root);
      try {
        writeFileSync(agentsPath, fallbackGuide(root, crawlResult, marker), "utf8");
        ctx.ui.notify("AGENTS.md baseline written; the agent will refine it from the crawl.", "info");
      } catch (error: any) {
        ctx.ui.notify(`Could not write AGENTS.md baseline: ${error?.message || error}`, "error");
      }

      pi.sendUserMessage(
        `${PROMPT}\n${status}\nFingerprint marker to append as the last line: ${marker}\n\n${buildContext(root, crawlResult)}`,
      );
    },
  });
}
