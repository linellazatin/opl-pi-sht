import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import type { SegmentContext, StatusLineSegmentId, UsageStats, SessionStats, SessionEvent, ThinkingLevelEvent, AssistantMessageEvent, ToolResultEvent, UserBashEvent } from "./types.js";
import { renderSegment } from "./segments/index.js";
import { estimateContextUsage } from "./segments/context.js";
import { createAgentStatusTracker } from "./segments/status.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { getEffectiveConfig } from "./config.js";
import { getIcons } from "./icons.js";
import { getDefaultColors, fg } from "./theme.js";
import { showFooterConfigurator } from "./configure.js";
import { fetchCodexUsage, refreshCodexUsageSnapshot, type CodexUsageSnapshot } from "./codex-usage.js";
import { fetchOpenRouterUsage, refreshOpenRouterUsageSnapshot, type OpenRouterUsageSnapshot } from "./openrouter-usage.js";

const GIT_BRANCH_PATTERNS: RegExp[] = [
  // init/clone included: creating a repo mid-session must clear the not-a-repo back-off.
  /\bgit\s+(init|clone|checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

/**
 * Only a real string is inspected. A tool call over the wire can carry an array or object
 * in `input.command`, and `String()` of it is either "[object Object]" (no match, stale
 * counts) or a joined "git checkout main" that matches by accident.
 */
export function mentionsGitBranchChange(command: unknown): boolean {
  return typeof command === "string" && GIT_BRANCH_PATTERNS.some((pattern) => pattern.test(command));
}

/** Row keys used to detect whether an optional segment is enabled. */
const CODEX_USAGE_REFRESH_MS = 30_000;

const LAYOUT_ROWS = [
  "row1LeftSegments",
  "row1RightSegments",
  "row2LeftSegments",
  "row2RightSegments",
  "row3LeftSegments",
  "row3RightSegments",
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

const isAssistantMessageEvent = (e: SessionEvent): e is AssistantMessageEvent =>
  e.type === "message" && (e as AssistantMessageEvent).message.role === "assistant";

const isThinkingEvent = (e: SessionEvent): e is ThinkingLevelEvent =>
  e.type === "thinking_level_change";

/**
 * Branch-derived footer inputs. Every field is a pass over the whole branch and the
 * footer re-renders on each keypress, so they are memoised by session, leaf, branch
 * length, context window and whether canonical usage needs an estimate.
 */
export interface BranchFacts {
  key: string;
  usageStats: UsageStats;
  thinkingLevelFromSession: string | null;
  estimatedContextUsage: { tokens: number; percent: number } | null;
  branchPrompts: number;
  branchCompactions: number;
  branchApiCalls: number;
  branchToolCalls: number;
}

function emptyBranchFacts(key: string): BranchFacts {
  return {
    key,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    thinkingLevelFromSession: null,
    estimatedContextUsage: null,
    branchPrompts: 0,
    branchCompactions: 0,
    branchApiCalls: 0,
    branchToolCalls: 0,
  };
}

export function deriveBranchFacts(
  branch: SessionEvent[],
  key: string,
  opts: {
    contextWindow: number;
    needsEstimate: boolean;
    projectedMessages: Parameters<typeof estimateContextUsage>[0] | undefined;
  },
): BranchFacts {
  const completedMessages = branch
    .filter(isAssistantMessageEvent)
    .map((e) => e.message as AssistantMessage)
    .filter((m) => m.stopReason !== "error" && m.stopReason !== "aborted");
  // Session entries are host data: a missing usage block reads as zero instead of
  // throwing and blanking every row.
  const usageStats = completedMessages.reduce<UsageStats>(
    (acc, m) => {
      const u = (m.usage ?? {}) as unknown as Partial<UsageStats> & { cost?: { total?: number } };
      return {
        input: acc.input + (u.input ?? 0),
        output: acc.output + (u.output ?? 0),
        cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
        cacheWrite: acc.cacheWrite + (u.cacheWrite ?? 0),
        cost: acc.cost + (u.cost?.total ?? 0),
      };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  const thinkingEvents = branch.filter(isThinkingEvent);
  return {
    key,
    usageStats,
    // Seed null, not "off": a truthy seed made the ?? fallback unreachable, so a branch
    // with no thinking_level_change entry rendered "off" instead of Pi's real level.
    thinkingLevelFromSession: thinkingEvents.length
      ? thinkingEvents.reduce((_, e) => e.thinkingLevel ?? "off", "off")
      : null,
    estimatedContextUsage:
      opts.needsEstimate && opts.contextWindow > 0 && opts.projectedMessages
        ? estimateContextUsage(opts.projectedMessages, opts.contextWindow)
        : null,
    // Prompt/API/tool counts are reconstructed from the branch so they survive quit/resume.
    // Timing stats (llmMs, toolMs, ttftSamples) are ephemeral — not stored in messages.
    branchPrompts: branch.filter(
      (e) => e.type === "message" && (e as AssistantMessageEvent).message?.role === "user",
    ).length,
    branchCompactions: branch.filter((entry) => entry.type === "compaction").length,
    branchApiCalls: completedMessages.length,
    branchToolCalls: completedMessages.reduce((sum, msg) => {
      const content = (msg as { content?: unknown }).content;
      return sum + (Array.isArray(content) ? content.filter((block) => (block as any)?.type === "toolCall").length : 0);
    }, 0),
  };
}

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  let rendered;
  try {
    rendered = renderSegment(segId, ctx);
  } catch {
    // One throwing segment used to blank the whole footer on every frame. Show a
    // marker in its place so the failure is visible and the rest still renders.
    return { content: "[?]", width: 3, visible: true };
  }
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/**
 * Build footer content from left and right segments.
 * Left segments are left-aligned, right segments are right-aligned.
 */
function buildFooterContent(
  ctx: SegmentContext,
  leftSegments: StatusLineSegmentId[],
  rightSegments: StatusLineSegmentId[],
  availableWidth: number,
): { text: string; visible: boolean } {
  const maxContentWidth = Math.max(0, availableWidth - 2);

  // Render left segments
  const leftParts: string[] = [];
  for (const segId of leftSegments) {
    const { content, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      leftParts.push(content);
    }
  }

  // Render right segments
  const rightParts: string[] = [];
  let rightWidth = 0;
  for (const segId of rightSegments) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      rightParts.push(content);
      rightWidth += width + 1; // +1 for space between
    }
  }
  if (rightParts.length > 0) {
    rightWidth -= 1; // Remove trailing space
  }

  let leftStr = leftParts.join(" ");
  let rightStr = rightParts.join(" ");

  // A row whose segments are all disabled is not padding: report it as invisible so
  // render() can drop the line and its divider instead of charging the terminal a
  // fixed six-line footer.
  if (leftParts.length === 0 && rightParts.length === 0) {
    return { text: "", visible: false };
  }

  // Handle case with no right segments
  if (rightParts.length === 0) {
    const finalLeft = truncateToWidth(leftStr, maxContentWidth);
    return {
      text: " " + finalLeft + " ".repeat(Math.max(0, maxContentWidth - visibleWidth(finalLeft))) + " ",
      visible: true,
    };
  }

  // If right side alone is too big, just show right side
  if (rightWidth >= maxContentWidth) {
    return { text: " " + truncateToWidth(rightStr, maxContentWidth) + " ", visible: true };
  }

  // Ensure at least 1 space between left and right
  const maxLeftWidth = maxContentWidth - rightWidth - 1;
  const finalLeft = truncateToWidth(leftStr, Math.max(0, maxLeftWidth));
  const finalLeftWidth = visibleWidth(finalLeft);

  const padding = maxContentWidth - finalLeftWidth - rightWidth;

  const result = " " + finalLeft + " ".repeat(padding) + rightStr + " ";
  return { text: truncateToWidth(result, availableWidth), visible: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function footer(pi: ExtensionAPI) {
  let sessionStartTime = Date.now();
  let currentCtx: ExtensionContext | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  // Every field below is a pass over the whole branch. The footer re-renders on each
  // keypress, so unchanged branch identities reuse the derived inputs instead.
  let branchFacts: BranchFacts | null = null;
  let tuiRef: TUI | null = null;
  let codexUsage: CodexUsageSnapshot | null = null;
  let codexUsageLastAttempt = 0;
  let codexUsageGeneration = 0;
  let codexUsageInFlight: Promise<void> | null = null;
  let codexUsageTimer: ReturnType<typeof setTimeout> | null = null;
  let codexUsagePendingCtx: ExtensionContext | null = null;

  const cancelCodexUsageRefresh = () => {
    if (codexUsageTimer !== null) clearTimeout(codexUsageTimer);
    codexUsageTimer = null;
    codexUsagePendingCtx = null;
  };
  let openRouterUsage: OpenRouterUsageSnapshot | null = null;
  let openRouterUsageLastAttempt = 0;
  let openRouterUsageGeneration = 0;
  let openRouterUsageInFlight: Promise<void> | null = null;
  let openRouterUsageTimer: ReturnType<typeof setTimeout> | null = null;
  let openRouterUsagePendingCtx: ExtensionContext | null = null;

  const cancelOpenRouterUsageRefresh = () => {
    if (openRouterUsageTimer !== null) clearTimeout(openRouterUsageTimer);
    openRouterUsageTimer = null;
    openRouterUsagePendingCtx = null;
  };

  const refreshOpenRouterUsage = (ctx: ExtensionContext, force = false): Promise<void> => {
    const isOpenRouter = ctx.model?.provider === "openrouter";
    if (!isOpenRouter) {
      cancelOpenRouterUsageRefresh();
      openRouterUsageGeneration++;
      openRouterUsageInFlight = null;
      openRouterUsage = null;
      tuiRef?.requestRender();
      return Promise.resolve();
    }

    const config = getEffectiveConfig();
    const enabled = LAYOUT_ROWS.some((row) => config[row]?.includes("openrouter_usage"));
    if (!enabled) {
      cancelOpenRouterUsageRefresh();
      openRouterUsageGeneration++;
      openRouterUsageInFlight = null;
      openRouterUsage = null;
      openRouterUsageLastAttempt = 0;
      tuiRef?.requestRender();
      return Promise.resolve();
    }
    if (openRouterUsageInFlight) {
      openRouterUsagePendingCtx = ctx;
      return openRouterUsageInFlight;
    }

    const now = Date.now();
    const remaining = CODEX_USAGE_REFRESH_MS - (now - openRouterUsageLastAttempt);
    if (!force && remaining > 0) {
      if (openRouterUsageTimer === null) {
        openRouterUsageTimer = setTimeout(() => {
          openRouterUsageTimer = null;
          void refreshOpenRouterUsage(ctx);
        }, remaining);
      }
      return Promise.resolve();
    }
    cancelOpenRouterUsageRefresh();
    openRouterUsageLastAttempt = now;
    const generation = ++openRouterUsageGeneration;

    let request: Promise<void>;
    request = refreshOpenRouterUsageSnapshot(openRouterUsage, () => fetchOpenRouterUsage(ctx))
      .then((snapshot) => {
        if (generation !== openRouterUsageGeneration) return;
        openRouterUsage = snapshot;
        tuiRef?.requestRender();
      })
      .finally(() => {
        if (openRouterUsageInFlight === request) openRouterUsageInFlight = null;
        if (generation !== openRouterUsageGeneration) return;
        const pendingCtx = openRouterUsagePendingCtx;
        openRouterUsagePendingCtx = null;
        if (pendingCtx) void refreshOpenRouterUsage(pendingCtx);
      });
    openRouterUsageInFlight = request;
    return request;
  };

  const refreshCodexUsage = (ctx: ExtensionContext, force = false): Promise<void> => {
    const model = ctx.model;
    const isCodexSubscription = model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(model);
    if (!isCodexSubscription) {
      cancelCodexUsageRefresh();
      codexUsageGeneration++;
      codexUsageInFlight = null;
      codexUsage = null;
      tuiRef?.requestRender();
      return Promise.resolve();
    }

    const config = getEffectiveConfig();
    const enabled = LAYOUT_ROWS.some((row) => config[row]?.includes("codex_usage"));
    if (!enabled) {
      cancelCodexUsageRefresh();
      codexUsageGeneration++;
      codexUsageInFlight = null;
      codexUsage = null;
      codexUsageLastAttempt = 0;
      tuiRef?.requestRender();
      return Promise.resolve();
    }
    if (codexUsageInFlight) {
      codexUsagePendingCtx = ctx;
      return codexUsageInFlight;
    }

    const now = Date.now();
    const remaining = CODEX_USAGE_REFRESH_MS - (now - codexUsageLastAttempt);
    if (!force && remaining > 0) {
      if (codexUsageTimer === null) {
        codexUsageTimer = setTimeout(() => {
          codexUsageTimer = null;
          void refreshCodexUsage(ctx);
        }, remaining);
      }
      return Promise.resolve();
    }
    cancelCodexUsageRefresh();
    codexUsageLastAttempt = now;
    const generation = ++codexUsageGeneration;

    let request: Promise<void>;
    request = refreshCodexUsageSnapshot(codexUsage, () => fetchCodexUsage(ctx))
      .then((snapshot) => {
        if (generation !== codexUsageGeneration) return;
        codexUsage = snapshot;
        tuiRef?.requestRender();
      })
      .finally(() => {
        if (codexUsageInFlight === request) codexUsageInFlight = null;
        if (generation !== codexUsageGeneration) return;
        const pendingCtx = codexUsagePendingCtx;
        codexUsagePendingCtx = null;
        if (pendingCtx) void refreshCodexUsage(pendingCtx);
      });
    codexUsageInFlight = request;
    return request;
  };

  // Session stats accumulators (timing only; counts are reconstructed from the branch)
  let llmMs = 0;
  let toolMs = 0;
  let ttftSamples: number[] = [];
  let turnStartMs = 0;
  let toolMsThisTurn = 0;
  let ttftRecordedThisTurn = false;
  let agentStartMs = 0;
  let lastTurnaroundMs = 0;
  let statusTracker = createAgentStatusTracker();
  const toolStartTimes = new Map<string, number>();

  pi.registerCommand("configure-opl", {
    description: "Interactively configure the OPL footer layout",
    handler: async (_args, ctx) => {
      await showFooterConfigurator(ctx, () => {
        tuiRef?.requestRender();
        void refreshCodexUsage(ctx, true);
        void refreshOpenRouterUsage(ctx, true);
      });
    },
  });

  // Track session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    branchFacts = null;
    cancelCodexUsageRefresh();
    codexUsage = null;
    codexUsageLastAttempt = 0;
    codexUsageGeneration++;
    codexUsageInFlight = null;
    cancelOpenRouterUsageRefresh();
    openRouterUsage = null;
    openRouterUsageLastAttempt = 0;
    openRouterUsageGeneration++;
    openRouterUsageInFlight = null;
    llmMs = 0;
    toolMs = 0;
    ttftSamples = [];
    turnStartMs = 0;
    toolMsThisTurn = 0;
    ttftRecordedThisTurn = false;
    agentStartMs = 0;
    lastTurnaroundMs = 0;
    statusTracker = createAgentStatusTracker();
    toolStartTimes.clear();

    if (ctx.hasUI) {
      setupFooter(ctx);
      void refreshCodexUsage(ctx, true);
      void refreshOpenRouterUsage(ctx, true);
    }
  });

  pi.on("session_shutdown", async () => {
    branchFacts = null;
    cancelCodexUsageRefresh();
    codexUsageGeneration++;
    codexUsageInFlight = null;
    cancelOpenRouterUsageRefresh();
    openRouterUsageGeneration++;
    openRouterUsageInFlight = null;
    // The seam is a closure over this session's TUI. Leaving it installed hands `opl-modes`
    // a dead component to render into on the next session, so it goes with the footer.
    delete (globalThis as Record<string, unknown>).__footerRequestRender;
  });

  const invalidateBranchFacts = (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    branchFacts = null;
    tuiRef?.requestRender();
  };
  pi.on("session_tree", invalidateBranchFacts);
  pi.on("session_compact", invalidateBranchFacts);

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      void refreshCodexUsage(ctx);
      void refreshOpenRouterUsage(ctx);
    }
  });

  pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
    void refreshCodexUsage(ctx, true);
    void refreshOpenRouterUsage(ctx, true);
  });

  // Track user-prompt-to-completion turnaround. agent_start may fire multiple
  // times per user turn (retries/compaction); only the first since the last
  // settle marks when the user's prompt began processing. agent_settled is the
  // authoritative "fully done, no auto-continuation" signal.
  pi.on("agent_start", async (_event: unknown, _ctx: ExtensionContext) => {
    if (agentStartMs === 0) agentStartMs = Date.now();
    statusTracker.agentStarted();
    tuiRef?.requestRender();
  });

  pi.on("agent_settled", async (_event: unknown, _ctx: ExtensionContext) => {
    if (agentStartMs > 0) {
      lastTurnaroundMs = Date.now() - agentStartMs;
      agentStartMs = 0;
    }
    statusTracker.agentSettled();
    tuiRef?.requestRender();
    void refreshCodexUsage(_ctx);
    void refreshOpenRouterUsage(_ctx);
  });

  pi.on("turn_start", async (_event: unknown, _ctx: ExtensionContext) => {
    turnStartMs = Date.now();
    toolMsThisTurn = 0;
    ttftRecordedThisTurn = false;
  });

  pi.on("turn_end", async (_event: unknown, _ctx: ExtensionContext) => {
    const elapsed = Date.now() - turnStartMs;
    llmMs += Math.max(0, elapsed - toolMsThisTurn);
  });

  pi.on("tool_execution_start", async (event: { toolCallId: string }, _ctx: ExtensionContext) => {
    toolStartTimes.set(event.toolCallId, Date.now());
    statusTracker.toolStarted(event.toolCallId);
    tuiRef?.requestRender();
  });

  pi.on("tool_execution_end", async (event: { toolCallId: string }, _ctx: ExtensionContext) => {
    const start = toolStartTimes.get(event.toolCallId);
    if (start !== undefined) {
      const elapsed = Date.now() - start;
      toolMs += elapsed;
      toolMsThisTurn += elapsed;
      toolStartTimes.delete(event.toolCallId);
    }
    statusTracker.toolEnded(event.toolCallId);
    tuiRef?.requestRender();
    void refreshCodexUsage(_ctx);
    void refreshOpenRouterUsage(_ctx);
  });

  pi.on("message_update", async (_event: unknown, _ctx: ExtensionContext) => {
    if (!ttftRecordedThisTurn && turnStartMs > 0) {
      ttftSamples.push(Date.now() - turnStartMs);
      ttftRecordedThisTurn = true;
    }
  });

  // Invalidate git status on file changes
  pi.on("tool_result", async (event: ToolResultEvent, _ctx: ExtensionContext) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    if (event.toolName === "bash" && mentionsGitBranchChange(event.input?.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => tuiRef?.requestRender(), 100);
    }
  });

  // Also catch user escape commands (! prefix)
  pi.on("user_bash", async (event: UserBashEvent, _ctx: ExtensionContext) => {
    if (mentionsGitBranchChange(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      tuiRef?.requestRender();
    }
  });

  function buildSegmentContext(ctx: ExtensionContext, width: number, theme: Theme): SegmentContext {
    const effectiveConfig = getEffectiveConfig();
    const colors = effectiveConfig.colors ?? getDefaultColors();

    const branch = (ctx.sessionManager?.getBranch?.() ?? []) as SessionEvent[];

    // Prefer Pi's canonical context usage (0.87). Immediately after compaction it is
    // null until the next assistant reply, so estimate the rebuilt projection instead.
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

    const needsEstimate = usage?.percent === null;
    const factsKey = JSON.stringify([
      ctx.sessionManager?.getSessionId?.(), ctx.sessionManager?.getLeafId?.(),
      branch.length, contextWindow, needsEstimate,
    ]);
    let facts = branchFacts;
    if (!facts || facts.key !== factsKey) {
      const projectedMessages = needsEstimate
        ? ctx.sessionManager?.buildSessionProjection?.().messages
        : undefined;
      try {
        facts = deriveBranchFacts(branch, factsKey, {
          contextWindow,
          needsEstimate,
          projectedMessages,
        });
      } catch {
        // The transcript is host data: an unexpected entry should degrade the cells that
        // read it, not throw and blank every row.
        facts = emptyBranchFacts(factsKey);
      }
      branchFacts = facts;
    }

    const contextPercent = usage?.percent ?? facts.estimatedContextUsage?.percent ?? null;
    const contextEstimated = needsEstimate && facts.estimatedContextUsage !== null;

    // Get git status (cached). Skip the probes entirely when no visible row renders the
    // git segment — otherwise an unused cell keeps spawning git once per second.
    const usesGit = LAYOUT_ROWS.some((row) => effectiveConfig[row]?.includes("git"));
    const gitBranch = usesGit ? footerDataRef?.getGitBranch() ?? null : null;
    const gitStatus = usesGit
      ? getGitStatus(gitBranch)
      : { branch: null, staged: 0, unstaged: 0, untracked: 0 };

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    // Local model detection: use model ID prefix (local.*) instead of URL
    // This allows litellm proxy to correctly separate local vs cloud models
    const isLocalModel = ctx.model?.id?.startsWith?.("local.") ?? false;

    return {
      model: ctx.model,
      isLocalModel,
      thinkingLevel: facts.thinkingLevelFromSession ?? pi.getThinkingLevel(),
      sessionId: ctx.sessionManager?.getSessionId?.(),
      usageStats: facts.usageStats,
      contextPercent,
      contextEstimated,
      contextWindow,
      usingSubscription,
      sessionStartTime,
      // The session directory, not the directory the harness was launched from: a session opened
      // elsewhere must show that project's path.
      cwd: ctx.cwd || process.cwd(),
      git: gitStatus,
      options: effectiveConfig.segmentOptions ?? {},
      width,
      theme,
      colors,
      icons: getIcons(effectiveConfig.icons),
      sessionStats: {
        prompts: facts.branchPrompts,
        apiCalls: facts.branchApiCalls,
        toolCalls: facts.branchToolCalls,
        llmMs,
        toolMs,
        ttftSamples,
        lastTurnaroundMs,
      },
      compactions: facts.branchCompactions,
      agentStatus: statusTracker.status(),
      codexUsage,
      openRouterUsage,
    };
  }

  function setupFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;

      // Expose a re-render trigger for out-of-turn state changes (e.g. /caveman toggle).
      (globalThis as Record<string, unknown>).__footerRequestRender = () => tui.requestRender();

      // Subscribe to branch changes for re-render
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          if (!currentCtx) return [];

          const effectiveConfig = getEffectiveConfig();
          let segmentCtx;
          try {
            segmentCtx = buildSegmentContext(currentCtx, width, theme);
          } catch {
            return [];
          }

          const rowSpecs: Array<[StatusLineSegmentId[], StatusLineSegmentId[]]> = [
            [effectiveConfig.row1LeftSegments, effectiveConfig.row1RightSegments],
            [effectiveConfig.row2LeftSegments, effectiveConfig.row2RightSegments],
            [effectiveConfig.row3LeftSegments, effectiveConfig.row3RightSegments],
          ];
          const rows = rowSpecs
            .map(([left, right]) => buildFooterContent(segmentCtx, left, right, width))
            .filter((row) => row.visible);
          if (rows.length === 0) return [];

          const divider = fg(theme, "separator", "─".repeat(width), segmentCtx.colors);
          // The leading blank keeps the transcript off the first footer line. Dividers
          // only go between rows that exist, so a one-row layout costs two lines, not six.
          const lines: string[] = [""];
          rows.forEach((row, index) => {
            if (index > 0) lines.push(divider);
            lines.push(row.text);
          });
          return lines;
        },
      };
    });
  }
}
