import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
]);
const MAX_DEPTH = 3;
const MAX_TREE_LINES = 300;
const MAX_MANIFEST_BYTES = 2048;

type Crawl = {
  tree: string[];
  extCounts: Map<string, number>;
  manifests: { path: string; content: string }[];
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
    return createHash("sha256").update(head).update(status).digest("hex").slice(0, 16);
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
  };

  function walk(dir: string, depth: number, prefix: string) {
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
    for (const dirName of dirs) {
      if (result.tree.length >= MAX_TREE_LINES) return;
      result.tree.push(`${prefix}${dirName}/`);
      if (depth < MAX_DEPTH) walk(join(dir, dirName), depth + 1, `${prefix}  `);
    }
    for (const fileName of files) {
      if (result.tree.length >= MAX_TREE_LINES) return;
      result.tree.push(`${prefix}${fileName}`);
    }
  }

  walk(root, 0, "");
  return result;
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

function buildContext(root: string, crawlResult: Crawl): string {
  const extensions = [...crawlResult.extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([extension, count]) => `${extension} (${count})`)
    .join(", ");
  const sections = [
    `## Repository crawl for: ${root}`,
    `### Directory tree (depth ${MAX_DEPTH}, common generated/dependency directories ignored)\n\`\`\`\n${crawlResult.tree.join("\n")}\n\`\`\``,
    `### File counts by extension\n${extensions || "(none)"}`,
  ];

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

  return sections.join("\n\n");
}

const PROMPT = `Generate or update AGENTS.md as an agent guide for this repository.
If AGENTS.md already exists and the repository crawl below says it is current, do not overwrite or modify it. If it is marked stale, update it. If it does not exist, create it.

Use the deterministic crawl as the primary source of truth. Read only a few specific files when necessary to confirm repository-specific facts; do not re-crawl the tree.

Produce a concise, useful Markdown guide, usually 250-700 words:
- Start with a project-specific title such as "# Repository Guide" or "# <project>".
- Prefer these sections when supported by evidence: "## What this is", "## Commands", "## Architecture", "## Configuration and installation", "## Testing and operational quirks", and "## Key files".
- State meaningful absences when known, such as no build, lint, or typecheck command.
- Capture non-obvious constraints, state, deployment, security, or test-order invariants when they materially affect contributors.
- Avoid generic contribution, Git, or pull-request advice unless the repository supplies specific facts for it.
- Omit unsupported sections rather than inventing details.
- IMPORTANT: when you write or update AGENTS.md, make the very last line exactly the fingerprint marker given below (verbatim, no changes). This lets future runs detect staleness.

---
`;

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

      pi.sendUserMessage(
        `${PROMPT}\n${status}\nFingerprint marker to append as the last line: ${marker}\n\n${buildContext(root, crawl(root))}`,
      );
    },
  });
}
