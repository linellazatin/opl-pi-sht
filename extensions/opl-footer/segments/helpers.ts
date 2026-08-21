import type { SegmentContext } from "../types.js";
import { fg } from "../theme.js";

export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(2)}k`;
  if (n < 1000000) return `${(n / 1000).toFixed(2)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(2)}M`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

export function color(ctx: SegmentContext, semantic: string, text: string): string {
  return fg(ctx.theme, semantic as any, text, ctx.colors);
}
