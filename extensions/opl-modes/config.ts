/** Config: tool allowlists, bash patterns, prompt templates, plan file constants, user config. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModeSwitcherUserConfig, ModeDefinition, PartialModeDefinition, ModeModelConfig } from "./types.js";

// ─── Plan File Constants ────────────────────────────────────────────────────

/** Directory for plan files, relative to project root. */
export const PLAN_DIR = ".pi/plans";

/** File prefix for plan files. */
export const PLAN_FILE_PREFIX = "plan-";

// ─── Tool Lists ─────────────────────────────────────────────────────────────

/** Default tool names available in PLAN mode (read-only). */
const DEFAULT_PLAN_MODE_TOOLS: string[] = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "artifact",
  "questionnaire",
];

/** Default tool names available in CHAT mode (read-only). */
const DEFAULT_CHAT_MODE_TOOLS: string[] = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "artifact",
  "questionnaire",
];

// ─── Bash Safety ─────────────────────────────────────────────────────────────

/** Default safe command patterns — only these are allowed in read-only modes (chat and plan). */
export const DEFAULT_SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*cd\b/,
  /^\s*echo\b/, /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/,
  // Pure stdout filters. uniq can write its second operand, so it is gated in the blocklist.
  /^\s*uniq\b/, /^\s*tr\b/, /^\s*cut\b/,
  /^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/,
  /^\s*tree\b/, /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/,
  /^\s*uname\b/, /^\s*whoami\b/,
  /^\s*date\b/, /^\s*uptime\b/, /^\s*ps\b/, /^\s*free\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*jq\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse)/i,
  /^\s*node\s+--version/i, /^\s*python\s+--version/i,
  /^\s*(npx\s+)?tsc\b.*--noEmit/i,
  /^\s*npm\s+(list|ls|view|info|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
];

/** Destructive command patterns — always blocked in read-only modes, even if matching a safe pattern.
 *  Program names are anchored to command position (`^\s*`) and matched per shell segment, so a
 *  read-only command that merely mentions `rm`/`cp`/`sh` in an argument (`du -sh`, `ls cp/`,
 *  `git log --grep=rm`) stays allowed. Flag and redirect patterns stay unanchored on purpose. */
export const DEFAULT_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /^\s*(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee|dd|shred|truncate)\b/i,
  // Write flags that ride a safe-listed command: find's file-writing predicates and --output
  // on sort/git log/git diff/git show. `-print`/`-printf` stay allowed (they go to stdout).
  /\s-{1,2}(delete|exec|execdir|exec-batch|fprint0?|fprintf|fls|output)\b/i,
  /\bsort\b[^\n]*\s-o\b/i,
  // Any redirect that names a file. `>&<fd>`/`>&-` duplication is not a write, so 2>&1 survives.
  /(^|[^<])>(?!>)(?!&[0-9-])(?! *\/dev\/null)/, />>(?! *\/dev\/null)/,
  // uniq writes its second operand (`uniq -c in.txt out.txt`); flags don't count, so
  // `uniq -c sorted.txt` stays a read.
  /^\s*uniq\b(?:\s+-\S+)*\s+[^-\s]\S*(?:\s+[^-\s]\S*)+/,
  /\bnpm\s+(install|uninstall|update|upgrade|ci)/i,
  /\bnpm\s+audit\b.*\bfix\b/i,
  /\byarn\s+(add|remove|install)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|merge|rebase|reset|checkout|clean|update-ref|cherry-pick|revert|am|apply|branch\s+(-{1,2}[dDmMcC]|--(unset-upstream|edit-description))|tag\s+-)/i,
  // Subcommands that hide behind the safe `git remote` prefix and still write .git.
  /\bgit\s+remote\s+(add|remove|rename|set-url|set-head|setbranches|prune|update)\b/i,
  /^\s*(sudo|su|kill|pkill)\b/i,
  /^\s*(sh|bash|zsh)\b/i,
  /^\s*(vim?|nano|emacs|code|subl)\b/i,
];

// ─── Prompt Templates ────────────────────────────────────────────────────────

/** System prompt injected when in CHAT mode. */
export const CHAT_MODE_PROMPT = `\
**SUPERSEDES ALL OTHER BEHAVIOR INSTRUCTIONS.** This overrides any role or style directives (e.g. caveman, roleplay, tone modifiers). The constraints below take absolute priority.

You are in CHAT MODE. You have read-only access — you may read files, search code, run safe inspection commands, and search the web to answer, discuss, and explore. Converse naturally — answer questions, explain, brainstorm, look things up.

You MUST NOT attempt to edit, create, delete, or modify any files, or run any command that changes state. If the user asks for a change, explain what you would do but do not attempt it — they can exit chat mode first.

There is no plan format and no plan_complete tool. Just respond helpfully within read-only constraints.`;

/** System prompt injected when in PLAN mode. */
export const PLAN_MODE_PROMPT = `\
**SUPERSEDES ALL OTHER BEHAVIOR INSTRUCTIONS.** This overrides any role or style directives (e.g. caveman, roleplay, tone modifiers). The constraints below take absolute priority.

You are in PLAN MODE. You have read-only access — you may explore and analyze, but you MUST NOT make any changes.

Your task: produce an action plan.

You MUST begin the plan with exactly this heading on its own line:

# Plan:
1. [Step title — short verb-object phrase]
   [2-4 sentences of context: which file(s), where, what to change, and why.]
2. [Step title]
   [Context...]
...

Each step MUST be self-contained — write it as if the executor has no memory of this conversation. Include enough context that it can be carried out with only the plan file and the codebase. Assume the executor will read the relevant files fresh — do not rely on findings you discovered during planning.

Good: "Add auth middleware to routes/index.ts
     Apply it as \`app.use(authMiddleware)\` before the route definitions (~line 45). Currently routes/index.ts has no middleware."

Bad: "Add it to the file we looked at"

Bad (over-prescribed): "Insert \`const authMiddleware = require('./middleware/auth');\` at line 3, then add \`app.use(authMiddleware);\` at line 46"

Specify what to do and where — not the exact implementation. The executor reads the relevant files and decides how.

After listing all steps, stop and wait for the user to choose:
- "Execute plan" — switches to execute mode where you carry out each step
- "Refine" — revise the plan based on feedback
- Continue exploring if you need more information before planning

Do NOT attempt to make any file changes, run destructive commands, or modify anything.`;

/** System prompt injected when in EXECUTE mode. */
export function buildExecutePrompt(planContent: string): string {
  return `\
You are in EXECUTE MODE. Execute the plan below step by step.

After completing ALL steps, call plan_complete() to signal that execution is finished. Do NOT call plan_complete before all steps are done.

If the \`todo\` tool is available, use it to track progress: add all plan steps at the start of execution, then toggle each one done as you complete it.

Plan:
${planContent}`;
}

/** System prompt injected when refining a plan in PLAN mode. */
export function buildRefinePrompt(planContent: string): string {
  return `\
You are in PLAN MODE (refining). The user wants to revise the current plan based on their feedback.

Current plan:
${planContent}

Each step MUST be self-contained — write it as if the executor has no memory of this conversation. Include enough context that it can be carried out with only the plan file and the codebase. Assume the executor will read the relevant files fresh — do not rely on findings you discovered during planning.

Revise the plan and output the full updated plan.

You MUST begin the revised plan with exactly this heading on its own line:

# Plan:

Do NOT make any changes. Only produce a revised plan.`;
}

// ─── Custom Entry Types ──────────────────────────────────────────────────────

/** customType value stored in session entries. */
export const ENTRY_TYPE = "mode-switcher"; // Stable session identifier.

// ─── User Config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  CLEANUP: {
    CLEANUP_ON_COMPLETE: true,
  },
  UI: {
    HIDE_NOTIFY: false,
    HIDE_WIDGET: true,
  },
  SHORTCUTS: {
    CYCLE_MODE: "ctrl+alt+m",
  },
  LABELS: {
    CHAT: {
      NOTIFY: "✓ Chat mode ON",
      NOTIFY_TYPE: "info",
      WIDGET: "✓ Chat mode",
      WIDGET_COLOR: "accent",
    },
    PLAN: {
      NOTIFY: "✓ Plan mode ON",
      NOTIFY_TYPE: "info",
      NOTIFY_WITH_TITLE: "✓ Active plan {title}",
      NOTIFY_LOADED: "✓ Active plan: {title}",
      WIDGET: "✓ Plan mode active",
      WIDGET_WITH_TITLE: "✓ Active plan: {title}",
      WIDGET_COLOR: "accent",
    },
    EXECUTE: {
      NOTIFY: "✓ Executing plan",
      NOTIFY_WITH_TITLE: "✓ Executing plan: {title}",
      NOTIFY_TYPE: "info",
      WIDGET: "✓ Executing plan",
      WIDGET_WITH_TITLE: "✓ Executing plan: {title}",
      WIDGET_COLOR: "muted",
    },
    OFF: {
      NOTIFY: "✓ Normal mode",
      NOTIFY_TYPE: "info",
    },
  },
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "configs", "opl-modes.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadUserConfig(path = CONFIG_PATH): ModeSwitcherUserConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed as ModeSwitcherUserConfig : {};
  } catch {
    return {};
  }
}

const userConfig = loadUserConfig();

// ─── Bash Pattern Resolution ──────────────────────────────────────────────────

/** Compile string patterns to RegExp. Falls back to defaults if list is empty or all fail. */
function resolvePatterns(strings: string[] | undefined, defaults: RegExp[]): RegExp[] {
  if (!strings || strings.length === 0) return defaults;
  const patterns: RegExp[] = [];
  for (const p of strings) {
    try {
      patterns.push(new RegExp(p, "i"));
    } catch {
      console.warn(`[opl-modes] Invalid pattern: "${p}" — skipping`);
    }
  }
  return patterns.length > 0 ? patterns : defaults;
}

/** Safe command patterns — resolved from user config or defaults. Replace-only: user list replaces all defaults. */
export const SAFE_COMMAND_PATTERNS: RegExp[] = resolvePatterns(
  userConfig.bashPatterns?.safePatterns,
  DEFAULT_SAFE_PATTERNS,
);

/** Destructive command patterns — resolved from user config or defaults. Replace-only: user list replaces all defaults. */
export const DESTRUCTIVE_PATTERNS: RegExp[] = resolvePatterns(
  userConfig.bashPatterns?.destructivePatterns,
  DEFAULT_DESTRUCTIVE_PATTERNS,
);

/** Tool names available in PLAN mode. Replace-only: user-provided list replaces defaults. */
export const PLAN_MODE_TOOLS: string[] =
  userConfig.planAllowedTools && userConfig.planAllowedTools.length > 0
    ? userConfig.planAllowedTools
    : DEFAULT_PLAN_MODE_TOOLS;

/** Tool names available in CHAT mode. Replace-only: user-provided list replaces defaults. */
export const CHAT_MODE_TOOLS: string[] =
  userConfig.chatAllowedTools && userConfig.chatAllowedTools.length > 0
    ? userConfig.chatAllowedTools
    : DEFAULT_CHAT_MODE_TOOLS;

// ─── Lazy Tool Loading ────────────────────────────────────────────────────────

/** Loader tool name. Registered by opl-modes when any lazy tools are configured. */
export const LOADER_TOOL_NAME = "load_tools";

/** Tools that must never be lazy: core built-ins, the execute-only signal, and the loader itself. */
export const PROTECTED_TOOLS: Set<string> = new Set([
  "read", "edit", "write", "bash", "powershell", "grep", "find", "ls",
  "plan_complete", LOADER_TOOL_NAME,
]);

/** Filter a user lazy-tool list: drop protected/core tools and empties, dedupe. */
export function resolveLazyTools(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).filter((n) => n && !PROTECTED_TOOLS.has(n)))];
}

/** Configured lazy tools, protected-filtered. */
export const LAZY_TOOLS: Set<string> = new Set(resolveLazyTools(userConfig.lazyTools));

/**
 * Apply lazy policy to an active-set candidate: remove lazy tools, and inject the
 * loader ONLY when at least one lazy tool was actually withheld from this set.
 * A set with no lazy tools (e.g. read-only chat/plan lists) is returned unchanged.
 */
export function applyLazyPolicy(names: string[], lazy: Set<string> = LAZY_TOOLS, loader = LOADER_TOOL_NAME): string[] {
  if (lazy.size === 0) return names;
  const heldBack = names.some((n) => lazy.has(n));
  const filtered = names.filter((n) => !lazy.has(n));
  return heldBack && !filtered.includes(loader) ? [...filtered, loader] : filtered;
}

/**
 * Select which lazy tools to activate: requested (or all lazy when omitted),
 * intersected with the lazy set and the current mode's allowed tools
 * (modeAllowed=null means the mode inherits all tools), minus already-active.
 */
export function lazyToolsToEnable(
  requested: string[] | undefined,
  current: string[],
  modeAllowed: string[] | null,
  lazy: Set<string> = LAZY_TOOLS,
): string[] {
  const allowed = modeAllowed ? new Set(modeAllowed) : null;
  const want = requested && requested.length ? requested : [...lazy];
  const active = new Set(current);
  return want.filter((n) => lazy.has(n) && (!allowed || allowed.has(n)) && !active.has(n));
}

export const USER_CONFIG = {
  cleanup: {
    cleanupOnComplete: userConfig.cleanup?.cleanupOnComplete ?? DEFAULT_CONFIG.CLEANUP.CLEANUP_ON_COMPLETE,
  },
  ui: {
    hideNotify: userConfig.ui?.hideNotify ?? DEFAULT_CONFIG.UI.HIDE_NOTIFY,
    hideWidget: userConfig.ui?.hideWidget ?? DEFAULT_CONFIG.UI.HIDE_WIDGET,
  },
  shortcuts: {
    cycleMode: userConfig.shortcuts?.cycleMode ?? DEFAULT_CONFIG.SHORTCUTS.CYCLE_MODE,
  },
  labels: {
    chat: {
      notify: userConfig.labels?.chat?.notify ?? DEFAULT_CONFIG.LABELS.CHAT.NOTIFY,
      notifyType: userConfig.labels?.chat?.notifyType ?? DEFAULT_CONFIG.LABELS.CHAT.NOTIFY_TYPE,
      widget: userConfig.labels?.chat?.widget ?? DEFAULT_CONFIG.LABELS.CHAT.WIDGET,
      widgetColor: userConfig.labels?.chat?.widgetColor ?? DEFAULT_CONFIG.LABELS.CHAT.WIDGET_COLOR,
    },
    plan: {
      notify: userConfig.labels?.plan?.notify ?? DEFAULT_CONFIG.LABELS.PLAN.NOTIFY,
      notifyType: userConfig.labels?.plan?.notifyType ?? DEFAULT_CONFIG.LABELS.PLAN.NOTIFY_TYPE,
      notifyWithTitle: userConfig.labels?.plan?.notifyWithTitle ?? DEFAULT_CONFIG.LABELS.PLAN.NOTIFY_WITH_TITLE,
      notifyLoaded: userConfig.labels?.plan?.notifyLoaded ?? DEFAULT_CONFIG.LABELS.PLAN.NOTIFY_LOADED,
      widget: userConfig.labels?.plan?.widget ?? DEFAULT_CONFIG.LABELS.PLAN.WIDGET,
      widgetWithTitle: userConfig.labels?.plan?.widgetWithTitle ?? DEFAULT_CONFIG.LABELS.PLAN.WIDGET_WITH_TITLE,
      widgetColor: userConfig.labels?.plan?.widgetColor ?? DEFAULT_CONFIG.LABELS.PLAN.WIDGET_COLOR,
    },
    execute: {
      notify: userConfig.labels?.execute?.notify ?? DEFAULT_CONFIG.LABELS.EXECUTE.NOTIFY,
      notifyWithTitle: userConfig.labels?.execute?.notifyWithTitle ?? DEFAULT_CONFIG.LABELS.EXECUTE.NOTIFY_WITH_TITLE,
      notifyType: userConfig.labels?.execute?.notifyType ?? DEFAULT_CONFIG.LABELS.EXECUTE.NOTIFY_TYPE,
      widget: userConfig.labels?.execute?.widget ?? DEFAULT_CONFIG.LABELS.EXECUTE.WIDGET,
      widgetWithTitle: userConfig.labels?.execute?.widgetWithTitle ?? DEFAULT_CONFIG.LABELS.EXECUTE.WIDGET_WITH_TITLE,
      widgetColor: userConfig.labels?.execute?.widgetColor ?? DEFAULT_CONFIG.LABELS.EXECUTE.WIDGET_COLOR,
    },
    off: {
      notify: userConfig.labels?.off?.notify ?? DEFAULT_CONFIG.LABELS.OFF.NOTIFY,
      notifyType: userConfig.labels?.off?.notifyType ?? DEFAULT_CONFIG.LABELS.OFF.NOTIFY_TYPE,
    },
  },
};

// ─── Mode Registry ─────────────────────────────────────────────────────────
// Must come AFTER all the consts above (CHAT_MODE_TOOLS, PLAN_MODE_TOOLS,
// SAFE_COMMAND_PATTERNS, DESTRUCTIVE_PATTERNS, userConfig) since defaults
// reference them.

/** Mode Registry — stores all registered mode definitions. */
export const MODE_REGISTRY = new Map<string, ModeDefinition>();

/** Compile a valid pattern array. Undefined means malformed input or no usable patterns. */
export function compilePatterns(patterns: unknown): RegExp[] | undefined {
  if (!Array.isArray(patterns)) return undefined;
  if (patterns.length === 0) return [];
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") return undefined;
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch {
      console.warn(`[opl-modes] Invalid pattern: "${pattern}" — ignoring the override`);
      return undefined;
    }
  }
  return compiled;
}

/** Resolve the Bash pattern pair for a newly registered custom mode from the shared
 *  base (top-level bashPatterns), with per-mode overrides and an explicit opt-out.
 *  Omitted components inherit; explicit arrays (even empty) replace; `unrestrictedBash`
 *  disables Bash gating entirely for that mode. */
export function resolveCustomPatterns(def: {
  safePatterns?: unknown;
  destructivePatterns?: unknown;
  unrestrictedBash?: boolean;
}): { safe?: RegExp[]; destructive?: RegExp[] } {
  if (def.unrestrictedBash) return { safe: undefined, destructive: undefined };
  return {
    safe: compilePatterns(def.safePatterns) ?? SAFE_COMMAND_PATTERNS,
    destructive: compilePatterns(def.destructivePatterns) ?? DESTRUCTIVE_PATTERNS,
  };
}

/**
 * Normalize a configured model reference. A blank or partial `{ provider, id }` means
 * "no override" — Pi's registry cannot resolve empty strings, so passing one through
 * would only warn "Model not found: /" and leave the model untouched. Treating it as
 * unset makes the mode keep (and later restore) the current model instead.
 */
export function resolveModeModel(model: unknown): ModeModelConfig | undefined {
  if (!isRecord(model)) return undefined;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  return provider && id ? { provider, id } : undefined;
}

export function mergeModeDefinition(existing: ModeDefinition, def: PartialModeDefinition): ModeDefinition {
  // unrestrictedBash is an opt-out for built-in overrides too, not just new modes.
  const unrestricted = def.unrestrictedBash === true;
  return {
    ...existing,
    ...def,
    tools: def.tools ?? existing.tools,
    model: "model" in def ? resolveModeModel(def.model) : existing.model,
    safePatterns: unrestricted ? undefined : (compilePatterns(def.safePatterns) ?? existing.safePatterns),
    destructivePatterns: unrestricted ? undefined : (compilePatterns(def.destructivePatterns) ?? existing.destructivePatterns),
    labels: { ...existing.labels, ...def.labels },
    appearance: def.appearance ?? existing.appearance,
  };
}

/** Register a mode with the registry. Called by extensions at startup. */
export function registerMode(name: string, definition: ModeDefinition): void {
  MODE_REGISTRY.set(name, definition);
}

/** Get a mode definition from the registry. */
export function getModeDefinition(name: string): ModeDefinition | undefined {
  return MODE_REGISTRY.get(name);
}

/** Whether plan execution may be started while `mode` is active. Default: true. */
export function executeHandoffAllowed(mode: string, registry: Map<string, ModeDefinition> = MODE_REGISTRY): boolean {
  const def = registry.get(mode);
  return def ? def.allowExecute !== false : true;
}

/** Append plan_complete to a tool list when the mode allows it. */
export function withPlanComplete(mode: string, tools: string[], registry: Map<string, ModeDefinition> = MODE_REGISTRY): string[] {
  const def = registry.get(mode);
  if (def?.allowPlanComplete && !tools.includes("plan_complete")) return [...tools, "plan_complete"];
  return tools;
}

/**
 * Whether `plan_complete` may be called while `mode` is active: execute mode and any mode
 * with allowPlanComplete. Same predicate that decides the tool's presence in the tool list.
 */
export function planCompleteAllowed(mode: string, registry: Map<string, ModeDefinition> = MODE_REGISTRY): boolean {
  return registry.get(mode)?.allowPlanComplete === true;
}

/** Initialize MODE_REGISTRY with built-in defaults, then merge user-defined modes. */
function initModeRegistry(): void {
  const customNotifyTemplate = userConfig.defaultNotifyTemplate ?? "✓ {Name} mode ON";

  registerMode("off", {
    prompt: "",
    allowPlanComplete: false,
    allowExecute: true,
    visible: true,
    labels: {
      notify: DEFAULT_CONFIG.LABELS.OFF.NOTIFY,
      notifyType: DEFAULT_CONFIG.LABELS.OFF.NOTIFY_TYPE,
      widget: DEFAULT_CONFIG.LABELS.OFF.NOTIFY,
      widgetColor: "dim",
    },
  });

  registerMode("chat", {
    prompt: CHAT_MODE_PROMPT,
    tools: CHAT_MODE_TOOLS,
    safePatterns: SAFE_COMMAND_PATTERNS,
    destructivePatterns: DESTRUCTIVE_PATTERNS,
    allowPlanComplete: false,
    allowExecute: true,
    visible: true,
    labels: USER_CONFIG.labels.chat,
  });

  registerMode("plan", {
    prompt: PLAN_MODE_PROMPT,
    tools: PLAN_MODE_TOOLS,
    safePatterns: SAFE_COMMAND_PATTERNS,
    destructivePatterns: DESTRUCTIVE_PATTERNS,
    allowPlanComplete: false,
    allowExecute: true,
    visible: true,
    labels: USER_CONFIG.labels.plan,
  });

  registerMode("execute", {
    prompt: "", // Built dynamically with buildExecutePrompt from the active plan file
    allowPlanComplete: true,
    allowExecute: true,
    visible: false, // entered only via "execute:<plan-file>" picker items, never as a bare menu choice
    labels: USER_CONFIG.labels.execute,
  });

  // Merge user-defined modes from config (can override built-ins or add new ones).
  if (isRecord(userConfig.modes)) {
    for (const [name, rawDefinition] of Object.entries(userConfig.modes)) {
      if (!isRecord(rawDefinition)) continue;
      const def = rawDefinition as PartialModeDefinition;
      const existing = MODE_REGISTRY.get(name);
      if (existing) {
        registerMode(name, mergeModeDefinition(existing, def));
      } else {
        const patterns = resolveCustomPatterns(def);
        registerMode(name, {
          prompt: def.prompt ?? "",
          tools: def.tools,
          safePatterns: patterns.safe,
          destructivePatterns: patterns.destructive,
          allowPlanComplete: def.allowPlanComplete ?? false,
          allowExecute: def.allowExecute ?? true,
          visible: def.visible ?? true,
          enabled: def.enabled ?? true,
          model: resolveModeModel(def.model),
          labels: {
            notify: def.labels?.notify ?? customNotifyTemplate.replace("{Name}", name.charAt(0).toUpperCase() + name.slice(1)),
            notifyType: def.labels?.notifyType ?? "info",
            widget: def.labels?.widget ?? `${name} mode active`,
            widgetColor: def.labels?.widgetColor ?? "accent",
          },
          appearance: def.appearance,
        });
      }
    }
  }
}

initModeRegistry();
