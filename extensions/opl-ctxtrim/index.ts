import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// opl-ctxtrim trims the verbose descriptions that the third-party context-mode
// MCP bridge attaches to its ctx_* tools. It edits only the serialized provider
// payload in the documented `before_provider_request` hook, so the installed
// context-mode package (and its tool execution) is never modified. Tool names,
// schema structure, required fields, enums, defaults, bounds, and strict flags
// are preserved; only human-readable `description` prose is shortened.

// Concise top-level descriptions for the eleven ctx_* tools shipped by
// context-mode v1.0.169. Any ctx_* tool NOT listed here is left unchanged so a
// future context-mode release cannot have its semantics silently rewritten.
export const CTX_DESCRIPTIONS: Record<string, string> = {
  ctx_execute:
    "Run code in a sandbox; only what you print (console.log/print/echo) enters context. Use to derive answers from large data (filter, parse, aggregate, transform) without loading raw bytes. Pass background:true to keep a server/daemon alive past the timeout; pass intent to auto-index large output for ctx_search.",
  ctx_execute_file:
    "Run code over one file loaded as FILE_CONTENT in a sandbox; only printed output enters context. Use to analyze a large file (line counts, pattern matches, structure, aggregates) without reading raw bytes. Use the Read tool instead when you intend to edit the file.",
  ctx_index:
    "Store text/markdown, a file, or a directory into the searchable FTS5 knowledge base for later ctx_search. Prefer `path` over `content` so bytes never pass through context. Not for logs, test output, or single-use data.",
  ctx_search:
    "Search the indexed knowledge base and captured session memory (BM25 + trigram, typo-corrected, ranked). Batch every question into one `queries` array; scope with `source`; use sort:\"timeline\" for chronological recall and contentType to filter code vs prose. Content must be indexed first.",
  ctx_fetch_and_index:
    "Fetch URL(s) (HTML->markdown, JSON, or text), index them, and return a small preview; raw page bytes never enter context. Use `requests` with concurrency 2-8 for batches; `force`/`ttl` control the 24h cache. Retrieve content with ctx_search.",
  ctx_batch_execute:
    "Run multiple shell commands in one call, auto-index their output, and return the sections matching `queries` in the same round trip. Use concurrency 2-8 for I/O-bound commands; keep concurrency 1 for CPU-bound or stateful commands. Put all questions in `queries`.",
  ctx_stats:
    "Show this session's context-consumption statistics: bytes returned, per-tool breakdown, estimated tokens, and savings ratio. Read-only.",
  ctx_doctor:
    "Diagnose the context-mode install; returns [OK]/[WARN]/[FAIL] checks for runtimes, storage, server, FTS5/SQLite, and hooks.",
  ctx_upgrade:
    "Return the shell command that upgrades context-mode. Run it with your shell tool, show the result as a checklist, and tell the user to restart the session.",
  ctx_purge:
    "DESTRUCTIVE and irreversible. Requires confirm:true and exactly one scope: `sessionId` wipes a single session; scope:\"project\" wipes the whole project (FTS5 + every session + stats). Never combine `sessionId` with scope:\"project\".",
  ctx_insight:
    "Open the context-mode Insight dashboard in the browser. Not a query engine; use ctx_search for indexed content.",
};

// Shorten a nested JSON Schema parameter description to its first sentence or
// line. Only `description` text is touched, never validation keywords.
export function shortenParamDescription(text: string): string {
  const firstLine = text.split("\n", 1)[0].trim();
  const sentenceEnd = firstLine.search(/\.\s|\.$/);
  const clipped = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  return clipped.length > 160 ? `${clipped.slice(0, 157).trimEnd()}...` : clipped;
}

// Recursively shorten every `description` string inside a parameters schema.
function shortenSchemaDescriptions(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) shortenSchemaDescriptions(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "description" && typeof value === "string") {
      record[key] = shortenParamDescription(value);
    } else if (value && typeof value === "object") {
      shortenSchemaDescriptions(value);
    }
  }
}

// A tool entry across the three supported provider shapes exposes a name, a
// holder object carrying `description`, and (optionally) a parameters schema.
interface ToolView {
  name: string;
  descriptionHolder: Record<string, unknown>;
  parameters?: unknown;
}

// Resolve a single serialized tool object to a common view, or null when the
// shape is unrecognized (fail open: leave it untouched).
function viewTool(tool: unknown): ToolView | null {
  if (!tool || typeof tool !== "object") return null;
  const record = tool as Record<string, unknown>;

  // OpenAI Chat Completions / Mistral: { type:"function", function:{ name, description, parameters } }
  if (record.function && typeof record.function === "object") {
    const fn = record.function as Record<string, unknown>;
    if (typeof fn.name === "string") {
      return { name: fn.name, descriptionHolder: fn, parameters: fn.parameters };
    }
  }

  // Bedrock Converse: { toolSpec:{ name, description, inputSchema:{ json } } }
  if (record.toolSpec && typeof record.toolSpec === "object") {
    const spec = record.toolSpec as Record<string, unknown>;
    if (typeof spec.name === "string") {
      const inputSchema = spec.inputSchema as Record<string, unknown> | undefined;
      return { name: spec.name, descriptionHolder: spec, parameters: inputSchema?.json };
    }
  }

  // OpenAI Responses / Anthropic / Google: { name, description, parameters|input_schema }
  if (typeof record.name === "string") {
    return {
      name: record.name,
      descriptionHolder: record,
      parameters: record.parameters ?? record.input_schema,
    };
  }

  return null;
}

// Trim a single tool view in place when it is a known ctx_* tool.
function trimToolView(view: ToolView): boolean {
  const concise = CTX_DESCRIPTIONS[view.name];
  if (!concise) return false;
  if (typeof view.descriptionHolder.description === "string") {
    view.descriptionHolder.description = concise;
  }
  if (view.parameters && typeof view.parameters === "object") {
    shortenSchemaDescriptions(view.parameters);
  }
  return true;
}

// Locate the tool arrays inside a provider payload across supported shapes.
function toolArrays(payload: Record<string, unknown>): unknown[][] {
  const arrays: unknown[][] = [];
  if (Array.isArray(payload.tools)) arrays.push(payload.tools);
  const toolConfig = payload.toolConfig as Record<string, unknown> | undefined;
  if (toolConfig && Array.isArray(toolConfig.tools)) arrays.push(toolConfig.tools);
  return arrays;
}

// Return a trimmed copy of a provider payload, or the original when nothing
// matched. Never mutates the input.
export function trimPayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const clone = structuredClone(payload) as Record<string, unknown>;
  const arrays = toolArrays(clone);
  if (arrays.length === 0) return payload;
  let changed = false;
  for (const tools of arrays) {
    for (const tool of tools) {
      const view = viewTool(tool);
      if (view && trimToolView(view)) changed = true;
    }
  }
  return changed ? (clone as T) : payload;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const trimmed = trimPayload(event.payload);
    if (trimmed !== event.payload) return trimmed;
  });
}
