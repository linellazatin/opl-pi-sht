import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export const openRouterUsageSegment = {
  id: "openrouter_usage" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const snapshot = ctx.openRouterUsage;
    if (!snapshot) return { content: "", visible: false };

    const percent = (snapshot.used / snapshot.limit) * 100;
    const stale = snapshot.stale ? applyColor(ctx.theme, "dim", " (stale)") : "";
    return {
      content: `${formatUsd(snapshot.used)} / ${formatUsd(snapshot.limit)} (${percent.toFixed(1)}%)${stale}`,
      visible: true,
    };
  },
};
