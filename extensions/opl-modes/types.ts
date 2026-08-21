/** Shared types for the opl-modes extension. */

/** Mode identifier — now extensible via config. Built-in: off, chat, plan, execute. */
export type AgentMode = string;

/** Persisted blob — plan file is the source of truth for steps. */
export interface AgentModeBlob {
  mode: AgentMode;
  activePlanFile: string | null;
}

export interface PlanFileSummary {
  name: string;
  title: string;
}

/** Model reference — provider + model id, resolved via ctx.modelRegistry.find(provider, id). */
export interface ModeModelConfig {
  provider: string;
  id: string;
}

// ─── User Config ─────────────────────────────────────────────────────────────

export interface CleanupUserConfig {
  cleanupOnComplete?: boolean;
}

export interface UiUserConfig {
  hideNotify?: boolean;
  hideWidget?: boolean;
}

export interface ShortcutsUserConfig {
  cycleMode?: string;
}

export interface ChatLabelUserConfig {
  notify?: string;
  notifyType?: string;
  widget?: string;
  widgetColor?: string;
}

export interface PlanLabelUserConfig {
  notify?: string;
  notifyType?: string;
  notifyWithTitle?: string;
  notifyLoaded?: string;
  widget?: string;
  widgetWithTitle?: string;
  widgetColor?: string;
}

export interface ExecuteLabelUserConfig {
  notify?: string;
  notifyWithTitle?: string;
  notifyType?: string;
  widget?: string;
  widgetWithTitle?: string;
  widgetColor?: string;
}

export interface OffLabelUserConfig {
  notify?: string;
  notifyType?: string;
}

/** Label configuration for a single mode. */
export interface ModeLabelConfig {
  notify?: string;
  notifyType?: string;
  notifyWithTitle?: string;
  notifyLoaded?: string;
  widget?: string;
  widgetWithTitle?: string;
  widgetColor?: string;
}

/** Legacy hardcoded labels — kept for backward compat. Prefer `modes` in user config. */
export interface LabelsUserConfig {
  chat?: ChatLabelUserConfig;
  plan?: PlanLabelUserConfig;
  execute?: ExecuteLabelUserConfig;
  off?: OffLabelUserConfig;
}

/** Complete definition for a single mode. */
export interface ModeDefinition {
  /** System prompt injected when this mode is active. */
  prompt: string | (() => string);
  /** Tool names available in this mode. Omit to inherit all tools. */
  tools?: string[];
  /** Bash command patterns considered safe (allowed). Compiled RegExp at runtime. */
  safePatterns?: RegExp[];
  /** Bash command patterns considered destructive (blocked). Compiled RegExp at runtime. */
  destructivePatterns?: RegExp[];
  /** UI labels for this mode. */
  labels?: ModeLabelConfig;
  /** Whether plan_complete tool should be available. Default: false */
  allowPlanComplete?: boolean;
  /** Whether to show this mode in the picker menu and cycling shortcut. Default: true */
  visible?: boolean;
  /** Whether this mode can be entered via the picker or cycle shortcut. Default: true. Unlike `visible`, disabling does not remove the mode — it can still be reached programmatically (e.g. execute mode via plan selection). */
  enabled?: boolean;
  /** Model to switch to when this mode is entered. Omit to leave the current model untouched. */
  model?: ModeModelConfig;
}

/** User-facing mode definition — patterns are raw strings, compiled to RegExp internally. */
export interface UserModeDefinition {
  prompt?: string;
  tools?: string[];
  safePatterns?: string[];
  destructivePatterns?: string[];
  labels?: ModeLabelConfig;
  allowPlanComplete?: boolean;
  visible?: boolean;
  /** Set to false to disable this mode from the picker menu and cycle shortcut. Default: true. */
  enabled?: boolean;
  /** Model to switch to when this mode is entered. Omit to leave the current model untouched. */
  model?: ModeModelConfig;
}
/** Partial mode definition for user config — all fields optional, patterns as raw strings. */
export type PartialModeDefinition = UserModeDefinition;

export interface BashPatternsUserConfig {
  safePatterns?: string[];
  destructivePatterns?: string[];
}

export interface ModeSwitcherUserConfig {
  cleanup?: CleanupUserConfig;
  ui?: UiUserConfig;
  shortcuts?: ShortcutsUserConfig;
  /** @deprecated Use `modes` registry instead. Kept for backward compat. */
  labels?: LabelsUserConfig;
  bashPatterns?: BashPatternsUserConfig;
  /** Replace-only: provide a list of tool names to replace the default CHAT mode tool set. Omit to keep defaults. */
  chatAllowedTools?: string[];
  /** Replace-only: provide a list of tool names to replace the default PLAN mode tool set. Omit to keep defaults. */
  planAllowedTools?: string[];
  /** User-defined modes that extend or override built-in modes. */
  modes?: Record<string, PartialModeDefinition>;
  /** Default notify text template for custom modes that don't set their own `labels.notify`. Use {Name} as a placeholder for the mode name (capitalized). Default: "✓ {Name} mode ON". */
  defaultNotifyTemplate?: string;
}
