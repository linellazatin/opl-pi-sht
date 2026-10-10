import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

import { readInputConfig, saveInputConfig, type EditableInputConfig } from "./config.js";

// The configurator seam. opl-configurator owns the /configurator command and reads this
// globalThis array lazily; the entry shape is duplicated by hand on both sides because
// install.sh copies one extension directory at a time.
export const CONFIGURATOR_REGISTRY_KEY = "__oplConfiguratorTabs";

/** What the configurator shell hands to each tab's factory. */
export interface ConfiguratorTabApi {
  ctx: ExtensionContext;
  tui: { requestRender(): void };
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (result: void) => void;
}

export interface ConfiguratorTabComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
}

interface ConfiguratorTab {
  id: string;
  hotkey: string;
  label: string;
  create: (api: ConfiguratorTabApi) => ConfiguratorTabComponent;
}

const BASE_COMPANION_TYPES = ["cat", "dog", "bunny"];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function declaredCompanionTypes(companion: Record<string, unknown>): string[] {
  const types = companion.types;
  if (!Array.isArray(types)) return [];
  return unique(
    types
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => entry.typeName)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function companionRecord(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.companion === "object" && config.companion !== null && !Array.isArray(config.companion)
    ? (config.companion as Record<string, unknown>)
    : {};
}

/** Built-ins plus any declared typeName and the live selection, in that order, deduped. */
export function companionTypeValues(config: Record<string, unknown>): string[] {
  const companion = companionRecord(config);
  const currentType = typeof companion.type === "string" && companion.type.length > 0 ? companion.type : "cat";
  return unique([...BASE_COMPANION_TYPES, ...declaredCompanionTypes(companion), currentType]);
}

/** Map a setting item id to its write patch; null for an id the tab does not own. */
export function inputFieldPatch(id: string, value: string): EditableInputConfig | null {
  if (id === "boxedView") return { boxedView: value === "true" };
  if (id === "companion.enabled") return { companion: { enabled: value === "true" } };
  if (id === "companion.type") return { companion: { type: value } };
  return null;
}

/** Publish the input settings screen as a tab, once per extension load. */
export function registerInputConfiguratorTab(): void {
  const tab: ConfiguratorTab = {
    id: "opl-input",
    hotkey: "i",
    label: "Input",
    create: (api) => createInputComponent(api),
  };

  const holder = globalThis as Record<string, unknown>;
  const registry = holder[CONFIGURATOR_REGISTRY_KEY];
  if (Array.isArray(registry)) {
    if (!registry.some((entry) => entry?.id === "opl-input")) registry.push(tab);
  } else {
    holder[CONFIGURATOR_REGISTRY_KEY] = [tab];
  }
}

function createInputComponent(api: ConfiguratorTabApi): ConfiguratorTabComponent {
  const { ctx, theme, done } = api;
  let config = readInputConfig();
  let settingsList: SettingsList | null = null;

  const createSettingsList = (): SettingsList => {
    const companion = companionRecord(config);
    const boxedView = typeof config.boxedView === "boolean" ? config.boxedView : true;
    const enabled = typeof companion.enabled === "boolean" ? companion.enabled : false;
    const currentType = typeof companion.type === "string" && companion.type.length > 0 ? companion.type : "cat";

    const typeValues = companionTypeValues(config);

    const items: SettingItem[] = [
      { id: "boxedView", label: "Boxed view", currentValue: boxedView ? "true" : "false", values: ["true", "false"] },
      { id: "companion.enabled", label: "Companion", currentValue: enabled ? "true" : "false", values: ["true", "false"] },
      { id: "companion.type", label: "Companion type", currentValue: currentType, values: typeValues },
    ];

    return new SettingsList(items, items.length, getSettingsListTheme(), save, () => done(undefined));
  };

  const save = (id: string, value: string) => {
    const patch = inputFieldPatch(id, value);
    if (!patch) return; // never misroute an unexpected id into companion.type

    try {
      const changed = saveInputConfig(patch);
      if (changed) {
        config = readInputConfig();
        settingsList = createSettingsList();
        settingsList.selectItem(id);
        ctx.ui.notify("opl-input saved. Run /reload (or restart Pi) to apply.", "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save opl-input config: ${message}`, "error");
      done(undefined);
    }
  };

  settingsList = createSettingsList();

  return {
    render(width: number) {
      return [
        truncateToWidth(theme.bold("Configure OPL Input"), width),
        truncateToWidth(theme.fg("dim", "Reload (/reload) is required for changes to apply"), width),
        ...(settingsList ?? createSettingsList()).render(width),
      ];
    },
    invalidate() { settingsList?.invalidate(); },
    handleInput(data: string) { settingsList?.handleInput?.(data); },
  };
}