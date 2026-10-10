import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";
import { color } from "./helpers.js";

interface PlanModeState {
  mode: string;
}

/**
 * Written by `opl-modes`, which may not be installed. Only a `{ mode: string }` is honoured;
 * anything else reads as "no state", so the segment stays invisible instead of throwing.
 */
function readPlanModeState(): PlanModeState | undefined {
  const state = (globalThis as Record<string, unknown>).__planMode as unknown;
  if (!state || typeof state !== "object") return undefined;
  const mode = (state as { mode?: unknown }).mode;
  return typeof mode === "string" ? { mode } : undefined;
}

export const planModeSegment = {
  id: "plan_mode" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const state = readPlanModeState();
    if (!state) return { content: "", visible: false };

    const label = applyColor(ctx.theme, "dim", "Plan mode:");
    const value = state.mode === "off" ? "OFF" : "ON";

    return { content: `${label} ${color(ctx, "modeIndicator", value)}`, visible: true };
  },
};