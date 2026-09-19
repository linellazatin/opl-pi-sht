import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";
import { color } from "./helpers.js";

export const costSegment = {
  id: "cost" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const { cost } = ctx.usageStats;

    if (cost === 0 && !ctx.isLocalModel) {
      return {
        content: color(ctx, "cost", "$0.0000") + applyColor(ctx.theme, "dim", " (no pricing)"),
        visible: true,
      };
    }

    const content = color(ctx, "cost", `$${cost.toFixed(4)}`);

    if (ctx.isLocalModel) {
      return { content: content + applyColor(ctx.theme, "dim", " (local model)"), visible: true };
    }

    return { content, visible: true };
  },
};
