// Pure URL/path guards for the browser tool. No Playwright import so tests load it directly.

import { resolve, sep } from "node:path";

/** Normalize a URL, allowing only http/https so file:/data:/javascript: URLs can't
 *  be navigated (file:// + evaluate = local file bytes returned into model context). */
export function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http/https URLs are allowed, got ${parsed.protocol}//`);
  }
  return parsed.href;
}

/** Require a screenshot path to stay within the project directory (guard against
 *  overwriting absolute or parent-relative user files with PNG bytes). */
export function safeScreenshotPath(file: string, cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  const abs = resolve(cwd, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`screenshot path must stay within the project directory: ${file}`);
  }
  return file;
}