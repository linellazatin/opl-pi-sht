import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildToolResultMessages, type ChatFn, type ChatMessage } from "./util/config";
import { mergeRequestMetrics, metricsFromChat } from "./metrics";
import type { RequestMetrics } from "./types";

export interface ResearchSource { title: string; url: string; snippet: string; }

export async function searchConfiguredResearch(query: string, config: { researchSearchProvider?: "ddgs" | "searxng"; researchSearchUrl?: string; researchMaxResults?: number }): Promise<ResearchSource[]> {
  const base = config.researchSearchUrl?.replace(/\/$/, "");
  if (!base) throw new Error("researchSearchUrl is not configured in opl-simplebench.json");
  const limit = config.researchMaxResults ?? 5;
  const provider = config.researchSearchProvider ?? "ddgs";
  const params = provider === "ddgs"
    ? new URLSearchParams({ query, max_results: String(limit) })
    : new URLSearchParams({ q: query, format: "json", categories: "general", safesearch: "0" });
  const endpoint = provider === "ddgs" ? `${base}/search/text?${params}` : `${base}/search?${params}`;
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`${provider} search returned ${response.status}`);
  const data = await response.json() as any;
  const results = Array.isArray(data.results) ? data.results : [];
  return results.slice(0, limit).map((item: any) => ({ title: String(item.title ?? ""), url: String(item.href ?? item.url ?? ""), snippet: String(item.body ?? item.content ?? "") })).filter((item: ResearchSource) => item.url);
}
export interface ResearchArtifactResult {
  id: "research-artifact";
  passed: boolean;
  score: "STRONG" | "MODERATE" | "WEAK" | "FAIL" | "ERROR";
  error: string | null;
  toolCalls: string[];
  files: Record<string, string>;
  metrics: RequestMetrics;
}

const MINIMALIST_UI_SKILL = "Use semantic HTML, a restrained palette, readable typography, no gradients, and no heavy shadows.";
export const RESEARCH_TASK_PROMPT = `Research benefits of urban trees with the provided tools.

You MUST:
1. Call web_search for real sources before writing.
2. Call read_skill and apply its minimalist UI guidance to page.html.
3. Write research.md with a concise synthesis and a ## Sources section containing Markdown links to returned source URLs.
4. Write page.html as a minimal, responsive editorial page: semantic HTML with <main>, a viewport meta tag, restrained colors, readable type, no gradients, and no heavy shadows.
Do not answer only in chat: create both files.`;
const RESEARCH_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web for sources.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_skill", description: "Read the benchmark-local minimalist UI design guidance.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "write_file", description: "Write research.md or page.html in the task directory.", parameters: { type: "object", properties: { path: { type: "string", enum: ["research.md", "page.html"] }, content: { type: "string" } }, required: ["path", "content"] } } },
];

function parseArgs(value: unknown): Record<string, unknown> {
  try { return typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>) ?? {}; }
  catch { return {}; }
}

function verify(files: Record<string, string>, tools: string[], sources: ResearchSource[]): { score: ResearchArtifactResult["score"]; passed: boolean; error: string | null } {
  const markdown = files["research.md"] ?? "";
  const html = files["page.html"] ?? "";
  const searched = tools.includes("web_search");
  const skillRead = tools.includes("read_skill");
  const citesSource = /##\s+Sources/i.test(markdown) && sources.some(source => markdown.includes(source.url));
  const htmlPasses = /<html[\s>]/i.test(html) && /<main[\s>]/i.test(html) && /name=["']viewport["']/i.test(html) && !/(linear-gradient|radial-gradient|box-shadow)/i.test(html);
  const complete = searched && skillRead && !!markdown && !!html && citesSource && htmlPasses;
  if (complete) return { score: "STRONG", passed: true, error: null };
  if (searched && (!!markdown || !!html)) return { score: "MODERATE", passed: false, error: "missing required research, skill, citation, or minimalist HTML evidence" };
  return { score: "FAIL", passed: false, error: "research artifact task incomplete" };
}

export async function runResearchArtifactTask(chatFn: ChatFn, model: string, options: { search: (query: string) => Promise<ResearchSource[]>; maxTurns?: number; onProgress?: (message: string) => void } ): Promise<ResearchArtifactResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simplebench-research-"));
  const tools: string[] = [];
  const requestMetrics: RequestMetrics[] = [];
  let sources: ResearchSource[] = [];
  let error: string | null = null;
  const messages: ChatMessage[] = [
    { role: "system", content: "Complete a research artifact task using benchmark-local tools. Follow every requirement in the user task." },
    { role: "user", content: RESEARCH_TASK_PROMPT },
  ];
  try {
    for (let turn = 0; turn < (options.maxTurns ?? 8); turn += 1) {
      options.onProgress?.(`research-artifact: agent turn ${turn + 1}/${options.maxTurns ?? 8}...`);
      const response = await chatFn(model, messages, { tools: RESEARCH_TOOLS });
      requestMetrics.push(metricsFromChat(response));
      const calls = response.toolCalls ?? [];
      if (!calls.length) break;
      const results: string[] = [];
      for (const call of calls) {
        const fn = call.function ?? call;
        const name = fn.name;
        const args = parseArgs(fn.arguments);
        tools.push(name);
        options.onProgress?.(`research-artifact: ${name}`);
        try {
          if (name === "web_search") {
            sources = await options.search(String(args.query ?? ""));
            results.push(JSON.stringify(sources));
          } else if (name === "read_skill") {
            results.push(MINIMALIST_UI_SKILL);
          } else if (name === "write_file") {
            const relative = String(args.path ?? "");
            if (relative !== "research.md" && relative !== "page.html") throw new Error("only research.md and page.html are allowed");
            fs.writeFileSync(path.join(root, relative), String(args.content ?? ""));
            results.push("written");
          } else throw new Error(`unknown tool: ${name}`);
        } catch (e: any) { results.push(JSON.stringify({ error: e?.message || String(e) })); }
      }
      messages.push(...buildToolResultMessages(response.content, calls, results));
    }
  } catch (e: any) { error = e?.message || String(e); }
  const files: Record<string, string> = {};
  for (const name of ["research.md", "page.html"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file, "utf8");
  }
  fs.rmSync(root, { recursive: true, force: true });
  const verified = error ? { score: "ERROR" as const, passed: false, error } : verify(files, tools, sources);
  return { id: "research-artifact", ...verified, toolCalls: tools, files, metrics: mergeRequestMetrics(requestMetrics) };
}
