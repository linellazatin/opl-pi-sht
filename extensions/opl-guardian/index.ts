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
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadGuardianConfig, type GuardianConfig } from "./config.js";
import {
  buildIncidentRecord,
  guardAssistantMessage,
  type GuardianIncident,
} from "./guardian.js";
import { getProtectedPathBlock, hasPendingUserWork } from "./policies.js";

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

export function createToolCallHandler(config: GuardianConfig) {
  return async (event: ToolCallEvent, ctx: ExtensionContext) => {
    // Defense in depth: createMessageEndHandler already drops malformed tool calls
    // (blank id or name) before they reach execution, but block any that still get
    // here anyway (e.g. a replay path or a provider that streamed them directly).
    if (event.toolCallId.trim() === "" || event.toolName.trim() === "") {
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
        if (ctx.hasUI) ctx.ui.notify(reason, "warning");
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
    if (ctx.mode === "rpc") {
      const preview = command.replace(/\s+/g, " ").trim();
      try {
        const choice = await ctx.ui.select(`Dangerous command: ${preview.slice(0, 256)}\nAllow?`, ["Yes", "No"]);
        if (choice === "Yes") return undefined;
      } catch {
        // A failed RPC dialog is not approval.
      }
      return { block: true, reason: "[opl-guardian] Command blocked; confirmation was declined or unavailable." };
    }

    const items: SelectItem[] = [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ];
    const choice = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const border = new DynamicBorder((text: string) => theme.fg("border", text));
      const label = new Text(theme.fg("text", "Dangerous command detected:"), 1, 0);
      const preview = command.replace(/\s+/g, " ").trim();
      const commandText = new Text(theme.fg("error", preview.length > 256 ? `${preview.slice(0, 256)}…` : preview), 1, 0);
      const question = new Text(theme.fg("text", "Allow this command?"), 1, 0);
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);

      const container = new Container();
      container.addChild(border);
      container.addChild(new Spacer());
      container.addChild(label);
      container.addChild(commandText);
      container.addChild(new Spacer());
      container.addChild(question);
      container.addChild(selectList);
      container.addChild(new Spacer());
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));
      container.addChild(border);

      return {
        render(width: number) { return container.render(width); },
        invalidate() { container.invalidate(); },
        handleInput(data: string) {
          if (keybindings.matches(data, "app.tools.expand")) {
            ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (choice === "yes") return undefined;
    const reason = "[opl-guardian] Command blocked by user because it matches a dangerous pattern.";
    ctx.ui.notify(reason, "warning");
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
    });
    if (!guarded) return undefined;
    ctx.ui?.notify(guarded.diagnostic, "warning");
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
    return await ctx.ui.confirm(title, message) ? undefined : { cancel: true };
  };
}

export function createSessionBeforeForkHandler(config: GuardianConfig) {
  return async (event: SessionBeforeForkEvent, ctx: ExtensionContext) => {
    if (!config.confirmDestructive.forkSession) return undefined;
    if (!ctx.hasUI) return config.confirmDestructive.blockWithoutUI ? { cancel: true } : undefined;
    const confirmed = await ctx.ui.confirm(
      `Fork from entry ${event.entryId.slice(0, 8)}?`,
      "Create a new session branch from this point?",
    );
    return confirmed ? undefined : { cancel: true };
  };
}

export default function (pi: ExtensionAPI) {
  const { config, warnings } = loadGuardianConfig();
  pi.on("session_start", async (_event, ctx) => {
    if (warnings.length && ctx.hasUI) {
      ctx.ui.notify(`[opl-guardian] Configuration warning(s):\n${warnings.join("\n")}`, "warning");
    }
  });

  pi.on("tool_call", createToolCallHandler(config));
  pi.on("session_before_switch", createSessionBeforeSwitchHandler(config));
  pi.on("session_before_fork", createSessionBeforeForkHandler(config));
  pi.on("message_end", createMessageEndHandler(config));
}
