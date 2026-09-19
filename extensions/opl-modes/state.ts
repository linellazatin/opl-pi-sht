/** OFF/CHAT/PLAN/EXECUTE unified state machine with session persistence via appendEntry blob. */

import { ENTRY_TYPE, getModeDefinition } from "./config.js";
import type { AgentMode, AgentModeBlob, ModeAppearanceConfig, ModeModelConfig } from "./types.js";

/** Mutable state — shared within the extension module. */
const state: {
  mode: AgentMode;
  activePlanFile: string | null;
  restoringModel: ModeModelConfig | null;
  refining: boolean;
  refineCount: number;
} = {
  mode: "off",
  activePlanFile: null,
  restoringModel: null,
  refining: false,
  refineCount: 0,
};

// Publish unified global and legacy globals at module load.
(globalThis as Record<string, unknown>).__agentMode = { mode: "off" };
(globalThis as Record<string, unknown>).__planMode = { mode: "off" };
(globalThis as Record<string, unknown>).__chatMode = { mode: "off" };

/** Derive and sync all globalThis snapshots from unified state. */
function syncGlobalThis(): void {
  const m = state.mode;
  // Unified global for the mode-switcher footer segment
  (globalThis as Record<string, unknown>).__agentMode = {
    mode: m,
    appearance: getModeDefinition(m)?.appearance,
  } satisfies { mode: AgentMode; appearance?: ModeAppearanceConfig };
  // Legacy globals for backward compat with chat-input and footer segments. Only the
  // plan-family modes light up __planMode, so a custom mode cannot read as "Plan mode ON".
  (globalThis as Record<string, unknown>).__planMode = { mode: m === "plan" || m === "execute" ? m : "off" };
  (globalThis as Record<string, unknown>).__chatMode = { mode: m === "chat" ? "chat" : "off" };
  const requestRender = (globalThis as Record<string, unknown>).__footerRequestRender;
  if (typeof requestRender === "function") requestRender();
}

export function getMode(): AgentMode { return state.mode; }
export function getActivePlanFile(): string | null { return state.activePlanFile; }
export function getRefining(): boolean { return state.refining; }

export function setRefining(value: boolean): void {
  state.refining = value;
  syncGlobalThis();
}

export function getRefineCount(): number { return state.refineCount; }
export function incrementRefineCount(): void { state.refineCount++; }
export function resetRefineCount(): void { state.refineCount = 0; }

/** Model reference to restore when the active mode ends (null = nothing to restore). */
export function getRestoringModel(): ModeModelConfig | null { return state.restoringModel; }

export function setRestoringModel(
  model: ModeModelConfig | null,
  pi: { appendEntry: (type: string, data?: unknown) => void },
): void {
  state.restoringModel = model;
  persist(pi);
}

export function setActivePlanFile(
  file: string | null,
  pi: { appendEntry: (type: string, data?: unknown) => void },
): void {
  state.activePlanFile = file;
  syncGlobalThis();
  persist(pi);
}

export function enterPlanWithFile(
  file: string | null,
  pi: { appendEntry: (type: string, data?: unknown) => void },
): void {
  state.mode = "plan";
  state.activePlanFile = file;
  state.refining = false;
  syncGlobalThis();
  persist(pi);
}

export function transition(
  newMode: AgentMode,
  pi: { appendEntry: (type: string, data?: unknown) => void },
): void {
  if (newMode === "plan") state.activePlanFile = null;
  state.mode = newMode;
  state.refining = false;
  state.refineCount = 0;
  syncGlobalThis();
  persist(pi);
}

function persist(pi: { appendEntry: (type: string, data?: unknown) => void }): void {
  pi.appendEntry(ENTRY_TYPE, {
    mode: state.mode,
    activePlanFile: state.activePlanFile,
    restoreModel: state.restoringModel,
  } satisfies AgentModeBlob);
}

/** Reject activePlanFile values that could escape PLAN_DIR via path components or traversal. */
function normalizePlanFile(file: string | null | undefined): string | null {
  if (!file) return null;
  if (file.includes("/") || file.includes("\\") || file.includes("..")) return null;
  return file;
}

/** Keep only a well-formed `{ provider, id }` pair; anything else means "nothing to restore". */
function normalizeModelRef(model: unknown): ModeModelConfig | null {
  if (typeof model !== "object" || model === null) return null;
  const { provider, id } = model as Partial<ModeModelConfig>;
  return typeof provider === "string" && provider && typeof id === "string" && id ? { provider, id } : null;
}

/**
 * Restore state from the most recent relevant session entry on the current branch.
 * Checks for native mode-switcher entries first; falls back to legacy plan-mode/chat-mode entries
 * so sessions saved by the old extensions are restored correctly.
 */
export function restore(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;

    if (entry.customType === ENTRY_TYPE) {
      const data = entry.data as AgentModeBlob | undefined;
      // Fail closed: only apply modes the registry actually knows, otherwise a stale or
      // foreign-branch entry would leave the session unrestricted (no tools, no patterns).
      if (data?.mode && getModeDefinition(data.mode)) {
        state.mode = data.mode;
        state.activePlanFile = normalizePlanFile(data.activePlanFile);
        state.restoringModel = normalizeModelRef(data.restoreModel);
        state.refining = false;
        syncGlobalThis();
        return true;
      }
    }
  }

  // Backward compat: restore from legacy entries written by the old extensions.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;

    if (entry.customType === "plan-mode") {
      const data = entry.data as { mode?: string; activePlanFile?: string | null } | undefined;
      if (data?.mode === "plan" || data?.mode === "execute") {
        state.mode = data.mode as AgentMode;
        state.activePlanFile = normalizePlanFile(data.activePlanFile);
        state.refining = false;
        syncGlobalThis();
        return true;
      }
    }

    if (entry.customType === "chat-mode") {
      const data = entry.data as { mode?: string } | undefined;
      if (data?.mode === "chat") {
        state.mode = "chat";
        state.activePlanFile = null;
        state.refining = false;
        syncGlobalThis();
        return true;
      }
    }
  }

  return false;
}

export function resetState(): void {
  state.mode = "off";
  state.activePlanFile = null;
  state.restoringModel = null;
  state.refining = false;
  state.refineCount = 0;
  syncGlobalThis();
}
