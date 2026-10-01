import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
}

function formatReset(resetAt: number | undefined, nowMs: number): string {
  if (resetAt === undefined) return "";
  const resetMs = resetAt > 10_000_000_000 ? resetAt : resetAt * 1000;
  const remainingMinutes = Math.max(0, Math.floor((resetMs - nowMs) / 60_000));
  if (remainingMinutes === 0) return "now";

  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  if (days > 0) return `${days}d${hours}h`;

  const minutes = remainingMinutes % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export const codexUsageSegment = {
  id: "codex_usage" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const snapshot = ctx.codexUsage;
    if (!snapshot) return { content: "", visible: false };

    const nowMs = ctx.now ?? Date.now();
    const parts: string[] = [];
    if (snapshot.fiveHour) {
      const reset = formatReset(snapshot.fiveHour.resetAt, nowMs);
      parts.push(`5h ${formatPercent(100 - snapshot.fiveHour.usedPercent)}% ${reset ? `↻${reset}` : ""}`);
    }
    if (snapshot.weekly) {
      const reset = formatReset(snapshot.weekly.resetAt, nowMs);
      parts.push(`W ${formatPercent(100 - snapshot.weekly.usedPercent)}% ${reset ? `↻${reset}` : ""}`);
    }
    if (parts.length === 0) return { content: "", visible: false };

    const stale = snapshot.stale ? applyColor(ctx.theme, "dim", " (stale)") : "";
    return { content: parts.join(applyColor(ctx.theme, "dim", " · ")) + stale, visible: true };
  },
};
