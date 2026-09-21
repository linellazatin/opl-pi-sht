import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

export interface IncidentContext {
  sessionId: string;
  cwd: string;
}

export interface GuardianIncident {
  timestamp: string;
  kind: "malformed_tool_call";
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  responseId?: string;
  action: "dropped";
  removedToolCalls: ToolCall[];
}

export interface GuardResult {
  message: AssistantMessage;
  removedToolCalls: ToolCall[];
}

function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isMalformedToolCall(block: unknown): block is ToolCall {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") {
    return false;
  }
  const toolCall = block as ToolCall;
  return !hasValue(toolCall.id) || !hasValue(toolCall.name);
}

export function guardAssistantMessage(message: AssistantMessage): GuardResult | undefined {
  const removedToolCalls = message.content.filter(isMalformedToolCall);
  if (removedToolCalls.length === 0) return undefined;

  const content = message.content.filter((block) => !isMalformedToolCall(block));
  const hasValidToolCall = content.some((block) => block.type === "toolCall");

  return {
    removedToolCalls,
    message: {
      ...message,
      content,
      stopReason: hasValidToolCall ? "toolUse" : "stop",
    },
  };
}

export function buildIncidentRecord(
  message: AssistantMessage,
  context: IncidentContext,
  removedToolCalls: ToolCall[],
): GuardianIncident {
  return {
    timestamp: new Date(message.timestamp).toISOString(),
    kind: "malformed_tool_call",
    sessionId: context.sessionId,
    cwd: context.cwd,
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    action: "dropped",
    removedToolCalls,
  };
}
