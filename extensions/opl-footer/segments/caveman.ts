import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";
import { color } from "./helpers.js";

interface CavemanState {
  enabled: boolean;
  mode: string;
}

/**
 * Nothing in this collection writes `__caveman` - a standalone extension does - so the shape
 * is validated instead of cast: `mode.toUpperCase()` is a crash on a number, and a footer
 * that throws takes every row down with it.
 */
function readCavemanState(): CavemanState | undefined {
  const state = (globalThis as Record<string, unknown>).__caveman as unknown;
  if (!state || typeof state !== "object") return undefined;
  const { enabled, mode } = state as { enabled?: unknown; mode?: unknown };
  return typeof enabled === "boolean" && typeof mode === "string" ? { enabled, mode } : undefined;
}

export const cavemanSegment = {
  id: "caveman" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const state = readCavemanState();
    if (!state) return { content: "", visible: false };

    const label = applyColor(ctx.theme, "dim", "Caveman mode:");
    const value = state.enabled ? state.mode.toUpperCase() : "OFF";

    return { content: `${label} ${color(ctx, "modeIndicator", value)}`, visible: true };
  },
};
