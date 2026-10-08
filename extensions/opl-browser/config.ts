import * as fs from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BrowserConfig {
  headless: boolean;
  width: number;
  height: number;
  navigationTimeoutMs: number;
  previewChars: number;
  getChars: number;
  /** Allow navigate/new_page to reach private/link-local ranges (default false).
   *  Cloud metadata is always blocked. */
  allowPrivateNetwork: boolean;
  /** Allow loopback hosts — localhost, 127.0.0.0/8, ::1 (default true, for local dev
   *  servers). Cloud metadata is unaffected. */
  allowLoopback: boolean;
}

export const DEFAULT_CONFIG: BrowserConfig = {
  headless: true,
  width: 1280,
  height: 800,
  navigationTimeoutMs: 30000,
  previewChars: 4000,
  getChars: 30000,
  allowPrivateNetwork: false,
  allowLoopback: true,
};

/** Resolved per call so a custom `PI_AGENT_DIR` (pi's own agent dir) is honoured. */
export function configPath(): string {
  return join(getAgentDir(), "configs", "opl-browser.json");
}

export function loadUserConfig(file = configPath()): BrowserConfig {
  let user: Partial<BrowserConfig> = {};
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    user = {};
  }
  return {
    headless: user.headless ?? DEFAULT_CONFIG.headless,
    width: user.width ?? DEFAULT_CONFIG.width,
    height: user.height ?? DEFAULT_CONFIG.height,
    navigationTimeoutMs: user.navigationTimeoutMs ?? DEFAULT_CONFIG.navigationTimeoutMs,
    previewChars: user.previewChars ?? DEFAULT_CONFIG.previewChars,
    getChars: user.getChars ?? DEFAULT_CONFIG.getChars,
    allowPrivateNetwork: user.allowPrivateNetwork ?? DEFAULT_CONFIG.allowPrivateNetwork,
    allowLoopback: user.allowLoopback ?? DEFAULT_CONFIG.allowLoopback,
  };
}
