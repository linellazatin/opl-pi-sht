import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  buildIncidentRecord,
  guardAssistantMessage,
  type GuardianIncident,
} from "./guardian.js";

const LOG_PATH = join("err", "guardian.jsonl");

export async function appendIncident(cwd: string, incident: GuardianIncident): Promise<void> {
  const directory = join(cwd, "err");
  const path = join(cwd, LOG_PATH);
  await mkdir(directory, { recursive: true });

  let existed = true;
  try {
    await stat(path);
  } catch {
    existed = false;
  }

  await appendFile(path, `${JSON.stringify(incident)}\n`, "utf8");
  if (!existed && process.platform !== "win32") {
    await chmod(path, 0o600).catch(() => {});
  }
}

function diagnostic(removed: number, logError?: unknown): string {
  if (logError) {
    const detail = logError instanceof Error ? logError.message : String(logError);
    return `[opl-guardian] Dropped malformed provider tool call(s), but could not write err/guardian.jsonl: ${detail}.`;
  }
  return `[opl-guardian] Dropped ${removed} malformed provider tool call(s). Details: err/guardian.jsonl.`;
}

function appendDiagnostic(message: AssistantMessage, text: string, invalidOnly: boolean): AssistantMessage {
  const content = invalidOnly
    ? [{ type: "text" as const, text: `${text} No tool was executed; send another prompt to continue.` }]
    : [...message.content, { type: "text" as const, text }];
  return { ...message, content, stopReason: invalidOnly ? "stop" : "toolUse" };
}

export async function guardMessageEnd(
  message: AssistantMessage,
  context: { cwd: string; sessionId: string },
): Promise<{ message: AssistantMessage; diagnostic: string } | undefined> {
  const guarded = guardAssistantMessage(message);
  if (!guarded) return undefined;

  let logError: unknown;
  try {
    await appendIncident(context.cwd, buildIncidentRecord(message, context, guarded.removedToolCalls));
  } catch (error) {
    logError = error;
  }

  const invalidOnly = !guarded.message.content.some((block) => block.type === "toolCall");
  const notice = diagnostic(guarded.removedToolCalls.length, logError);
  return {
    message: appendDiagnostic(guarded.message, notice, invalidOnly),
    diagnostic: notice,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const guarded = await guardMessageEnd(event.message, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (!guarded) return;

    ctx.ui?.notify(guarded.diagnostic, "warning");
    return { message: guarded.message };
  });
}
