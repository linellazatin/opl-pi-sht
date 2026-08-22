/** Config: tool allowlists, bash patterns, prompt templates, plan file constants, user config. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModeSwitcherUserConfig, ModeDefinition } from "./types.js";

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
const DEFAULT_SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*cd\b/,
  /^\s*echo\b/, /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/,
  /^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/,
  /^\s*tree\b/, /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/,
  /^\s*env\b/, /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/,
  /^\s*date\b/, /^\s*uptime\b/, /^\s*ps\b/, /^\s*free\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*jq\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote)/i,
  /^\s*node\s+--version/i, /^\s*python\s+--version/i,
  /^\s*(npx\s+)?tsc\b.*--noEmit/i,
  /^\s*npm\s+(list|ls|view|info|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
];

/** Default destructive command patterns — always blocked in read-only modes, even if matching a safe pattern. */
const DEFAULT_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i,
  /\bmkdir\b/i, /\btouch\b/i, /\bchmod\b/i, /\bchown\b/i,
  /\btee\b/i, /\bdd\b/i, /\bshred\b/i,
  /(^|[^<])>(?!>|&)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci)/i,
  /\byarn\s+(add|remove|install)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|merge|rebase|reset|checkout|branch\s+-)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i,
  /\b(sh|bash|zsh)\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
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

function loadUserConfig(): ModeSwitcherUserConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ModeSwitcherUserConfig;
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

/** Helper to convert string patterns to RegExp. */
function compilePatterns(patterns: string[] | undefined): RegExp[] | undefined {
  if (!patterns) return undefined;
  return patterns.map((p) => new RegExp(p, "i"));
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
  if (userConfig.modes) {
    for (const [name, def] of Object.entries(userConfig.modes)) {
      const existing = MODE_REGISTRY.get(name);
      if (existing) {
        registerMode(name, {
          ...existing,
          ...def,
          tools: def.tools ?? existing.tools,
          safePatterns: def.safePatterns ? compilePatterns(def.safePatterns) : existing.safePatterns,
          destructivePatterns: def.destructivePatterns ? compilePatterns(def.destructivePatterns) : existing.destructivePatterns,
          labels: { ...existing.labels, ...def.labels },
        });
      } else {
        registerMode(name, {
          prompt: def.prompt ?? "",
          tools: def.tools,
          safePatterns: compilePatterns(def.safePatterns),
          destructivePatterns: compilePatterns(def.destructivePatterns),
          allowPlanComplete: def.allowPlanComplete ?? false,
          allowExecute: def.allowExecute ?? true,
          visible: def.visible ?? true,
          enabled: def.enabled ?? true,
          model: def.model,
          labels: {
            notify: def.labels?.notify ?? customNotifyTemplate.replace("{Name}", name.charAt(0).toUpperCase() + name.slice(1)),
            notifyType: def.labels?.notifyType ?? "info",
            widget: def.labels?.widget ?? `${name} mode active`,
            widgetColor: def.labels?.widgetColor ?? "accent",
          },
        });
      }
    }
  }
}

initModeRegistry();
