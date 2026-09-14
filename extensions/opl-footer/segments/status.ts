import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

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
