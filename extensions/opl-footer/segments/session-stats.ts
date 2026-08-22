import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.js";

function dim(ctx: SegmentContext, s: string): string {
  return applyColor(ctx.theme, "dim", s);
}

function val(ctx: SegmentContext, s: string): string {
  return applyColor(ctx.theme, "text", s);
}

export function formatMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export const sessionStatsSegment = {
  id: "session_stats" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const { turns, steps, modelRequests, modelToolCalls } = ctx.sessionStats;
    if (turns === 0) return { content: "", visible: false };

    const parts: string[] = [
      val(ctx, `${turns}`) + dim(ctx, " turns"),
      val(ctx, `${steps}`) + dim(ctx, " steps"),
    ];

    // Add model stats if available
    if (modelRequests > 0) {
      parts.push(val(ctx, `${modelRequests}`) + dim(ctx, " mreq"));
    }
    if (modelToolCalls > 0) {
      parts.push(val(ctx, `${modelToolCalls}`) + dim(ctx, " mtool"));
    }

    return { content: parts.join(dim(ctx, " · ")), visible: true };
  },
};

export const perfStatsSegment = {
  id: "perf_stats" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const { turns, llmMs, toolMs, ttftSamples, lastTurnaroundMs } = ctx.sessionStats;
    if (turns === 0) return { content: "", visible: false };

    const { input, output, cacheRead } = ctx.usageStats;

    const parts: string[] = []

    // LLM (last-turn TAT) · Tool time
    const tat = lastTurnaroundMs > 0
      ? dim(ctx, " (") + val(ctx, formatMs(lastTurnaroundMs)) + dim(ctx, ")")
      : "";
    parts.push(
      dim(ctx, "LLM ") + val(ctx, formatMs(llmMs)) + tat +
      dim(ctx, " · Tool ") + val(ctx, formatMs(toolMs)),
    );

    // TTFT avg · tok/s
    const ttftAvg = ttftSamples.length > 0
      ? ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length
      : 0;
    const tokPerSec = llmMs > 0 ? Math.round(output / (llmMs / 1000)) : 0;
    if (ttftAvg > 0 || tokPerSec > 0) {
      parts.push(
        dim(ctx, "TTFT ") + val(ctx, `${(ttftAvg / 1000).toFixed(1)}s`) +
        dim(ctx, " · ") + val(ctx, `${tokPerSec}`) + dim(ctx, " tok/s"),
      );
    }

    // Cache hit %
    const total = input + cacheRead;
    if (total > 0 && cacheRead > 0) {
      const pct = Math.round((cacheRead / total) * 100);
      parts.push(dim(ctx, "Cache ") + val(ctx, `${pct}%`));
    }

    return { content: parts.join(dim(ctx, " | ")), visible: true };
  },
};
