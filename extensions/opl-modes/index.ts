/**
 * Mode Switcher — unified chat/plan/execute mode manager.
 *
 * Single shortcut (ctrl+alt+m) opens a picker to switch between:
 *   Chat     — read-only conversational mode
 *   Plan     — read-only explore-and-plan mode (with plan file management)
 *   Normal   — restore normal agent behavior
 *
 * Replaces the separate chat-mode and plan-mode extensions. Publishes both
 * __chatMode and __planMode globals so chat-input and footer segments continue
 * to work without changes.
 *
 * Backward-compatible commands: /chat, /plan, /mode
 * Backward-compatible flags:    --chat, --plan
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Container, Input, Text, Spacer, type KeyId, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";

import {
  PLAN_MODE_TOOLS,
  CHAT_MODE_TOOLS,
  PLAN_MODE_PROMPT,
  CHAT_MODE_PROMPT,
  PLAN_FILE_PREFIX,
  PLAN_DIR,
  buildExecutePrompt,
  buildRefinePrompt,
  USER_CONFIG,
  MODE_REGISTRY,
  getModeDefinition,
  executeHandoffAllowed,
  withPlanComplete,
} from "./config.js";
import {
  isSafeCommand,
  extractPlanText,
  isPlanLike,
  ensurePlanDir,
  titleFromFilename,
  listPlanFiles,
  sanitizePlanName,
  extractTextFromMessage,
  applyLabelColor,
} from "./utils.js";
import {
  getMode,
  getRefining,
  setRefining,
  getActivePlanFile,
  setActivePlanFile,
  transition,
  enterPlanWithFile,
  restore,
  resetState,
  getRefineCount,
  incrementRefineCount,
} from "./state.js";
import { showSelectMenu } from "./menus.js";

export default function modeSwitcher(pi: ExtensionAPI) {
  // ─── Saved tool list for restoring ────────────────────────────────────────
  let savedToolNames: string[] | null = null;
  // ─── Saved model for restoring ─────────────────────────────────────────────
  let savedModel: Model<any> | null = null;
  const MAX_REFINE_CYCLES = 5;

  function saveAndSetActiveTools(toolNames: string[]): void {
    if (savedToolNames === null) {
      savedToolNames = pi.getAllTools().map((t) => t.name);
    }
    pi.setActiveTools(toolNames);
  }

  /**
   * Resolve and switch to a specific model, notifying on failure, then refresh
   * the footer via updateStatus. No savedModel bookkeeping — callers that need
   * restore semantics use applyModeModel instead.
   */
  async function switchToModel(ctx: ExtensionContext, modelRef: { provider: string; id: string }): Promise<void> {
    const resolved = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
    if (!resolved) {
      if (ctx.hasUI) ctx.ui.notify(`[mode-switcher] Model not found: ${modelRef.provider}/${modelRef.id}`, "warning");
      return;
    }
    const success = await pi.setModel(resolved);
    if (!success && ctx.hasUI) {
      ctx.ui.notify(`[mode-switcher] No API key for model ${modelRef.provider}/${modelRef.id}`, "error");
    }
    updateStatus(ctx);
  }

  /**
   * Switch to the mode's configured model (if any). Awaiting this guarantees the
   * model switch has actually landed before any dependent action (e.g. starting
   * execution). Callers that don't need that guarantee (plain mode entry) can
   * ignore the returned promise — the footer's model segment (which reads
   * ctx.model live on every render) still gets refreshed via updateStatus(ctx)
   * once the switch resolves.
   */
  async function applyModeModel(ctx: ExtensionContext, modeDef: { model?: { provider: string; id: string } } | undefined): Promise<void> {
    const modelRef = modeDef?.model;
    if (!modelRef) return;
    if (savedModel === null) {
      savedModel = ctx.model ?? null;
    }
    await switchToModel(ctx, modelRef);
  }

  /** Restore whatever model was active before applyModeModel last changed it. */
  function restoreModelIfSaved(ctx: ExtensionContext): void {
    if (savedModel === null) return;
    const toRestore = savedModel;
    savedModel = null;
    pi.setModel(toRestore).then(() => {
      updateStatus(ctx);
    });
  }

  /**
   * OFF mode's model handling. If OFF has its own configured model, apply it
   * deterministically — OFF is the resting baseline, so drop any pending restore
   * so future mode switches capture OFF's model as their restore point. If OFF
   * has no model configured, fall back to restoring whatever model was active
   * before the last mode switch (original behavior).
   */
  function applyOffModel(ctx: ExtensionContext): void {
    const offModeDef = getModeDefinition("off");
    if (offModeDef?.model) {
      savedModel = null;
      switchToModel(ctx, offModeDef.model);
    } else {
      restoreModelIfSaved(ctx);
    }
  }

  /** Filter out plan_complete — only available in execute mode. */
  function toolsWithoutPlanComplete(names: string[]): string[] {
    return names.filter((n) => n !== "plan_complete");
  }

  function restoreAllTools(): void {
    if (savedToolNames !== null) {
      pi.setActiveTools(toolsWithoutPlanComplete(savedToolNames));
      savedToolNames = null;
    } else {
      pi.setActiveTools(toolsWithoutPlanComplete(pi.getAllTools().map((t) => t.name)));
    }
  }

  // ─── Plan file helpers ─────────────────────────────────────────────────────

  function getPlanFilePath(): string | null {
    const file = getActivePlanFile();
    if (!file) return null;
    return join(process.cwd(), PLAN_DIR, file);
  }

  function getPlanDisplayTitle(): string | null {
    const file = getActivePlanFile();
    if (!file) return null;
    const filePath = getPlanFilePath();
    if (filePath && existsSync(filePath)) {
      const heading = readFileSync(filePath, "utf-8").match(/^# Plan:\s*(.+)$/m);
      if (heading) return heading[1].trim();
    }
    return titleFromFilename(file);
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    const mode = getMode();
    const modeDef = getModeDefinition(mode);

    if (!ctx.hasUI) return;

    // Chat widget
    if (mode === "chat") {
      const widgetColor = modeDef?.labels?.widgetColor ?? USER_CONFIG.labels.chat.widgetColor;
      const widgetText = modeDef?.labels?.widget ?? USER_CONFIG.labels.chat.widget;
      ctx.ui.setWidget(
        "chat-mode",
        USER_CONFIG.ui.hideWidget ? undefined : [applyLabelColor(ctx.ui.theme, widgetColor, widgetText)],
      );
    } else {
      ctx.ui.setWidget("chat-mode", undefined);
    }

    // Plan/execute widget
    if (mode === "plan") {
      const title = getPlanDisplayTitle();
      const widgetWithTitle = modeDef?.labels?.widgetWithTitle ?? USER_CONFIG.labels.plan.widgetWithTitle;
      const widgetPlain = modeDef?.labels?.widget ?? USER_CONFIG.labels.plan.widget;
      const widgetText = title ? widgetWithTitle.replace("{title}", title) : widgetPlain;
      const widgetColor = modeDef?.labels?.widgetColor ?? USER_CONFIG.labels.plan.widgetColor;
      ctx.ui.setWidget(
        "plan-mode",
        USER_CONFIG.ui.hideWidget ? undefined : [applyLabelColor(ctx.ui.theme, widgetColor, widgetText)],
      );
    } else if (mode === "execute") {
      const title = getPlanDisplayTitle();
      const widgetWithTitle = modeDef?.labels?.widgetWithTitle ?? USER_CONFIG.labels.execute.widgetWithTitle;
      const widgetPlain = modeDef?.labels?.widget ?? USER_CONFIG.labels.execute.widget;
      const widgetText = title ? widgetWithTitle.replace("{title}", title) : widgetPlain;
      const widgetColor = modeDef?.labels?.widgetColor ?? USER_CONFIG.labels.execute.widgetColor;
      ctx.ui.setWidget(
        "plan-mode",
        USER_CONFIG.ui.hideWidget ? undefined : [applyLabelColor(ctx.ui.theme, widgetColor, widgetText)],
      );
    } else {
      ctx.ui.setWidget("plan-mode", undefined);
    }

    // Custom mode widget (any registered mode other than off/chat/plan/execute)
    if (mode !== "off" && mode !== "chat" && mode !== "plan" && mode !== "execute") {
      const widgetText = modeDef?.labels?.widget || `✓ ${mode} mode`;
      const widgetColor = modeDef?.labels?.widgetColor || "accent";
      ctx.ui.setWidget(
        "custom-mode",
        USER_CONFIG.ui.hideWidget ? undefined : [applyLabelColor(ctx.ui.theme, widgetColor, widgetText)],
      );
    } else {
      ctx.ui.setWidget("custom-mode", undefined);
    }

    // Emit legacy events for any other extensions listening
    pi.events.emit("chat-mode:state", { mode: mode === "chat" ? "chat" : "off" });
    pi.events.emit("plan-mode:state", { mode: mode === "chat" ? "off" : mode });
  }

  // ─── State transitions ─────────────────────────────────────────────────────

  function enterChatMode(ctx: ExtensionContext): void {
    transition("chat", pi);
    const modeDef = getModeDefinition("chat");
    saveAndSetActiveTools(modeDef?.tools ?? CHAT_MODE_TOOLS);
    applyModeModel(ctx, modeDef);
    updateStatus(ctx);
    if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      const notify = modeDef?.labels?.notify ?? USER_CONFIG.labels.chat.notify;
      const notifyType = (modeDef?.labels?.notifyType ?? USER_CONFIG.labels.chat.notifyType) as "info" | "warning" | "error";
      ctx.ui.notify(notify, notifyType);
    }
  }

  function enterPlanMode(ctx: ExtensionContext): void {
    transition("plan", pi);
    const modeDef = getModeDefinition("plan");
    saveAndSetActiveTools(modeDef?.tools ?? PLAN_MODE_TOOLS);
    applyModeModel(ctx, modeDef);
    updateStatus(ctx);
    if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      const notify = modeDef?.labels?.notify ?? USER_CONFIG.labels.plan.notify;
      const notifyType = (modeDef?.labels?.notifyType ?? USER_CONFIG.labels.plan.notifyType) as "info" | "warning" | "error";
      ctx.ui.notify(notify, notifyType);
    }
  }

  async function enterExecuteMode(ctx: ExtensionContext): Promise<void> {
    transition("execute", pi);
    const baseNames = savedToolNames ?? pi.getAllTools().map((t) => t.name);
    pi.setActiveTools([...toolsWithoutPlanComplete(baseNames), "plan_complete"]);
    savedToolNames = null;
    const modeDef = getModeDefinition("execute");
    await applyModeModel(ctx, modeDef);
    updateStatus(ctx);
    const title = getPlanDisplayTitle();
    const notifyWithTitle = modeDef?.labels?.notifyWithTitle ?? USER_CONFIG.labels.execute.notifyWithTitle;
    const notifyPlain = modeDef?.labels?.notify ?? USER_CONFIG.labels.execute.notify;
    const notifyText = title ? notifyWithTitle.replace("{title}", title) : notifyPlain;
    const notifyType = (modeDef?.labels?.notifyType ?? USER_CONFIG.labels.execute.notifyType) as "info" | "warning" | "error";
    if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      ctx.ui.notify(notifyText, notifyType);
    }
  }

  /**
   * Exit whatever mode is currently active.
   * Pass silent=true when transitioning between modes (not going all the way to off)
   * to suppress the "Mode OFF" notification.
   */
  function enterOffMode(ctx: ExtensionContext, message?: string, silent = false): void {
    transition("off", pi);
    restoreAllTools();
    applyOffModel(ctx);
    updateStatus(ctx);
    if (!silent && ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      const modeDef = getModeDefinition("off");
      ctx.ui.notify(
        message ?? modeDef?.labels?.notify ?? USER_CONFIG.labels.off.notify,
        message ? "info" : ((modeDef?.labels?.notifyType ?? USER_CONFIG.labels.off.notifyType) as "info" | "warning" | "error"),
      );
    }
  }

  /** Generic entry for user-defined (non-built-in) modes registered via config. */
  function enterCustomMode(ctx: ExtensionContext, name: string): void {
    const modeDef = getModeDefinition(name);
    transition(name, pi);
    if (modeDef?.tools) {
      // Honor allowPlanComplete for custom modes: append plan_complete when set.
      saveAndSetActiveTools(withPlanComplete(name, modeDef.tools));
    } else {
      restoreAllTools();
    }
    applyModeModel(ctx, modeDef);
    updateStatus(ctx);
    if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      const notifyText = modeDef?.labels?.notify ?? `✓ ${name} mode ON`;
      const notifyType = (modeDef?.labels?.notifyType as "info" | "warning" | "error") ?? "info";
      ctx.ui.notify(notifyText, notifyType);
    }
  }

  /** Cleanup plan file on plan_complete, if configured. */
  function cleanupPlanFile(): void {
    if (!USER_CONFIG.cleanup.cleanupOnComplete) return;
    const filePath = getPlanFilePath();
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
    setActivePlanFile(null, pi);
  }

  // ─── Mode picker ───────────────────────────────────────────────────────────

  /** Open the mode picker. Handles all mode transitions including cross-mode switches. */
  async function openModePicker(ctx: ExtensionContext): Promise<void> {
    const current = getMode();
    const planFiles = listPlanFiles();

    // Build mode list dynamically from registry (skip invisible/disabled modes)
    const registryModes = Array.from(MODE_REGISTRY.entries())
      .filter(([_, def]) => def.visible !== false && def.enabled !== false)
      .map(([name, def]) => {
        const isActive = current === name;
        const label = def.labels?.widget || name;
        return { value: name, label: isActive ? `${label.replace(/ active$/, '')}   (active)` : label };
      });
    
    // Always include execute options for plan files — unless the active mode
    // disables the execute handoff via modes.<name>.allowExecute: false.
    const executeItems = executeHandoffAllowed(current)
      ? planFiles.map(f => ({ value: `execute:${f.name}`, label: `Execute: ${f.title}` }))
      : [];
    
    const items: SelectItem[] = [...registryModes, ...executeItems];

    const choice = await showSelectMenu(ctx, "Select mode", items);
    if (!choice) return; // cancelled

    if (choice === "off") {
      if (current === "off") return;
      enterOffMode(ctx);
    } else if (choice === "chat") {
      if (current === "chat") return;
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterChatMode(ctx);
    } else if (choice === "plan") {
      if (current === "plan" || current === "execute") return;
      if (current !== "off") enterOffMode(ctx, undefined, true);
      await promptNameAndEnterPlanMode(ctx);
    } else if (choice.startsWith("execute:")) {
      if (!executeHandoffAllowed(current)) {
        if (ctx.hasUI) ctx.ui.notify(`Plan execution is not available from ${current} mode.`, "warning");
        return;
      }
      const filename = choice.slice("execute:".length);
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterPlanWithFile(filename, pi);
      saveAndSetActiveTools(PLAN_MODE_TOOLS);
      await enterExecuteMode(ctx);
      pi.sendUserMessage("Execute the plan steps now.", { deliverAs: "followUp" });
    } else if (getModeDefinition(choice)) {
      // Custom mode registered via config
      if (current === choice) return;
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterCustomMode(ctx, choice);
    }
  }

  // ─── Re-derive state from entries on the current branch ──────────────────────

  async function syncStateFromBranch(ctx: ExtensionContext, autoResume = false): Promise<void> {
    const branch = ctx.sessionManager.getBranch();
    const restored = restore(branch);

    if (!restored) {
      resetState();
      restoreAllTools();
      applyOffModel(ctx);
      updateStatus(ctx);
      return;
    }

    // Check if active plan file was deleted externally
    const filePath = getPlanFilePath();
    if (getActivePlanFile() && filePath && !existsSync(filePath)) {
      if (ctx.hasUI) ctx.ui.notify(`Plan file "${getActivePlanFile()}" not found — disabling plan mode.`, "warning");
      enterOffMode(ctx);
      return;
    }

    const mode = getMode();
    const modeDef = getModeDefinition(mode);

    if (modeDef?.tools) {
      saveAndSetActiveTools(modeDef.tools);
    } else if (mode === "execute") {
      const allNames = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools([...toolsWithoutPlanComplete(allNames), "plan_complete"]);
    } else {
      // Default: all tools except plan_complete
      const allNames = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools(toolsWithoutPlanComplete(allNames));
    }

    // Apply the mode's model BEFORE sending any resume follow-up message, so
    // execution resumes on the correct model rather than racing the switch.
    await applyModeModel(ctx, modeDef);
    updateStatus(ctx);

    if (mode === "execute" && autoResume) {
      const title = getPlanDisplayTitle();
      const msg = title
        ? `Resuming execution of plan: "${title}". Review the plan in context and continue from where execution left off.`
        : "Resuming plan execution. Review the plan in context and continue from where execution left off.";
      pi.sendUserMessage(msg, { deliverAs: "followUp" });
    }
  }

  // ─── Event: session_start ──────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup") {
      if (pi.getFlag("chat") === true && getMode() === "off") {
        enterChatMode(ctx);
        return;
      }
      if (pi.getFlag("plan") === true && getMode() === "off") {
        enterPlanMode(ctx);
        return;
      }
    }

    await syncStateFromBranch(ctx, event.reason === "resume" || event.reason === "fork");
  });

  // ─── Event: before_agent_start ──────────────────────────────────────────

  pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult => {
    const mode = getMode();
    const modeDef = getModeDefinition(mode);
    
    if (!modeDef) return {};
    
    // Special handling for plan mode with refining
    if (mode === "plan" && getRefining()) {
      const filePath = getPlanFilePath();
      if (filePath && existsSync(filePath)) {
        const planContent = readFileSync(filePath, "utf-8");
        return { systemPrompt: event.systemPrompt + "\n\n" + buildRefinePrompt(planContent) };
      }
    }
    
    // Special handling for execute mode with plan content
    if (mode === "execute") {
      const filePath = getPlanFilePath();
      if (!filePath || !existsSync(filePath)) return {};
      const planContent = readFileSync(filePath, "utf-8");
      const customTemplate = modeDef.prompt;
      if (typeof customTemplate === "string" && customTemplate.trim().length > 0) {
        // User-configured template via modes.execute.prompt — {plan} is replaced with the plan file content.
        const filled = customTemplate.includes("{plan}")
          ? customTemplate.replace("{plan}", planContent)
          : `${customTemplate}\n\nPlan:\n${planContent}`;
        return { systemPrompt: event.systemPrompt + "\n\n" + filled };
      }
      return { systemPrompt: event.systemPrompt + "\n\n" + buildExecutePrompt(planContent) };
    }
    
    // Generic mode prompt from registry
    if (modeDef.prompt) {
      const promptText = typeof modeDef.prompt === "string" 
        ? modeDef.prompt 
        : modeDef.prompt();
      if (promptText) {
        return { systemPrompt: event.systemPrompt + "\n\n" + promptText };
      }
    }
    
    return {};
  });

  // ─── Event: tool_call ─────────────────────────────────────────────────────

  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult => {
    // plan_complete is only callable in execute mode
    const mode = getMode();
    const modeDef = getModeDefinition(mode);
    if (event.toolName === "plan_complete" && !modeDef?.allowPlanComplete) {
      return {
        block: true,
        reason: `[mode-switcher] plan_complete only available in execute mode. Current mode: ${mode}`,
      };
    }

    // Bash safety check using registry patterns
    if (event.toolName !== "bash") return {};
    if (!modeDef?.safePatterns && !modeDef?.destructivePatterns) return {};

    const command = event.input.command as string;
    
    // Check safe patterns (if defined, command must match at least one)
    if (modeDef.safePatterns && modeDef.safePatterns.length > 0) {
      const matchesSafe = modeDef.safePatterns.some((pattern) => pattern.test(command));
      if (!matchesSafe) {
        return {
          block: true,
          reason: `[mode-switcher] Command blocked — not in safe pattern list for ${mode} mode: ${command}`,
        };
      }
    }

    // Check destructive patterns (if defined, must not match any)
    if (modeDef.destructivePatterns && modeDef.destructivePatterns.length > 0) {
      const matchesDestructive = modeDef.destructivePatterns.some((pattern) => pattern.test(command));
      if (matchesDestructive) {
        return {
          block: true,
          reason: `[mode-switcher] Command blocked — destructive pattern in ${mode} mode: ${command}`,
        };
      }
    }
    
    return {};
  });

  // ─── Tool: plan_complete ────────────────────────────────────────────────────

  pi.registerTool({
    name: "plan_complete",
    label: "Plan Complete",
    description:
      "Signal that all plan steps have been executed. ONLY callable in EXECUTE mode. Call this once after finishing the final step. This exits execute mode. Do NOT call this outside execute mode.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (getMode() !== "execute") {
        return { content: [{ type: "text", text: "plan_complete is only available in execute mode." }], details: undefined };
      }
      cleanupPlanFile();
      enterOffMode(ctx, "Plan implemented. Plan mode OFF.");
      return { content: [{ type: "text", text: "Execute mode exited." }], details: undefined };
    },
  });

  // ─── Event: tool_result (process plan_complete results) ───────────────────

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "plan_complete") return;
    if (getMode() !== "execute") return;
    cleanupPlanFile();
    enterOffMode(ctx, "Plan implemented. Plan mode OFF.");
  });

  // ─── Event: agent_end (extract plan text in PLAN mode; auto-exit execute) ───

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    // If plan_complete was never called, exit execute mode automatically.
    // (If it was called, mode is already "off" here — this check is a no-op.)
    if (getMode() === "execute") {
      enterOffMode(ctx, "Execution complete. Mode OFF.");
      return;
    }

    if (getMode() !== "plan") return;
    if (!ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const text = extractTextFromMessage(lastAssistant as unknown as Record<string, unknown>);
    if (!text) return;

    const planText = extractPlanText(text);
    setRefining(false);

    if (planText) {
      const planDir = ensurePlanDir();
      const activeFile = getActivePlanFile();
      let filename = activeFile;
      if (!filename) {
        const ts = new Date().toISOString().replace(/[T:]/g, "-").slice(0, 16);
        filename = `${PLAN_FILE_PREFIX}${ts}.md`;
        setActivePlanFile(filename, pi);
      }
      const filePath = join(planDir, filename);
      const title = titleFromFilename(filename);
      const content = `# Plan: ${title}\n\n${planText.replace(/^\s*#{1,6}\s*Plan:[^\n]*\n?/, "").trimStart()}\n`;
      writeFileSync(filePath, content, "utf-8");
      updateStatus(ctx);

      await showPlanMenu(ctx);
    } else if (isPlanLike(text)) {
      updateStatus(ctx);
      await showPlanMenu(ctx);
    }
  });

  // ─── Event: session_tree ──────────────────────────────────────────────────

  pi.on("session_tree", async (_event, ctx) => {
    await syncStateFromBranch(ctx);
  });

  // ─── Prompt user for optional plan name ────────────────────────────────────

  async function promptNameAndEnterPlanMode(ctx: ExtensionContext): Promise<boolean> {
    const nameInput = await ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
      const input = new Input();
      input.onSubmit = (value) => done(value);

      const border = new DynamicBorder((s: string) => theme.fg("border", s));
      const label = new Text(theme.fg("text", "Plan name ") + theme.fg("dim", "(optional, leave empty for timestamp)"), 1, 0);
      const indent = 1;

      const container = new Container();
      container.addChild(border);
      container.addChild(new Spacer());
      container.addChild(label);
      container.addChild(new Spacer());
      const indentedInput: Component = {
        render: (w: number) => input.render(w - indent).map((line) => " ".repeat(indent) + line),
        invalidate: () => input.invalidate(),
      };
      container.addChild(indentedInput);
      container.addChild(new Spacer());
      container.addChild(new Text(theme.fg("dim", "enter") + theme.fg("muted", " to submit") + theme.fg("dim", " • ") + theme.fg("dim", "esc") + theme.fg("muted", " to cancel"), 1, 0));
      container.addChild(new Spacer());
      container.addChild(border);

      input.focused = true;

      return {
        render(width: number) { return container.render(width); },
        invalidate() { container.invalidate(); },
        handleInput(data: string) {
          if (data === "\x1b") { done(undefined); return; } // esc
          input.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (nameInput === undefined) return false; // cancelled

    if (nameInput.trim()) {
      const sanitized = sanitizePlanName(nameInput.trim());
      if (!sanitized) {
        if (ctx.hasUI) ctx.ui.notify("Invalid plan name. Use letters, numbers, hyphens, underscores, spaces, and dots only.", "warning");
        return false;
      }
      const filename = `${PLAN_FILE_PREFIX}${sanitized}.md`;
      enterPlanWithFile(filename, pi);
      saveAndSetActiveTools(PLAN_MODE_TOOLS);
      updateStatus(ctx);
      const createTitle = titleFromFilename(filename);
      if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
        ctx.ui.notify(USER_CONFIG.labels.plan.notifyWithTitle.replace("{title}", createTitle), USER_CONFIG.labels.plan.notifyType as "info" | "warning" | "error");
      }
    } else {
      enterPlanMode(ctx);
    }
    return true;
  }

  /** Show the plan action menu: Execute, Refine, Save & Exit, Discard & Exit. */
  async function showPlanMenu(ctx: ExtensionContext): Promise<void> {
    while (true) {
      if (getMode() !== "plan") return;

      const refineCount = getRefineCount();
      const refineLabel = refineCount >= MAX_REFINE_CYCLES
        ? `Refine  (${refineCount} cycles — consider saving)`
        : "Refine";
      const options: SelectItem[] = [
        { value: "execute", label: "Execute" },
        { value: "refine", label: refineLabel },
        { value: "save", label: "Save & Exit" },
        { value: "discard", label: "Discard & Exit" },
      ];

      const choice = await showSelectMenu(ctx, "How'd you like to proceed?", options);

      if (choice === "execute") {
        await enterExecuteMode(ctx);
        pi.sendUserMessage("Execute the plan steps now.", { deliverAs: "followUp" });
        return;
      } else if (choice === "refine") {
        incrementRefineCount();
        setRefining(true);
        updateStatus(ctx);
        return;
      } else if (choice === "save") {
        enterOffMode(ctx, "Plan saved. Plan mode OFF.");
        return;
      } else if (choice === "discard") {
        const confirmOptions: SelectItem[] = [
          { value: "yes", label: "Yes, I am sure" },
          { value: "cancel", label: "Cancel" },
        ];
        const confirmed = await showSelectMenu(ctx, "Are you sure?", confirmOptions, {
          bold: false,
          dimSuffix: " (this will delete the plan file)",
        });

        if (confirmed === "yes") {
          const filePath = getPlanFilePath();
          if (filePath && existsSync(filePath)) unlinkSync(filePath);
          setActivePlanFile(null, pi);
          enterOffMode(ctx, "Plan discarded. Plan mode OFF.");
          return;
        }
        // Cancel — re-show plan menu
      } else {
        // Escaped/cancelled — re-show plan menu (noop, loop continues)
      }
    }
  }

  /** Load an existing plan file and show the action menu. */
  function loadPlanAndShowMenu(ctx: ExtensionContext, filename: string, displayName: string): void {
    enterPlanWithFile(filename, pi);
    saveAndSetActiveTools(PLAN_MODE_TOOLS);
    updateStatus(ctx);
    if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
      ctx.ui.notify(USER_CONFIG.labels.plan.notifyLoaded.replace("{title}", displayName), "info");
    }

    const filePath = join(process.cwd(), PLAN_DIR, filename);
    if (existsSync(filePath)) {
      const planContent = readFileSync(filePath, "utf-8");
      pi.sendMessage({
        customType: "plan-mode",
        content: planContent,
        display: true,
        details: { title: `Active plan: ${displayName}` },
      });
    }
  }

  // ─── Message renderer for plan messages ────────────────────────────────────

  pi.registerMessageRenderer("plan-mode", (message, _options, theme) => {
    const border = new DynamicBorder((s: string) => theme.fg("border", s));
    const container = new Container();
    container.addChild(border);
    container.addChild(new Text(theme.fg("text", "📄 " + (message.content as string).split("\n")[0])));
    const body = (message.content as string).split("\n").slice(1).join("\n");
    if (body) {
      container.addChild(new Spacer());
      container.addChild(new Text(body));
    }
    container.addChild(border);
    return container;
  });

  // ─── Command: /mode [chat|plan|off] ────────────────────────────────────────

  pi.registerCommand("mode", {
    description: "Mode switcher: /mode (open picker) · /mode chat · /mode plan · /mode normal",
    handler: async (args: string, ctx) => {
      const input = args.trim().toLowerCase();

      if (!input) {
        await openModePicker(ctx);
        return;
      }

      if (input === "off" || input === "normal") {
        if (getMode() === "off") {
          if (ctx.hasUI) ctx.ui.notify("Already in normal mode", "info");
          return;
        }
        enterOffMode(ctx);
        return;
      }

      if (input === "chat") {
        if (getMode() === "chat") {
          if (ctx.hasUI) ctx.ui.notify("Already in chat mode", "info");
          return;
        }
        if (getMode() !== "off") enterOffMode(ctx, undefined, true);
        enterChatMode(ctx);
        return;
      }

      if (input === "plan") {
        if (getMode() === "plan" || getMode() === "execute") {
          if (ctx.hasUI) ctx.ui.notify("Already in plan mode", "info");
          return;
        }
        if (getMode() !== "off") enterOffMode(ctx, undefined, true);
        await promptNameAndEnterPlanMode(ctx);
        return;
      }

      if (ctx.hasUI) ctx.ui.notify(`Unknown mode: "${input}". Use: chat, plan, normal`, "warning");
    },
  });

  // ─── Command: /chat [off] (alias) ──────────────────────────────────────────

  pi.registerCommand("chat", {
    description: "Chat mode: /chat (toggle) · /chat off",
    handler: async (args: string, ctx) => {
      const input = args.trim().toLowerCase();

      if (input === "off") {
        if (getMode() === "off") {
          if (ctx.hasUI) ctx.ui.notify("Chat mode is already off", "info");
          return;
        }
        enterOffMode(ctx);
        return;
      }

      if (getMode() === "off") {
        enterChatMode(ctx);
      } else if (getMode() === "chat") {
        enterOffMode(ctx);
      } else {
        // in plan/execute — switch to chat
        enterOffMode(ctx, undefined, true);
        enterChatMode(ctx);
      }
    },
  });

  // ─── Command: /plan [off|<name>] (alias) ───────────────────────────────────

  pi.registerCommand("plan", {
    description: "Plan mode: /plan (toggle) · /plan <name> (load existing or create new) · /plan off",
    handler: async (args: string, ctx) => {
      const input = args.trim();

      if (!input) {
        const current = getMode();
        if (current === "off") {
          const files = listPlanFiles();
          if (files.length === 0) {
            await promptNameAndEnterPlanMode(ctx);
          } else {
            const selectItems: SelectItem[] = [
              { value: "__new__", label: "New plan…" },
              ...files.map((f) => ({ value: f.name, label: f.title })),
            ];
            const choice = await showSelectMenu(ctx, "Select plan", selectItems);
            if (!choice) return;
            if (choice === "__new__") {
              await promptNameAndEnterPlanMode(ctx);
            } else {
              loadPlanAndShowMenu(ctx, choice, titleFromFilename(choice));
              await showPlanMenu(ctx);
            }
          }
        } else if (current === "plan" || current === "execute") {
          enterOffMode(ctx);
        } else {
          // in chat — switch to plan
          enterOffMode(ctx, undefined, true);
          await promptNameAndEnterPlanMode(ctx);
        }
        return;
      }

      if (input.toLowerCase() === "off") {
        if (getMode() === "off") {
          if (ctx.hasUI) ctx.ui.notify("Plan mode is already off", "info");
          return;
        }
        enterOffMode(ctx);
        return;
      }

      // Treat input as plan name: load existing → show menu, or create new → plan mode
      const sanitized = sanitizePlanName(input);
      if (!sanitized) {
        if (ctx.hasUI) ctx.ui.notify("Invalid plan name. Use letters, numbers, hyphens, underscores, spaces, and dots only.", "warning");
        return;
      }
      const filename = `${PLAN_FILE_PREFIX}${sanitized}.md`;
      const filePath = join(process.cwd(), PLAN_DIR, filename);

      if (existsSync(filePath)) {
        if (getMode() !== "off") enterOffMode(ctx, undefined, true);
        loadPlanAndShowMenu(ctx, filename, titleFromFilename(filename));
        await showPlanMenu(ctx);
      } else {
        if (getMode() === "plan" || getMode() === "execute") {
          if (ctx.hasUI) ctx.ui.notify("Already in plan mode", "info");
          return;
        }
        if (getMode() !== "off") enterOffMode(ctx, undefined, true);
        enterPlanWithFile(filename, pi);
        saveAndSetActiveTools(PLAN_MODE_TOOLS);
        updateStatus(ctx);
        if (ctx.hasUI && !USER_CONFIG.ui.hideNotify) {
          ctx.ui.notify(USER_CONFIG.labels.plan.notifyWithTitle.replace("{title}", titleFromFilename(filename)), USER_CONFIG.labels.plan.notifyType as "info" | "warning" | "error");
        }
      }
    },
  });

  // ─── Command: /execute [<name>] ────────────────────────────────────────

  pi.registerCommand("execute", {
    description: "Execute an existing plan: /execute (pick from list) · /execute <name>",
    handler: async (args: string, ctx) => {
      const input = args.trim();
      const current = getMode();

      if (current !== "off" && !executeHandoffAllowed(current)) {
        if (ctx.hasUI) ctx.ui.notify(`Plan execution is not available from ${current} mode.`, "warning");
        return;
      }

      async function startExecute(filename: string): Promise<void> {
        if (current !== "off") enterOffMode(ctx, undefined, true);
        enterPlanWithFile(filename, pi);
        saveAndSetActiveTools(PLAN_MODE_TOOLS);
        await enterExecuteMode(ctx);
        pi.sendUserMessage("Execute the plan steps now.", { deliverAs: "followUp" });
      }

      if (!input) {
        if (current === "execute") {
          if (ctx.hasUI) ctx.ui.notify("Already executing a plan", "info");
          return;
        }
        if (current === "plan" && getActivePlanFile()) {
          await enterExecuteMode(ctx);
          pi.sendUserMessage("Execute the plan steps now.", { deliverAs: "followUp" });
          return;
        }
        const files = listPlanFiles();
        if (files.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No plan files found. Run /plan first.", "warning");
          return;
        }
        if (files.length === 1) {
          await startExecute(files[0].name);
          return;
        }
        const items: SelectItem[] = files.map(f => ({ value: f.name, label: f.title }));
        const choice = await showSelectMenu(ctx, "Select plan to execute", items);
        if (!choice) return;
        await startExecute(choice);
        return;
      }

      const sanitized = sanitizePlanName(input);
      if (!sanitized) {
        if (ctx.hasUI) ctx.ui.notify("Invalid plan name.", "warning");
        return;
      }
      const filename = `${PLAN_FILE_PREFIX}${sanitized}.md`;
      const filePath = join(process.cwd(), PLAN_DIR, filename);
      if (!existsSync(filePath)) {
        if (ctx.hasUI) ctx.ui.notify(`Plan "${input}" not found. Check /plan for available plans.`, "warning");
        return;
      }
      await startExecute(filename);
    },
  });

  // ─── Shortcut: cycle mode ──────────────────────────────────────────────────

  /**
   * Cycle through all enabled, visible modes in registry order (excluding "execute",
   * which requires an active plan and is only entered via the picker).
   */
  function cycleMode(ctx: ExtensionContext): void {
    const current = getMode();
    const order = Array.from(MODE_REGISTRY.entries())
      .filter(([name, def]) => name !== "execute" && def.visible !== false && def.enabled !== false)
      .map(([name]) => name);
    if (order.length === 0) return;

    const idx = order.indexOf(current);
    const next = idx === -1 ? order[0] : order[(idx + 1) % order.length];
    if (next === current) return;

    if (next === "off") {
      enterOffMode(ctx);
    } else if (next === "chat") {
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterChatMode(ctx);
    } else if (next === "plan") {
      if (current === "execute") return; // don't leave an active execution via cycling
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterPlanMode(ctx);
    } else {
      if (current !== "off") enterOffMode(ctx, undefined, true);
      enterCustomMode(ctx, next);
    }
  }

  pi.registerShortcut(USER_CONFIG.shortcuts.cycleMode as KeyId, {
    description: "Cycle through all enabled modes",
    handler: (ctx) => {
      cycleMode(ctx);
    },
  });

  // ─── Flags ─────────────────────────────────────────────────────────────────

  pi.registerFlag("chat", {
    type: "boolean",
    description: "Start in chat mode (read-only conversational)",
  });

  pi.registerFlag("plan", {
    type: "boolean",
    description: "Start in plan mode (read-only, explore and plan)",
  });
}
