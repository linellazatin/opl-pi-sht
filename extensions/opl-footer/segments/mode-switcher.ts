import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";
import { color } from "./helpers.js";

interface AgentModeState {
  mode: string;
  widgetColor?: string;
}

function readAgentModeState(): AgentModeState | undefined {
  return (globalThis as Record<string, unknown>).__agentMode as AgentModeState | undefined;
}

export const modeSwitcherSegment = {
  id: "mode_switcher" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const state = readAgentModeState();
    const mode = state?.mode ?? "off";

    const label = applyColor(ctx.theme, "dim", "Mode:");
    const value = mode === "off" ? "Normal" : mode.charAt(0).toUpperCase() + mode.slice(1);
    const valueStr = state?.widgetColor ? applyColor(ctx.theme, state.widgetColor, value) : color(ctx, "modeIndicator", value);
    return { content: `${label} ${valueStr}`, visible: true };
  },
};