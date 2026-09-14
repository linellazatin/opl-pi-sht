import type { AgentStatus, RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

export function deriveAgentStatus(agentActive: boolean, activeToolCount: number): AgentStatus {
  if (!agentActive) return "ready";
  return activeToolCount > 0 ? "waiting" : "working";
}

export function createAgentStatusTracker() {
  let agentActive = false;
  const activeToolIds = new Set<string>();

  return {
    agentStarted() { agentActive = true; },
    agentSettled() {
      agentActive = false;
      activeToolIds.clear();
    },
    toolStarted(id: string) { activeToolIds.add(id); },
    toolEnded(id: string) { activeToolIds.delete(id); },
    status() { return deriveAgentStatus(agentActive, activeToolIds.size); },
  };
}

const STATUS_DISPLAY = {
  working: ["Working", "accent"],
  waiting: ["Waiting", "warning"],
  ready: ["Ready", "success"],
} as const;

export const statusSegment = {
  id: "status" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const [label, color] = STATUS_DISPLAY[ctx.agentStatus];
    return { content: applyColor(ctx.theme, color, label), visible: true };
  },
};
