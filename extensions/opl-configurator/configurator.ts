import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// The configurator seam. Instrumented extensions publish entries on this
// globalThis array; the shell reads it lazily when /configurator runs, so
// extension load order does not matter. The entry shape is duplicated by hand
// on the publishing side (e.g. opl-footer/configure.ts) because install.sh
// copies one extension directory at a time and cross-directory imports are
// forbidden.
export const CONFIGURATOR_REGISTRY_KEY = "__oplConfiguratorTabs";

/** What the shell hands to a tab's factory. */
export interface ConfiguratorTabApi {
  ctx: ExtensionContext;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (result: void) => void;
}

/** A component with the same contract as ctx.ui.custom's return value. */
export interface ConfiguratorTabComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
}

export interface ConfiguratorTab {
  /** Unique extension id, e.g. "opl-footer". */
  id: string;
  /** Single lowercase letter that focuses this tab from anywhere in the shell. */
  hotkey: string;
  /** Short tab-bar label, e.g. "Footer". */
  label: string;
  create: (api: ConfiguratorTabApi) => ConfiguratorTabComponent;
}

function isConfiguratorTab(value: unknown): value is ConfiguratorTab {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.hotkey === "string" &&
    /^[a-z]$/.test(entry.hotkey) &&
    typeof entry.label === "string" &&
    entry.label.length > 0 &&
    typeof entry.create === "function"
  );
}

/** Read the registry, dropping malformed entries and duplicate ids/hotkeys. */
export function readConfiguratorTabs(): ConfiguratorTab[] {
  const raw = (globalThis as Record<string, unknown>)[CONFIGURATOR_REGISTRY_KEY];
  if (!Array.isArray(raw)) return [];

  const tabs: ConfiguratorTab[] = [];
  const seenIds = new Set<string>();
  const seenHotkeys = new Set<string>();
  for (const entry of raw) {
    if (!isConfiguratorTab(entry)) continue;
    if (seenIds.has(entry.id) || seenHotkeys.has(entry.hotkey)) continue;
    seenIds.add(entry.id);
    seenHotkeys.add(entry.hotkey);
    tabs.push(entry);
  }
  return tabs;
}

export async function showConfigurator(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/configurator requires TUI mode", "error");
    return;
  }

  const tabs = readConfiguratorTabs();
  if (tabs.length === 0) {
    ctx.ui.notify("Nothing exposes a /configurator tab yet", "error");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const built: Array<{ tab: ConfiguratorTab; component: ConfiguratorTabComponent }> = [];
    for (const tab of tabs) {
      try {
        const component = tab.create({ ctx, tui, theme, keybindings, done });
        if (component && typeof component.render === "function") built.push({ tab, component });
      } catch {
        // A broken tab must not take the whole configurator down.
      }
    }

    if (built.length === 0) {
      return {
        render: (width: number) => [truncateToWidth(theme.fg("dim", "No instrumented extensions could be loaded."), width)],
        invalidate() {},
      };
    }

    let activeIndex = 0;
    const clamp = () => {
      activeIndex = Math.min(activeIndex, built.length - 1);
    };

    const focusByHotkey = (data: string): boolean => {
      if (data.length !== 1) return false;
      const key = data.toLowerCase();
      const index = built.findIndex(({ tab }) => tab.hotkey === key);
      if (index === -1) return false;
      activeIndex = index;
      return true;
    };

    return {
      render(width: number) {
        clamp();
        const tabBar = built
          .map(({ tab }, index) => theme.fg(index === activeIndex ? "accent" : "dim", `[${tab.hotkey}] ${tab.label}`))
          .join("  ");
        const active = built[activeIndex]!;
        return [
          truncateToWidth(theme.bold("OPL Configurator"), width),
          truncateToWidth(tabBar, width),
          truncateToWidth(theme.fg("dim", "tab hotkey switch · esc close"), width),
          ...active.component.render(width),
        ];
      },
      invalidate() {
        clamp();
        built[activeIndex]?.component.invalidate?.();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          done(undefined);
          return;
        }
        if (focusByHotkey(data)) {
          tui.requestRender();
          return;
        }
        clamp();
        built[activeIndex]?.component.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}