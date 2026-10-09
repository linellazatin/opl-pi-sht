import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import piExtension, { CTX_DESCRIPTIONS, shortenParamDescription, trimPayload } from "../extensions/opl-ctxtrim/index";

const LONG = "Run code in a sandboxed subprocess. Think-in-Code: bytes never enter context.\n\nWHEN:\n  - lots\n  - of\n  - prose";

// Verbose the way a real context-mode schema is: the concise replacement must be
// shorter than this, or the extension would be adding tokens instead of saving them.
const VERBOSE = `${LONG}\n${"Additional documentation prose that shipped schemas carry, sentence after sentence. ".repeat(18)}`;

function responsesTool(name: string, description = LONG) {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript", "python"], description: "Runtime language. Extra sentence that should be dropped." },
        timeout: { type: "number", minimum: 1, description: "Max ms.\nSecond line dropped." },
      },
      required: ["language"],
    },
  };
}

test("trims an OpenAI Responses ctx_* tool and preserves validation keywords", () => {
  const payload = { model: "m", tools: [responsesTool("ctx_execute")] };
  const out = trimPayload(payload) as typeof payload;
  const tool = out.tools[0] as any;
  assert.equal(tool.description, CTX_DESCRIPTIONS.ctx_execute);
  assert.equal(tool.strict, true);
  assert.deepEqual(tool.parameters.properties.language.enum, ["javascript", "python"]);
  assert.equal(tool.parameters.properties.timeout.minimum, 1);
  assert.deepEqual(tool.parameters.required, ["language"]);
  assert.equal(tool.parameters.properties.language.description, "Runtime language.");
  assert.equal(tool.parameters.properties.timeout.description, "Max ms.");
});

test("trims an OpenAI Chat Completions ctx_* tool", () => {
  const payload = { tools: [{ type: "function", function: { name: "ctx_search", description: LONG, parameters: { type: "object", properties: {} } } }] };
  const out = trimPayload(payload) as typeof payload;
  assert.equal((out.tools[0] as any).function.description, CTX_DESCRIPTIONS.ctx_search);
});

function geminiTool(name: string, parametersKey = "parametersJsonSchema", description = LONG) {
  return {
    name,
    description, LONG,
    [parametersKey]: {
      type: "object",
      properties: {
        queries: { type: "array", description: "Queries to run. This long explanation should be dropped." },
      },
      required: ["queries"],
    },
  };
}

test("trims a Gemini functionDeclarations ctx_* tool", () => {
  const payload = { model: "gemini", tools: [{ functionDeclarations: [geminiTool("ctx_search"), geminiTool("read")] }] };
  const out = trimPayload(payload) as typeof payload;
  const decls = (out.tools[0] as any).functionDeclarations;
  assert.equal(decls[0].description, CTX_DESCRIPTIONS.ctx_search);
  assert.equal(decls[0].parametersJsonSchema.properties.queries.description, "Queries to run.");
  assert.equal(decls[0].parametersJsonSchema.required[0], "queries", "validation keywords survive");
  assert.equal(decls[1].description, LONG, "a non-ctx declaration in the same array is untouched");
});

test("trims a Google tool carrying OpenAPI `parameters` (Cloud Code Assist shape)", () => {
  const payload = { tools: [{ functionDeclarations: [geminiTool("ctx_stats", "parameters")] }] };
  const out = trimPayload(payload) as typeof payload;
  const decl = (out.tools[0] as any).functionDeclarations[0];
  assert.equal(decl.description, CTX_DESCRIPTIONS.ctx_stats);
  assert.equal(decl.parameters.properties.queries.description, "Queries to run.");
});

test("trims a tool_config (snake_case) payload and leaves functionCallingConfig alone", () => {
  const payload = {
    tools: [{ functionDeclarations: [geminiTool("ctx_index")] }],
    tool_config: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["ctx_index"] } },
  };
  const out = trimPayload(payload) as typeof payload;
  assert.equal((out.tools[0] as any).functionDeclarations[0].description, CTX_DESCRIPTIONS.ctx_index);
  assert.deepEqual((out as any).tool_config.functionCallingConfig, {
    mode: "ANY",
    allowedFunctionNames: ["ctx_index"],
  });
});

test("a Gemini payload is not mutated", () => {
  const payload = { tools: [{ functionDeclarations: [geminiTool("ctx_purge")] }] };
  const before = JSON.stringify(payload);
  trimPayload(payload);
  assert.equal(JSON.stringify(payload), before);
});

test("trims a Bedrock Converse ctx_* tool under toolConfig", () => {
  const payload = { toolConfig: { tools: [{ toolSpec: { name: "ctx_purge", description: LONG, inputSchema: { json: { type: "object", properties: { confirm: { type: "boolean", description: "MUST be true. Rest dropped." } } } } } }] } };
  const out = trimPayload(payload) as typeof payload;
  const spec = (out.toolConfig.tools[0] as any).toolSpec;
  assert.equal(spec.description, CTX_DESCRIPTIONS.ctx_purge);
  assert.match(spec.description, /confirm:true/);
  assert.match(spec.description, /scope/);
  assert.equal(spec.inputSchema.json.properties.confirm.description, "MUST be true.");
});

test("leaves non-ctx tools byte-for-byte identical", () => {
  const other = { type: "function", name: "read", description: LONG, parameters: { type: "object", properties: { path: { description: "A path. Keep this whole sentence intact here." } } } };
  const payload = { tools: [other] };
  const out = trimPayload(payload);
  assert.equal(JSON.stringify(out.tools[0]), JSON.stringify(other));
});

test("leaves unknown future ctx_* tools untouched (fail safe)", () => {
  const future = { name: "ctx_teleport", description: LONG, parameters: { type: "object", properties: {} } };
  const payload = { tools: [future] };
  const out = trimPayload(payload);
  assert.equal((out.tools[0] as any).description, LONG);
  assert.equal(out, payload, "no known tool matched, original returned");
});

test("returns the original payload unchanged for unknown formats", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(trimPayload(payload), payload);
  assert.equal(trimPayload(null), null);
  assert.equal(trimPayload("string"), "string");
});

test("does not mutate the input payload", () => {
  const payload = { tools: [responsesTool("ctx_execute")] };
  const snapshot = JSON.stringify(payload);
  trimPayload(payload);
  assert.equal(JSON.stringify(payload), snapshot);
});

test("shortenParamDescription keeps the first sentence only", () => {
  assert.equal(shortenParamDescription("First. Second."), "First.");
  assert.equal(shortenParamDescription("One line only"), "One line only");
  assert.equal(shortenParamDescription("Line one\nLine two"), "Line one");
});

test("registers exactly one before_provider_request handler that trims", () => {
  const handlers: Record<string, Function[]> = {};
  const pi = { on: (event: string, fn: Function) => { (handlers[event] ??= []).push(fn); } } as any;
  piExtension(pi);
  assert.equal(Object.keys(handlers).length, 1);
  assert.equal(handlers.before_provider_request.length, 1);

  const payload = { tools: [responsesTool("ctx_index")] };
  const result = handlers.before_provider_request[0]({ payload });
  assert.equal((result.tools[0] as any).description, CTX_DESCRIPTIONS.ctx_index);

  // Unknown format returns undefined (keeps payload unchanged for later handlers).
  assert.equal(handlers.before_provider_request[0]({ payload: { messages: [] } }), undefined);
});

// Integration measurement: run against the installed context-mode MCP server if
// present. Reports real byte reduction and an approximate token-savings range.
// Skips cleanly when context-mode is not installed on this machine.
function findServerBundle(): string | null {
  const candidates = [
    join(homedir(), ".pi/agent/npm/node_modules/context-mode/server.bundle.mjs"),
    join(homedir(), ".pi/npm/node_modules/context-mode/server.bundle.mjs"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function listInstalledTools(bundle: string): Promise<any[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PI_CONFIG_DIR: join(homedir(), ".pi") } });
    const pending = new Map<number, (v: any) => void>();
    let buffer = "";
    let id = 0;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("timeout")); }, 20000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { const msg = JSON.parse(line); const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg.result); } } catch {}
      }
    });
    const request = (method: string, params: unknown = {}) => new Promise<any>((res) => { const n = ++id; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    (async () => {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: { tools: {} }, clientInfo: { name: "opl-ctxtrim-measure", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      const result = await request("tools/list", {});
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(Array.isArray(result?.tools) ? result.tools : []);
    })().catch((e) => { clearTimeout(timer); child.kill("SIGTERM"); reject(e); });
  });
}

test("measures ctx_* schema byte reduction against the installed context-mode", async () => {
  const bundle = findServerBundle();
  if (!bundle) { console.log("[opl-ctxtrim] context-mode not installed; measurement skipped"); return; }

  const tools = await listInstalledTools(bundle);
  const ctxTools = tools.filter((t) => typeof t?.name === "string" && t.name.startsWith("ctx_"));
  assert.ok(ctxTools.length > 0, "expected ctx_* tools from installed context-mode");

  // Flag tools the trimmer does not yet cover so upgrades are reviewed.
  const uncovered = ctxTools.filter((t) => !CTX_DESCRIPTIONS[t.name]).map((t) => t.name);
  if (uncovered.length > 0) console.log(`[opl-ctxtrim] uncovered ctx_* tools (review after upgrade): ${uncovered.join(", ")}`);

  // Build a representative OpenAI Responses payload from the real definitions.
  const payload = { model: "measure", tools: ctxTools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } })) };
  const before = Buffer.byteLength(JSON.stringify(payload.tools), "utf8");
  const after = Buffer.byteLength(JSON.stringify((trimPayload(payload) as typeof payload).tools), "utf8");
  const saved = before - after;
  const pct = ((saved / before) * 100).toFixed(1);
  const tokensHi = Math.round(saved / 3);
  const tokensLo = Math.round(saved / 4);

  // The README's ceiling row: every description emptied, schemas retained.
  const emptied = JSON.parse(JSON.stringify(payload.tools)) as any[];
  const stripDescriptions = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(stripDescriptions); return; }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.description === "string") rec.description = "";
      Object.values(rec).forEach(stripDescriptions);
    }
  };
  stripDescriptions(emptied);
  const ceiling = Buffer.byteLength(JSON.stringify(emptied), "utf8");
  const ceilingPct = (((before - ceiling) / before) * 100).toFixed(1);

  console.log(`[opl-ctxtrim] ctx_* tools=${ctxTools.length} covered=${ctxTools.length - uncovered.length}`);
  console.log(`[opl-ctxtrim] serialized bytes: before=${before} after=${after} saved=${saved} (${pct}%)`);
  console.log(`[opl-ctxtrim] empty-description ceiling=${ceiling} saved=${before - ceiling} (${ceilingPct}%)`);
  console.log(`[opl-ctxtrim] approx tokens saved per request: ${tokensLo}-${tokensHi} (3-4 bytes/token)`);

  assert.ok(saved > 0, "expected a positive byte reduction");
  assert.ok(ceiling < after, "emptying every description should beat the shipped trimming");
}, 30000);

test("asserts a byte saving on a full ctx_* payload in both the OpenAI and Google shapes", () => {
  const names = Object.keys(CTX_DESCRIPTIONS);
  assert.ok(names.length >= 11, "the registry should still cover every shipped ctx_* tool");
  const cases: Record<string, unknown> = {
    "openai responses": { tools: names.map((n) => responsesTool(n, VERBOSE)) },
    "google declarations": {
      tools: [{ functionDeclarations: names.map((n) => geminiTool(n, "parametersJsonSchema", VERBOSE)) }],
    },
  };
  for (const [label, payload] of Object.entries(cases)) {
    const before = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const after = Buffer.byteLength(JSON.stringify(trimPayload(payload)), "utf8");
    const saved = before - after;
    const pct = ((saved / before) * 100).toFixed(1);
    console.log(`[opl-ctxtrim] ${label}: before=${before} after=${after} saved=${saved} (${pct}%)`);
    assert.ok(saved / before > 0.4, `${label}: only ${pct}% saved, expected the trimmer to remove over 40%`);
  }
});
