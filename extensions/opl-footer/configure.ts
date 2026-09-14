import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";

import {
  CONFIGURABLE_SEGMENTS,
  FOOTER_LAYOUT_KEYS,
  getLayoutSegments,
  loadUserConfig,
  saveUserConfig,
  setLayoutSegment,
  type FooterLayoutKey,
} from "./config.js";

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
    const items: SettingItem[] = FOOTER_LAYOUT_KEYS.flatMap((key) =>
      CONFIGURABLE_SEGMENTS.map((segment) => ({
        id: `${key}:${segment}`,
        label: `${LAYOUT_LABELS[key]}: ${segmentLabel(segment)}`,
        currentValue: getLayoutSegments(config, key).includes(segment) ? "shown" : "hidden",
        values: ["shown", "hidden"],
      })),
    );

    const settingsList = new SettingsList(
      items,
      15,
      getSettingsListTheme(),
      (id, value) => {
        const [key, segment] = id.split(":") as [FooterLayoutKey, typeof CONFIGURABLE_SEGMENTS[number]];
        const next = setLayoutSegment(config, key, segment, value === "shown");
        try {
          saveUserConfig(next);
          config = next;
          onSaved();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save footer config: ${message}`, "error");
          done(undefined);
        }
      },
      () => done(undefined),
      { enableSearch: true },
    );

    const container = new Container();
    container.addChild(new Text(
      theme.fg("accent", theme.bold("Configure OPL Footer")) + "\n" +
        theme.fg("dim", "Changes apply immediately. Colors, icons, and text stay in JSON."),
      1,
      1,
    ));
    container.addChild(settingsList);

    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
