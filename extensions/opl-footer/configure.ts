import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

import {
  CONFIGURABLE_SEGMENTS,
  FOOTER_LAYOUT_KEYS,
  getLayoutSegments,
  hasSegmentSeparator,
  loadUserConfig,
  saveUserConfig,
  setLayoutSegment,
  setSegmentSeparator,
  type FooterLayoutKey,
} from "./config.js";
import { nextTabIndex } from "./configure-navigation.js";

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

export async function showFooterConfigurator(ctx: ExtensionContext, onSaved: () => void): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/configure-opl requires TUI mode", "error");
    return;
  }

  let config = loadUserConfig() ?? {};
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let activeTab = 0;
    let settingsLists: SettingsList[] = [];

    const save = (id: string, value: string) => {
      const [key, segment, kind] = id.split(":") as [FooterLayoutKey, typeof CONFIGURABLE_SEGMENTS[number], string];
      const next = kind === "separator"
        ? setSegmentSeparator(config, key, segment, value === "shown")
        : setLayoutSegment(config, key, segment, value === "shown");
      try {
        saveUserConfig(next);
        config = next;
        settingsLists = createSettingsLists();
        onSaved();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save footer config: ${message}`, "error");
        done(undefined);
      }
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
      return new SettingsList(items, 15, getSettingsListTheme(), save, () => done(undefined), { enableSearch: true });
    });

    settingsLists = createSettingsLists();

    return {
      render(width: number) {
        const tabs = FOOTER_LAYOUT_KEYS.map((key, index) =>
          theme.fg(index === activeTab ? "accent" : "dim", `[${LAYOUT_LABELS[key]}]`),
        ).join(" ");
        return [
          truncateToWidth(theme.bold("Configure OPL Footer"), width),
          truncateToWidth(tabs, width),
          truncateToWidth(theme.fg("dim", "←/→ switch layout · Changes apply immediately"), width),
          ...settingsLists[activeTab]!.render(width),
        ];
      },
      invalidate() { settingsLists.forEach((list) => list.invalidate()); },
      handleInput(data: string) {
        if (matchesKey(data, Key.left)) activeTab = nextTabIndex(activeTab, "left", FOOTER_LAYOUT_KEYS.length);
        else if (matchesKey(data, Key.right)) activeTab = nextTabIndex(activeTab, "right", FOOTER_LAYOUT_KEYS.length);
        else settingsLists[activeTab]!.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
