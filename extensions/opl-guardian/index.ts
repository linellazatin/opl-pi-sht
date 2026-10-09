import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type SessionBeforeForkEvent,
  type SessionBeforeSwitchEvent,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_LOGGING,
  incidentLogPath,
  loadGuardianConfig,
  type GuardianConfig,
  type GuardianLogging,
} from "./config.js";
import {
  buildIncidentRecord,
  guardAssistantMessage,
  type GuardianIncident,
} from "./guardian.js";
import { getProtectedPathBlock, hasPendingUserWork } from "./policies.js";

const RED = "\u001b[31m";
const RESET_FOREGROUND = "\u001b[39m";

function red(text: string): string {
  return `${RED}${text}${RESET_FOREGROUND}`;
}

/**
 * Append one forensic record. The path never depends on the session cwd, so opening an
 * untrusted repository cannot leave an untracked log full of provider payloads inside it.
 * Once an append would pass `logging.maxBytes` the current file moves to `<file>.1`: one
 * generation of history is kept, anything older is dropped.
 */
export async function appendIncident(
  incident: GuardianIncident,
  logging: GuardianLogging = DEFAULT_LOGGING,
): Promise<void> {
  const path = incidentLogPath(logging);
  if (path === null) return;

  const line = `${JSON.stringify(incident)}\n`;
  await mkdir(dirname(path), { recursive: true });

  let existed = true;
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    existed = false;
  }
  if (existed && size + Buffer.byteLength(line) > logging.maxBytes) {
    await rename(path, `${path}.1`).catch(() => {});
    existed = false;
  }

  await appendFile(path, line, "utf8");
  if (!existed && process.platform !== "win32") {
    await chmod(path, 0o600).catch(() => {});
  }
}

function diagnostic(removed: number, incidentFile: string | null, logError?: unknown): string {
  if (incidentFile === null) {
    return `[opl-guardian] Dropped ${removed} malformed provider tool call(s); incident logging is off (logging.incidentFile: false).`;
  }
  if (logError) {
    const detail = logError instanceof Error ? logError.message : String(logError);
    return `[opl-guardian] Dropped malformed provider tool call(s), but could not write ${incidentFile}: ${detail}.`;
  }
  return `[opl-guardian] Dropped ${removed} malformed provider tool call(s). Details: ${incidentFile}.`;
}

function appendDiagnostic(message: AssistantMessage, text: string, invalidOnly: boolean): AssistantMessage {
  // For a mixed response (valid tool calls remain), prepend the notice rather than
  // appending a trailing text block after toolCall blocks: providers such as Anthropic
  // require each tool_use to be followed by a tool_result, so a trailing text block does
  // not round-trip through the wire format. Text-before-tool-calls is the standard
  // assistant shape. convertToLlm passes assistant messages through as-is.
  const content = invalidOnly
    ? [{ type: "text" as const, text: `${text} No tool was executed; send another prompt to continue.` }]
    : [{ type: "text" as const, text }, ...message.content];
  return { ...message, content, stopReason: invalidOnly ? "stop" : "toolUse" };
}

export async function guardMessageEnd(
  message: AssistantMessage,
  context: { cwd: string; sessionId: string; logging?: GuardianLogging },
): Promise<{ message: AssistantMessage; diagnostic: string } | undefined> {
  const guarded = guardAssistantMessage(message);
  if (!guarded) return undefined;

  let logError: unknown;
  try {
    await appendIncident(buildIncidentRecord(message, context, guarded.removedToolCalls), context.logging ?? DEFAULT_LOGGING);
  } catch (error) {
    logError = error;
  }

  const invalidOnly = !guarded.message.content.some((block) => block.type === "toolCall");
  const notice = diagnostic(guarded.removedToolCalls.length, incidentLogPath(context.logging ?? DEFAULT_LOGGING), logError);
  return {
    message: appendDiagnostic(guarded.message, notice, invalidOnly),
    diagnostic: notice,
  };
}

export function createToolCallHandler(config: GuardianConfig) {
  return async (event: ToolCallEvent, ctx: ExtensionContext) => {
    // Defense in depth: createMessageEndHandler already drops malformed tool calls
    // (blank id or name) before they reach execution, but block any that still get
    // here anyway (e.g. a replay path or a provider that streamed them directly).
    // Optional chaining tolerates a *missing* id/name, not just a blank string.
    if (!event.toolCallId?.trim() || !event.toolName?.trim()) {
      return { block: true, reason: "[opl-guardian] Blocked a malformed tool call with a blank id or name." };
    }

    let toolPath: string | undefined;
    if (isToolCallEventType("read", event)) toolPath = event.input.path;
    else if (isToolCallEventType("write", event)) toolPath = event.input.path;
    else if (isToolCallEventType("edit", event)) toolPath = event.input.path;
    else if (isToolCallEventType("bash", event)) toolPath = event.input.command;

    if (toolPath !== undefined) {
      const blocked = getProtectedPathBlock(event.toolName, toolPath, config.protectedPaths.paths, ctx.cwd);
      if (blocked) {
        const reason = blocked.unresolved
          ? `[opl-guardian] Cannot safely resolve path "${blocked.path}"; ${blocked.operation} denied by protected-path policy.`
          : `[opl-guardian] Path "${blocked.path}" is protected (${blocked.operation} denied).`;
        if (ctx.hasUI) ctx.ui.notify(red(reason), "warning");
        return { block: true, reason };
      }
    }

    if (!isToolCallEventType("bash", event) ||
      !config.permissionGate.patterns.some((pattern) => pattern.test(event.input.command))) return undefined;

    if (!ctx.hasUI) {
      if (!config.permissionGate.blockWithoutUI) return undefined;
      return { block: true, reason: "[opl-guardian] Command blocked because it matches a dangerous pattern and no confirmation UI is available." };
    }

    const command = event.input.command;
    const preview = command.replace(/\s+/g, " ").trim();
    // Fail closed: order "No" first so an accidental confirmation (or a replayed
    // input event hitting a freshly-focused dialog) denies instead of approves.
    // Only an explicit "Yes" selection approves the command.
    const options = ["No", "Yes"];
    if (ctx.mode === "rpc") {
      try {
        const choice = await ctx.ui.select(red(`Dangerous command:\n\n${preview.slice(0, 256)}\n\nAllow?`), options);
        if (choice === "Yes") return undefined;
      } catch {
        // A failed RPC dialog is not approval.
      }
      return { block: true, reason: "[opl-guardian] Command blocked; confirmation was declined or unavailable." };
    }

    const choice = await ctx.ui.select(red(`Dangerous command:\n\n${preview.slice(0, 256)}\n\nAllow?`), options);
    if (choice === "Yes") return undefined;
    const reason = "[opl-guardian] Command blocked by user because it matches a dangerous pattern.";
    ctx.ui.notify(red(reason), "warning");
    return { block: true, reason };
  };
}

export function createMessageEndHandler(config: GuardianConfig) {
  return async (
    event: MessageEndEvent,
    ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">,
  ) => {
    if (!config.dropMalformedToolCalls || event.message.role !== "assistant") return undefined;
    const guarded = await guardMessageEnd(event.message, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      logging: config.logging,
    });
    if (!guarded) return undefined;
    ctx.ui?.notify(red(guarded.diagnostic), "warning");
    return { message: guarded.message };
  };
}

export function createSessionBeforeSwitchHandler(config: GuardianConfig) {
  return async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    let title: string;
    let message: string;
    if (event.reason === "new") {
      if (!config.confirmDestructive.clearSession) return undefined;
      title = "Clear session?";
      message = "This will delete all messages in the current session.";
    } else {
      if (!config.confirmDestructive.switchWithUnsavedWork ||
        !hasPendingUserWork(ctx.sessionManager.getBranch())) return undefined;
      title = "Switch session?";
      message = "You have unanswered work in the current session. Switch anyway?";
    }

    if (!ctx.hasUI) return config.confirmDestructive.blockWithoutUI ? { cancel: true } : undefined;
    return await ctx.ui.confirm(red(title), red(message)) ? undefined : { cancel: true };
  };
}

export function createSessionBeforeForkHandler(config: GuardianConfig) {
  return async (event: SessionBeforeForkEvent, ctx: ExtensionContext) => {
    if (!config.confirmDestructive.forkSession) return undefined;
    if (!ctx.hasUI) return config.confirmDestructive.blockWithoutUI ? { cancel: true } : undefined;
    const confirmed = await ctx.ui.confirm(
      red(`Fork from entry ${event.entryId.slice(0, 8)}?`),
      red("Create a new session branch from this point?"),
    );
    return confirmed ? undefined : { cancel: true };
  };
}

export default function (pi: ExtensionAPI) {
  const { config, warnings } = loadGuardianConfig();
  pi.on("session_start", async (_event, ctx) => {
    if (warnings.length && ctx.hasUI) {
      ctx.ui.notify(red(`[opl-guardian] Configuration warning(s):\n${warnings.join("\n")}`), "warning");
    }
  });

  pi.on("tool_call", createToolCallHandler(config));
  pi.on("session_before_switch", createSessionBeforeSwitchHandler(config));
  pi.on("session_before_fork", createSessionBeforeForkHandler(config));
  pi.on("message_end", createMessageEndHandler(config));
}
