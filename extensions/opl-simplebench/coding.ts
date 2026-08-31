import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildToolResultMessages, type ChatFn, type ChatMessage } from "./util/config";
import { mergeRequestMetrics, metricsFromChat } from "./metrics";
import type { RequestMetrics } from "./types";

export interface CodingTaskFixture {
  id: string;
  prompt: string;
  files: Record<string, string>;
  allowedFiles: string[];
  verify: (root: string, hidden: boolean) => string;
  /** Inline single-shot variant: full code in prompt, no tools, one turn. */
  inlinePrompt?: string;
}

export interface CodingTaskResult {
  id: string;
  passed: boolean;
  publicPassed: boolean;
  hiddenPassed: boolean;
  verifiedAfterEdit: boolean;
  unrelatedFiles: string[];
  toolCalls: number;
  turns: number;
  wallTimeMs: number;
  outputTokens: number | null;
  error: string | null;
  metrics: RequestMetrics;
  /** STRONG = solved in 1 turn; MODERATE = 2–3 turns; WEAK = 4–5 turns; FAIL = not solved. */
  efficiency: "STRONG" | "MODERATE" | "WEAK" | "FAIL";
}

const assertCode = (root: string, moduleName: string, expression: string) => `import * as m from ${JSON.stringify(path.join(root, moduleName))};\nif (!(await (${expression}))) throw new Error('verification failed');`;

export const CODING_LITE_TASKS: CodingTaskFixture[] = [
  {
    id: "fix-off-by-one",
    prompt: "Fix the inclusive range bug in src/sum.mjs. Keep the exported API. Run the available tests after editing.",
    files: { "src/sum.mjs": "export function sumInclusive(start, end) { let total = 0; for (let value = start; value < end; value += 1) total += value; return total; }\n" },
    allowedFiles: ["src/sum.mjs"],
    verify: (root, hidden) => hidden ? assertCode(root, "src/sum.mjs", "m.sumInclusive(1, 4) === 10 && m.sumInclusive(5, 5) === 5") : assertCode(root, "src/sum.mjs", "m.sumInclusive(1, 4) === 10"),
    inlinePrompt: "Fix the inclusive range bug below. sumInclusive(1, 4) must return 10; sumInclusive(5, 5) must return 5.\n\nFile: src/sum.mjs\n```js\nexport function sumInclusive(start, end) { let total = 0; for (let value = start; value < end; value += 1) total += value; return total; }\n```\n\nReply with ONLY the corrected file content.",
  },
  {
    id: "validate-config",
    prompt: "Implement strict config parsing in src/config.mjs. Accept a valid numeric port, default the host to localhost, and reject ports outside 1..65535. Run the available tests after editing.",
    files: { "src/config.mjs": "export function parseConfig(input = {}) { return { host: input.host || 'localhost', port: Number(input.port || 3000) }; }\n" },
    allowedFiles: ["src/config.mjs"],
    verify: (root, hidden) => hidden ? assertCode(root, "src/config.mjs", "(() => { try { m.parseConfig({ port: 0 }); return false; } catch {} return m.parseConfig({ port: 65535 }).port === 65535; })()") : assertCode(root, "src/config.mjs", "m.parseConfig({ port: 8080 }).port === 8080 && m.parseConfig({}).host === 'localhost'"),
    inlinePrompt: "Implement strict config parsing: accept a valid numeric port (1–65535), default host to 'localhost', throw on out-of-range ports.\n\nFile: src/config.mjs\n```js\nexport function parseConfig(input = {}) { return { host: input.host || 'localhost', port: Number(input.port || 3000) }; }\n```\n\nReply with ONLY the corrected file content.",
  },
  {
    id: "diagnose-cross-file",
    prompt: "Find and fix the cross-file normalization regression. Usernames should be trimmed before lookup. Keep the public API and run tests after editing.",
    files: { "src/lookup.mjs": "import { normalizeUser } from './normalize.mjs';\nexport function findUser(users, name) { return users.find(user => user.name === normalizeUser(name)); }\n", "src/normalize.mjs": "export function normalizeUser(value) { return String(value).toLowerCase(); }\n" },
    allowedFiles: ["src/normalize.mjs"],
    verify: (root, hidden) => hidden ? assertCode(root, "src/lookup.mjs", "m.findUser([{ name: 'alice' }], '  ALICE  ')?.name === 'alice'") : assertCode(root, "src/lookup.mjs", "m.findUser([{ name: 'alice' }], 'ALICE')?.name === 'alice'"),
    inlinePrompt: "Usernames must be trimmed before lookup. Fix src/normalize.mjs only — do not change src/lookup.mjs.\n\nFile: src/lookup.mjs (read-only)\n```js\nimport { normalizeUser } from './normalize.mjs';\nexport function findUser(users, name) { return users.find(user => user.name === normalizeUser(name)); }\n```\n\nFile: src/normalize.mjs\n```js\nexport function normalizeUser(value) { return String(value).toLowerCase(); }\n```\n\nReply with ONLY the corrected src/normalize.mjs content.",
  },
  {
    id: "safe-refactor",
    prompt: "Make the formatter behavior correct for empty values while preserving the existing output. You may refactor src/format.mjs, but do not change the exported function name. Run tests after editing.",
    files: { "src/format.mjs": "export function formatLabels(values) { return values.map(value => String(value).trim().toUpperCase()).join(', '); }\n" },
    allowedFiles: ["src/format.mjs"],
    verify: (root, hidden) => hidden ? assertCode(root, "src/format.mjs", "m.formatLabels([' a ', '', 'b']) === 'A, B'") : assertCode(root, "src/format.mjs", "m.formatLabels([' a ', '', 'b']) === 'A, B' && m.formatLabels([' a ', 'b']) === 'A, B'"),
    inlinePrompt: "Make formatLabels skip empty values after trimming. Keep the exported name and all other output unchanged.\n\nFile: src/format.mjs\n```js\nexport function formatLabels(values) { return values.map(value => String(value).trim().toUpperCase()).join(', '); }\n```\n\nReply with ONLY the corrected file content.",
  },
  {
    id: "cli-flag",
    prompt: "Add a --upper flag to src/cli.mjs. Without it, print the supplied name unchanged; with it, print uppercase text. Preserve the current usage error and run tests after editing.",
    files: { "src/cli.mjs": "const args = process.argv.slice(2);\nif (args.length === 0) { console.error('usage: cli <name>'); process.exit(2); }\nconsole.log(args[0]);\n" },
    allowedFiles: ["src/cli.mjs"],
    verify: (root, hidden) => hidden ? `const { spawnSync } = await import('node:child_process'); const r1 = spawnSync(process.execPath, ['src/cli.mjs', '--upper', 'alice'], { cwd: ${JSON.stringify(root)}, encoding: 'utf8' }); const r2 = spawnSync(process.execPath, ['src/cli.mjs', 'alice'], { cwd: ${JSON.stringify(root)}, encoding: 'utf8' }); if (r1.status !== 0 || r1.stdout.trim() !== 'ALICE') throw new Error('verification failed'); if (r2.status !== 0 || r2.stdout.trim() !== 'alice') throw new Error('verification failed');` : `const { spawnSync } = await import('node:child_process'); const r = spawnSync(process.execPath, ['src/cli.mjs', '--upper', 'alice'], { cwd: ${JSON.stringify(root)}, encoding: 'utf8' }); if (r.status !== 0 || r.stdout.trim() !== 'ALICE') throw new Error('verification failed');`,
    inlinePrompt: "Add a --upper flag. Without it, print the name unchanged; with it, print uppercase. Preserve the usage error on empty args.\n\nFile: src/cli.mjs\n```js\nconst args = process.argv.slice(2);\nif (args.length === 0) { console.error('usage: cli <name>'); process.exit(2); }\nconsole.log(args[0]);\n```\n\nReply with ONLY the corrected file content.",
  },
  {
    id: "verify-after-edit",
    prompt: "Fix retryOnce in src/retry.mjs so it retries once after a failure and returns the successful value. Use the test tool after your edit to verify the fix.",
    files: { "src/retry.mjs": "export async function retryOnce(operation) { return await operation(); }\n" },
    allowedFiles: ["src/retry.mjs"],
    verify: (root, hidden) => hidden ? assertCode(root, "src/retry.mjs", "(async () => { let attempts = 0; const value = await m.retryOnce(async () => { attempts += 1; if (attempts === 1) throw new Error('retry'); return 42; }); return value === 42 && attempts === 2; })()") : assertCode(root, "src/retry.mjs", "(async () => (await m.retryOnce(async () => 42)) === 42)()"),
    inlinePrompt: "Fix retryOnce so it retries once after a failure and returns the successful value.\n\nFile: src/retry.mjs\n```js\nexport async function retryOnce(operation) { return await operation(); }\n```\n\nReply with ONLY the corrected file content.",
  },
];

export function resolveCodingPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("absolute paths are outside the coding task");
  const taskRoot = path.resolve(root);
  const target = path.resolve(taskRoot, relativePath);
  if (target !== taskRoot && !target.startsWith(`${taskRoot}${path.sep}`)) throw new Error("path is outside the coding task");
  return target;
}

export function createCodingTaskDir(task: CodingTaskFixture): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `simplebench-${task.id}-`));
  for (const [relativePath, content] of Object.entries(task.files)) {
    const target = resolveCodingPath(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

export function runCodingVerifier(task: CodingTaskFixture, root: string, mode: "public" | "hidden") {
  const result = spawnSync(process.execPath, ["--eval", task.verify(root, mode === "hidden")], { cwd: root, encoding: "utf8", timeout: 10_000 });
  return { passed: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function safeJson(value: unknown): { value: any; error?: string } {
  try { return { value: typeof value === "string" ? JSON.parse(value) : value ?? {} }; }
  catch { return { value: {}, error: "invalid JSON arguments" }; }
}

const CODING_TOOLS = [
  { type: "function", function: { name: "list_files", description: "List files in the task repository", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "search_files", description: "Search text files in the task repository", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_file", description: "Read a task repository file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write a task repository file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_tests", description: "Run the public tests for this task", parameters: { type: "object", properties: {} } } },
];

function codingToolError(message: string, requestedPath?: string): string {
  return JSON.stringify({ error: message, ...(requestedPath ? { path: requestedPath } : {}) });
}

function executeCodingTool(root: string, task: CodingTaskFixture, name: string, args: any): string {
  if (name === "list_files") {
    const base = resolveCodingPath(root, args.path || ".");
    if (!fs.existsSync(base)) return codingToolError("path not found", args.path || ".");
    if (!fs.statSync(base).isDirectory()) return codingToolError("path is not a directory", args.path || ".");
    const files: string[] = [];
    const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const target = path.join(dir, entry.name); if (entry.isDirectory()) visit(target); else files.push(path.relative(root, target)); } };
    visit(base);
    return JSON.stringify(files);
  }
  if (name === "search_files") {
    const base = resolveCodingPath(root, args.path || ".");
    if (!fs.existsSync(base)) return codingToolError("path not found", args.path || ".");
    if (!fs.statSync(base).isDirectory()) return codingToolError("path is not a directory", args.path || ".");
    const hits: string[] = [];
    const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const target = path.join(dir, entry.name); if (entry.isDirectory()) visit(target); else if (fs.readFileSync(target, "utf8").includes(String(args.query))) hits.push(path.relative(root, target)); } };
    visit(base);
    return JSON.stringify(hits);
  }
  if (name === "read_file") {
    const target = resolveCodingPath(root, args.path);
    if (!fs.existsSync(target)) return codingToolError("file not found", args.path);
    if (!fs.statSync(target).isFile()) return codingToolError("path is not a file", args.path);
    return fs.readFileSync(target, "utf8");
  }
  if (name === "write_file") { const target = resolveCodingPath(root, args.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, String(args.content)); return "written"; }
  if (name === "run_tests") return JSON.stringify(runCodingVerifier(task, root, "public"));
  throw new Error(`unknown coding tool: ${name}`);
}

async function runSingleShotCodingTask(chatFn: ChatFn, model: string, task: CodingTaskFixture): Promise<CodingTaskResult> {
  const root = createCodingTaskDir(task);
  const started = Date.now();
  try {
    const response = await chatFn(model, [
      { role: "system", content: "You are fixing a coding bug. Reply with ONLY the corrected file content — no explanation, no markdown fences." },
      { role: "user", content: task.inlinePrompt! },
    ]);
    const raw = response.content.trim();
    const fenced = raw.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
    const code = fenced ? fenced[1].trim() : raw;
    const target = resolveCodingPath(root, task.allowedFiles[0]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code + "\n");
    const publicResult = runCodingVerifier(task, root, "public");
    const hiddenResult = runCodingVerifier(task, root, "hidden");
    const passed = hiddenResult.passed;
    return {
      id: task.id, passed,
      publicPassed: publicResult.passed, hiddenPassed: hiddenResult.passed,
      verifiedAfterEdit: true, unrelatedFiles: [], toolCalls: 0, turns: 1,
      wallTimeMs: Date.now() - started, outputTokens: null,
      error: passed ? null : hiddenResult.output || "single-shot verification failed",
      metrics: metricsFromChat(response),
      efficiency: passed ? "STRONG" : "FAIL",
    };
  } catch (e: any) {
    return {
      id: task.id, passed: false,
      publicPassed: false, hiddenPassed: false,
      verifiedAfterEdit: false, unrelatedFiles: [], toolCalls: 0, turns: 1,
      wallTimeMs: Date.now() - started, outputTokens: null,
      error: e?.message || String(e),
      metrics: mergeRequestMetrics([]),
      efficiency: "FAIL",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runCodingTask(chatFn: ChatFn, model: string, task: CodingTaskFixture, options: { maxTurns?: number; singleShot?: boolean; onProgress?: (message: string) => void } = {}): Promise<CodingTaskResult> {
  if (options.singleShot && task.inlinePrompt) return runSingleShotCodingTask(chatFn, model, task);
  const root = createCodingTaskDir(task);
  const started = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let verifiedAfterEdit = false;
  let error: string | null = null;
  const requestMetrics: RequestMetrics[] = [];
  const messages: ChatMessage[] = [{ role: "system", content: "You are completing a coding task in a disposable repository. Use the available tools. Do not assume a change worked until you run_tests after editing." }, { role: "user", content: task.prompt }];
  try {
    try {
      while (turns < (options.maxTurns ?? 5)) {
      turns += 1;
      options.onProgress?.(`${task.id}: agent turn ${turns}/${options.maxTurns ?? 5}...`);
      const response = await chatFn(model, messages, { tools: CODING_TOOLS });
      requestMetrics.push(metricsFromChat(response));
      const calls = response.toolCalls ?? [];
      if (!calls.length) break;
      const results: string[] = [];
      for (const call of calls) {
        const fn = call.function ?? call;
        const name = fn.name;
        const parsed = safeJson(fn.arguments);
        const args = parsed.value;
        toolCalls += 1;
        if (name === "write_file") verifiedAfterEdit = false;
        let result: string;
        try { result = parsed.error ? codingToolError(parsed.error) : executeCodingTool(root, task, name, args); }
        catch (e: any) { result = codingToolError(e?.message || String(e)); }
        if (name === "run_tests") {
          try { verifiedAfterEdit = JSON.parse(result).passed === true; }
          catch { verifiedAfterEdit = false; }
        }
        results.push(`TOOL_RESULT ${name}: ${result}`);
        options.onProgress?.(`${task.id}: ${name} (${toolCalls})`);
      }
        messages.push(...buildToolResultMessages(response.content, calls, results));
      }
    } catch (e: any) { error = e?.message || String(e); }
    const publicResult = runCodingVerifier(task, root, "public");
    const hiddenResult = runCodingVerifier(task, root, "hidden");
    const changed = listChangedFiles(root, task.files);
    const unrelatedFiles = changed.filter(file => !task.allowedFiles.includes(file));
    const metrics = mergeRequestMetrics(requestMetrics);
    const passed = hiddenResult.passed && unrelatedFiles.length === 0 && verifiedAfterEdit;
    const efficiency: CodingTaskResult["efficiency"] =
      !passed      ? "FAIL"
      : turns <= 2 ? "STRONG"
      : turns <= 4 ? "MODERATE"
      :              "WEAK";
    return { id: task.id, passed, publicPassed: publicResult.passed, hiddenPassed: hiddenResult.passed, verifiedAfterEdit, unrelatedFiles, toolCalls, turns, wallTimeMs: Date.now() - started, outputTokens: metrics.outputTokens, error: error ?? (!hiddenResult.passed ? hiddenResult.output || "hidden verification failed" : null), metrics, efficiency };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function listChangedFiles(root: string, initialFiles: Record<string, string>): string[] {
  const changed: string[] = [];
  const current: string[] = [];
  const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const target = path.join(dir, entry.name); if (entry.isDirectory()) visit(target); else current.push(path.relative(root, target)); } };
  visit(root);
  for (const relativePath of current) {
    const target = resolveCodingPath(root, relativePath);
    if (!(relativePath in initialFiles) || fs.readFileSync(target, "utf8") !== initialFiles[relativePath]) changed.push(relativePath);
  }
  for (const relativePath of Object.keys(initialFiles)) if (!fs.existsSync(resolveCodingPath(root, relativePath))) changed.push(relativePath);
  return changed;
}

export { CODING_TOOLS };
