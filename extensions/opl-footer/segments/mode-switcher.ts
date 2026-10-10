import type { ColorValue, RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

interface AgentModeState {
  mode: string;
  appearance?: { modeColor?: string };
}

/**
 * Written by `opl-modes`, which may not be installed, and may be written by anything else
 * that claims the name. Only a `{ mode: string }` is honoured; anything else renders nothing
 * rather than throwing inside the footer's render loop.
 */
function readAgentModeState(): AgentModeState | undefined {
  const state = (globalThis as Record<string, unknown>).__agentMode as unknown;
  if (!state || typeof state !== "object") return undefined;
  const { mode, appearance } = state as { mode?: unknown; appearance?: unknown };
  if (typeof mode !== "string" || !mode) return undefined;
  const modeColor =
    appearance && typeof appearance === "object"
      ? (appearance as { modeColor?: unknown }).modeColor
      : undefined;
  return { mode, ...(typeof modeColor === "string" ? { appearance: { modeColor } } : {}) };
}

export const modeSwitcherSegment = {
  id: "mode_switcher" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const state = readAgentModeState();
    const mode = state?.mode ?? "off";

    const label = applyColor(ctx.theme, "dim", "Mode:");
    const value = mode === "off" ? "Normal" : mode.charAt(0).toUpperCase() + mode.slice(1);
    // modeColor is authored in opl-modes config (theme token or hex); applyColor() renders an
    // unknown value uncolored, so the cross-extension string is passed through as-is.
    const valueStr = applyColor(ctx.theme, (state?.appearance?.modeColor ?? "muted") as ColorValue, value);
    return { content: `${label} ${valueStr}`, visible: true };
  },
};