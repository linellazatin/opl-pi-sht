import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadUserConfig } from "./config.js";
import { runAction, closeBrowser, type BrowserParams } from "./browser.js";

// ponytail: in-memory store with 1h TTL. Large outputs (snapshot, console,
// network, evaluate) are kept out of context; only a preview + id are returned.
interface Stored { id: string; action: string; timestamp: number; text: string }
const STORE = new Map<string, Stored>();
const TTL_MS = 60 * 60 * 1000;

function store(action: string, text: string): string {
  const id = `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  for (const [k, v] of STORE) if (now - v.timestamp > TTL_MS) STORE.delete(k);
  STORE.set(id, { id, action, timestamp: now, text });
  return id;
}

const ACTIONS =
  "navigate|snapshot|screenshot|click|fill|hover|press|select|evaluate|console|network|wait_for|pages|new_page|select_page|close_page|resize|get|close";

export default function (pi: ExtensionAPI) {
  const cfg = loadUserConfig();

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      `Drive a real Chromium browser (Playwright) for web testing and inspection. One dispatcher tool; pick action: ${ACTIONS}. ` +
      "navigate(url|back|forward|reload); snapshot (accessibility tree); screenshot (saved to file, not inlined); " +
      "click/fill/hover/select by CSS selector; press(key); evaluate(script in page); console/network (captured for active page); " +
      "wait_for(selector|text); pages/new_page/select_page/close_page; resize(width,height); get(responseId) to retrieve a stored large result; close to shut the browser. " +
      "Large outputs return a preview + responseId; call action:get with that id for the full text.",
    parameters: Type.Object({
      action: Type.String({ description: `One of: ${ACTIONS}` }),
      url: Type.Optional(Type.String({ description: "navigate/new_page: URL, or back|forward|reload for navigate" })),
      selector: Type.Optional(Type.String({ description: "CSS selector for click/fill/hover/select/wait_for" })),
      text: Type.Optional(Type.String({ description: "fill: text to type; wait_for: text to await" })),
      key: Type.Optional(Type.String({ description: "press: key or combo, e.g. Enter, Control+A" })),
      values: Type.Optional(Type.Array(Type.String(), { description: "select: option values" })),
      script: Type.Optional(Type.String({ description: "evaluate: JS expression run in the page" })),
      path: Type.Optional(Type.String({ description: "screenshot: output file path" })),
      fullPage: Type.Optional(Type.Boolean({ description: "screenshot: capture full scrollable page" })),
      index: Type.Optional(Type.Number({ description: "select_page/close_page: page index" })),
      timeoutMs: Type.Optional(Type.Number({ description: "wait_for: timeout in ms" })),
      width: Type.Optional(Type.Number({ description: "resize: viewport width" })),
      height: Type.Optional(Type.Number({ description: "resize: viewport height" })),
      responseId: Type.Optional(Type.String({ description: "get: id from a previous large result" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as BrowserParams & { responseId?: string };

      if (p.action === "get") {
        if (!p.responseId) return err("get requires responseId");
        const hit = STORE.get(p.responseId);
        if (!hit) return err(`No stored result for ${p.responseId} (expires after 1h or on browser close).`);
        return { content: [{ type: "text", text: hit.text }], details: { responseId: hit.id, action: hit.action } };
      }

      let result;
      try {
        result = await runAction(p, cfg);
      } catch (e) {
        return err(`browser ${p.action}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Small outputs return inline; large outputs are stored and previewed.
      if (result.text.length <= cfg.previewChars) {
        return { content: [{ type: "text", text: result.text }], details: result.file ? { file: result.file } : {} };
      }
      const id = store(p.action, result.text);
      const preview = result.text.slice(0, cfg.previewChars);
      return {
        content: [{ type: "text", text: `${preview}\n\n… truncated. Full result via action:get responseId: ${id}` }],
        details: { responseId: id, action: p.action, chars: result.text.length },
      };
    },
  });
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true, details: {} as Record<string, unknown> };
}
