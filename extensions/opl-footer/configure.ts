import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

import {
  CONFIGURABLE_SEGMENTS,
  FOOTER_LAYOUT_KEYS,
  getLayoutSegments,
  hasSegmentSeparator,
  loadUserConfig,
  moveLayoutSegment,
  saveUserConfig,
  setLayoutSegment,
  setSegmentSeparator,
  type FooterLayoutKey,
} from "./config.js";
import { nextTabIndex, restoreSelectedItem } from "./configure-navigation.js";

const LAYOUT_LABELS: Record<FooterLayoutKey, string> = {
  row1LeftSegments: "Row 1 left",
  row1RightSegments: "Row 1 right",
  row2LeftSegments: "Row 2 left",
  row2RightSegments: "Row 2 right",
  row3LeftSegments: "Row 3 left",
  row3RightSegments: "Row 3 right",
};

function segmentLabel(segment: string): string {
  return segment.replaceAll("_", " ");
}

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

/** Publish the footer's settings/reorder screen as a tab, once per extension load. */
export function registerFooterConfiguratorTab(onSaved: (ctx: ExtensionContext) => void): void {
  const tab: ConfiguratorTab = {
    id: "opl-footer",
    hotkey: "f",
    label: "Footer",
    create: (api) => createFooterComponent(api, onSaved),
  };

  const holder = globalThis as Record<string, unknown>;
  const registry = holder[CONFIGURATOR_REGISTRY_KEY];
  if (Array.isArray(registry)) {
    if (!registry.some((entry) => entry?.id === "opl-footer")) registry.push(tab);
  } else {
    holder[CONFIGURATOR_REGISTRY_KEY] = [tab];
  }
}

function createFooterComponent(
  api: ConfiguratorTabApi,
  onSaved: (ctx: ExtensionContext) => void,
): ConfiguratorTabComponent {
  const { ctx, tui, theme, done } = api;
  let config = loadUserConfig() ?? {};
  let activeTab = 0;
  let view: "settings" | "reorder" = "settings";
  let reorderIndex = 0;
  let settingsLists: SettingsList[] = [];

  const persist = (next: typeof config, selectedId?: string): boolean => {
    try {
      saveUserConfig(next);
      config = next;
      settingsLists = createSettingsLists();
      if (selectedId) restoreSelectedItem(settingsLists, activeTab, selectedId);
      onSaved(ctx);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save footer config: ${message}`, "error");
      done(undefined);
      return false;
    }
  };

  const save = (id: string, value: string) => {
    const [key, segment, kind] = id.split(":") as [FooterLayoutKey, typeof CONFIGURABLE_SEGMENTS[number], string];
    const next = kind === "separator"
      ? setSegmentSeparator(config, key, segment, value === "shown")
      : setLayoutSegment(config, key, segment, value === "shown");
    persist(next, id);
  };

  const createSettingsLists = (): SettingsList[] => FOOTER_LAYOUT_KEYS.map((key) => {
    const layout = getLayoutSegments(config, key);
    const items: SettingItem[] = CONFIGURABLE_SEGMENTS.flatMap((segment) => {
      const index = layout.indexOf(segment);
      return [
        {
          id: `${key}:${segment}:segment`,
          label: segmentLabel(segment),
          currentValue: index === -1 ? "hidden" : "shown",
          values: ["shown", "hidden"],
        },
        {
          id: `${key}:${segment}:separator`,
          label: `${segmentLabel(segment)} separator`,
          currentValue: hasSegmentSeparator(config, key, segment) ? "shown" : "hidden",
          values: ["shown", "hidden"],
        },
      ];
    });
    return new SettingsList(items, 15, getSettingsListTheme(), save, () => done(undefined));
  });

  const visibleSegments = (): typeof CONFIGURABLE_SEGMENTS[number][] =>
    getLayoutSegments(config, FOOTER_LAYOUT_KEYS[activeTab]!).filter((segment) => CONFIGURABLE_SEGMENTS.includes(segment));

  settingsLists = createSettingsLists();

  return {
    render(width: number) {
      const tabs = FOOTER_LAYOUT_KEYS.map((key, index) =>
        theme.fg(index === activeTab ? "accent" : "dim", `[${LAYOUT_LABELS[key]}]`),
      ).join(" ");
      const header = [
        truncateToWidth(theme.bold("Configure OPL Footer"), width),
        truncateToWidth(tabs, width),
      ];
      if (view === "settings") {
        return [
          ...header,
          truncateToWidth(theme.fg("dim", "←/→ switch layout · r reorder · Changes apply immediately"), width),
          ...settingsLists[activeTab]!.render(width),
        ];
      }

      const segments = visibleSegments();
      reorderIndex = Math.min(reorderIndex, Math.max(0, segments.length - 1));
      const rows = segments.length === 0
        ? [theme.fg("dim", "No visible standard segments.")]
        : segments.map((segment, index) => {
          const text = `${index === reorderIndex ? "›" : " "} ${segmentLabel(segment)}${hasSegmentSeparator(config, FOOTER_LAYOUT_KEYS[activeTab]!, segment) ? " + separator" : ""}`;
          return index === reorderIndex ? theme.fg("accent", text) : text;
        });
      return [
        ...header,
        truncateToWidth(theme.fg("dim", "↑/↓ select · ,/. move · r settings · esc close"), width),
        ...rows.map((row) => truncateToWidth(row, width)),
      ];
    },
    invalidate() { settingsLists.forEach((list) => list.invalidate()); },
    handleInput(data: string) {
      if (matchesKey(data, Key.left)) {
        activeTab = nextTabIndex(activeTab, "left", FOOTER_LAYOUT_KEYS.length);
        reorderIndex = 0;
      } else if (matchesKey(data, Key.right)) {
        activeTab = nextTabIndex(activeTab, "right", FOOTER_LAYOUT_KEYS.length);
        reorderIndex = 0;
      } else if (view === "reorder") {
        const segments = visibleSegments();
        if (data === "r") view = "settings";
        else if (matchesKey(data, Key.escape)) done(undefined);
        else if (matchesKey(data, Key.up) && segments.length > 0) reorderIndex = (reorderIndex + segments.length - 1) % segments.length;
        else if (matchesKey(data, Key.down) && segments.length > 0) reorderIndex = (reorderIndex + 1) % segments.length;
        else if ((data === "," || data === ".") && segments[reorderIndex]) {
          const next = moveLayoutSegment(config, FOOTER_LAYOUT_KEYS[activeTab]!, segments[reorderIndex]!, data === "," ? "up" : "down");
          if (next !== config && persist(next)) {
            reorderIndex = data === "," ? Math.max(0, reorderIndex - 1) : Math.min(segments.length - 1, reorderIndex + 1);
          }
        }
      } else if (data === "r") {
        view = "reorder";
        reorderIndex = 0;
      } else {
        settingsLists[activeTab]!.handleInput?.(data);
      }
      tui.requestRender();
    },
  };
}