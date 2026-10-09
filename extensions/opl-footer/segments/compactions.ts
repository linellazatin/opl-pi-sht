import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

export const compactionsSegment = {
  id: "compactions" as const,
  render(ctx: SegmentContext): RenderedSegment {
    if (ctx.compactions === 0) return { content: "", visible: false };
    return {
      content: `${ctx.icons.compress} ${applyColor(ctx.theme, "text", `${ctx.compactions}`)}`,
      visible: true,
    };
  },
};
