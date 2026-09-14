import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FooterUserConfig, StatusLineSegmentId, ColorScheme, StatusLineSegmentOptions } from "./types.js";
import { getDefaultColors } from "./theme.js";
import type { IconSet } from "./icons.js";

// Default segment configuration — two rows
const DEFAULT_ROW1_LEFT: StatusLineSegmentId[] = ["pi", "separator", "model", "separator", "path", "git"];
const DEFAULT_ROW1_RIGHT: StatusLineSegmentId[] = ["context_pct"];
const DEFAULT_ROW2_LEFT: StatusLineSegmentId[] = ["thinking", "separator", "caveman", "separator", "mode_switcher"];
const DEFAULT_ROW2_RIGHT: StatusLineSegmentId[] = ["token_total", "separator", "cost"];
const DEFAULT_ROW3_LEFT: StatusLineSegmentId[] = ["session_stats"];
const DEFAULT_ROW3_RIGHT: StatusLineSegmentId[] = ["perf_stats"];

export type FooterLayoutKey =
  | "row1LeftSegments" | "row1RightSegments"
  | "row2LeftSegments" | "row2RightSegments"
  | "row3LeftSegments" | "row3RightSegments";

export const FOOTER_LAYOUT_KEYS: FooterLayoutKey[] = [
  "row1LeftSegments", "row1RightSegments",
  "row2LeftSegments", "row2RightSegments",
  "row3LeftSegments", "row3RightSegments",
];

export const CONFIGURABLE_SEGMENTS: StatusLineSegmentId[] = [
  "pi", "model", "path", "git", "thinking", "caveman", "plan_mode",
  "chat_mode", "mode_switcher", "token_in", "token_out", "token_total",
  "cache_read", "cache_write", "cost", "context_pct", "context_total",
  "session_stats", "perf_stats", "separator",
];

const DEFAULT_LAYOUTS: Record<FooterLayoutKey, StatusLineSegmentId[]> = {
  row1LeftSegments: DEFAULT_ROW1_LEFT,
  row1RightSegments: DEFAULT_ROW1_RIGHT,
  row2LeftSegments: DEFAULT_ROW2_LEFT,
  row2RightSegments: DEFAULT_ROW2_RIGHT,
  row3LeftSegments: DEFAULT_ROW3_LEFT,
  row3RightSegments: DEFAULT_ROW3_RIGHT,
};

const DEFAULT_SEGMENT_OPTIONS: StatusLineSegmentOptions = {
  path: { mode: "full" },
  git: {
    showBranch: true,
    showStaged: true,
    showUnstaged: true,
    showUntracked: true,
  },
};

// Cache for user config
let userConfigCache: FooterUserConfig | null = null;
let userConfigCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

function getConfigPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return join(homeDir, ".pi", "agent", "configs", "opl-footer.json");
}

export function loadUserConfig(): FooterUserConfig | null {
  const now = Date.now();
  if (userConfigCache && now - userConfigCacheTime < CACHE_TTL) {
    return userConfigCache;
  }

  const configPath = getConfigPath();
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      userConfigCache = parsed as FooterUserConfig;
      userConfigCacheTime = now;
      return userConfigCache;
    }
  } catch {
    // Ignore errors, return null
  }

  userConfigCache = null;
  userConfigCacheTime = now;
  return null;
}

export function clearUserConfigCache(): void {
  userConfigCache = null;
  userConfigCacheTime = 0;
}

export function getLayoutSegments(config: FooterUserConfig, key: FooterLayoutKey): StatusLineSegmentId[] {
  const segments = config[key];
  return Array.isArray(segments) ? segments : DEFAULT_LAYOUTS[key];
}

export function setLayoutSegment(
  config: FooterUserConfig,
  key: FooterLayoutKey,
  segment: StatusLineSegmentId,
  shown: boolean,
): FooterUserConfig {
  const current = getLayoutSegments(config, key);
  if (shown && current.includes(segment)) return config;

  const next = current.filter((item) => item !== segment);
  if (shown) {
    const order = CONFIGURABLE_SEGMENTS.indexOf(segment);
    const insertAt = next.findIndex((item) => CONFIGURABLE_SEGMENTS.indexOf(item) > order);
    next.splice(insertAt === -1 ? next.length : insertAt, 0, segment);
  }
  return { ...config, [key]: next };
}

export function saveUserConfig(config: FooterUserConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  clearUserConfigCache();
}

export function getEffectiveConfig(): {
  row1LeftSegments: StatusLineSegmentId[];
  row1RightSegments: StatusLineSegmentId[];
  row2LeftSegments: StatusLineSegmentId[];
  row2RightSegments: StatusLineSegmentId[];
  row3LeftSegments: StatusLineSegmentId[];
  row3RightSegments: StatusLineSegmentId[];
  colors: ColorScheme;
  segmentOptions: StatusLineSegmentOptions;
  icons: Partial<IconSet>;
} {
  const userConfig = loadUserConfig();

  return {
    row1LeftSegments: getLayoutSegments(userConfig ?? {}, "row1LeftSegments"),
    row1RightSegments: getLayoutSegments(userConfig ?? {}, "row1RightSegments"),
    row2LeftSegments: getLayoutSegments(userConfig ?? {}, "row2LeftSegments"),
    row2RightSegments: getLayoutSegments(userConfig ?? {}, "row2RightSegments"),
    row3LeftSegments: getLayoutSegments(userConfig ?? {}, "row3LeftSegments"),
    row3RightSegments: getLayoutSegments(userConfig ?? {}, "row3RightSegments"),
    colors: userConfig?.colors ?? getDefaultColors(),
    segmentOptions: {
      ...DEFAULT_SEGMENT_OPTIONS,
      ...userConfig?.segmentOptions,
    },
    icons: userConfig?.icons ?? {},
  };
}
