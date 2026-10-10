import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

export interface IncidentContext {
  sessionId: string;
  cwd: string;
}

export interface RemovedToolCallSummary {
  name: string;
  argumentKeys: string[];
  /** Size of the arguments that were dropped; the values themselves are never recorded. */
  argumentsBytes: number;
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
  removedToolCalls: RemovedToolCallSummary[];
}

export interface GuardResult {
  message: AssistantMessage;
  removedToolCalls: ToolCall[];
}

function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isToolCallBlock(block: unknown): block is ToolCall {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall";
}

/** A toolCall block whose id or name is missing: pi cannot route it, and leaving it in the
 *  message fails the whole turn, so the guardian drops it. */
export function isMalformedToolCall(block: unknown): boolean {
  return isToolCallBlock(block) && (!hasValue(block.id) || !hasValue(block.name));
}

// The same test as a type predicate, so `filter` can type the removed blocks as ToolCall[]
// without narrowing ToolCall out of the kept content array.
function isMalformedToolCallBlock(block: unknown): block is ToolCall {
  return isMalformedToolCall(block);
}

export function guardAssistantMessage(message: AssistantMessage): GuardResult | undefined {
  const removedToolCalls = message.content.filter(isMalformedToolCallBlock);
  if (removedToolCalls.length === 0) return undefined;

  const content = message.content.filter((block) => !isMalformedToolCall(block));
  const hasValidToolCall = content.some(isToolCallBlock);

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
  // A missing/zero/NaN timestamp yields an invalid Date whose toISOString() throws,
  // which would silently lose the forensic record. Fall back to the current time.
  const timestamp =
    Number.isFinite(message.timestamp) && message.timestamp > 0 ? message.timestamp : Date.now();
  return {
    timestamp: new Date(timestamp).toISOString(),
    kind: "malformed_tool_call",
    sessionId: context.sessionId,
    cwd: context.cwd,
    provider: message.provider,
    model: message.model,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    action: "dropped",
    removedToolCalls: removedToolCalls.map(summarizeRemovedToolCall),
  };
}

/**
 * Incident records are kept for diagnostics, not as a copy of the transcript: argument
 * *names* say which call went wrong, while the values can carry file contents, commands or
 * credentials straight out of the session.
 */
export function summarizeRemovedToolCall(call: ToolCall): RemovedToolCallSummary {
  const args = (call as { arguments?: unknown }).arguments;
  const keys = args && typeof args === "object" ? Object.keys(args as Record<string, unknown>).sort() : [];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(args ?? {}));
  } catch {
    bytes = -1; // not serializable; the size is unknown but nothing is leaked either
  }
  return { name: hasValue(call.name) ? call.name : "(unnamed)", argumentKeys: keys, argumentsBytes: bytes };
}
