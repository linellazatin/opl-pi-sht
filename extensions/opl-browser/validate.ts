// Pure URL/path guards for the browser tool. No Playwright import so tests load it directly.

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface HttpUrlOptions {
  /** Allow private, link-local, and reserved network hosts (default false). Loopback is always allowed; cloud metadata is always blocked. */
  allowPrivateNetwork?: boolean;
}

/** Well-known cloud metadata hostnames that resolve to instance-credential endpoints. */
const BLOCKED_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Cloud metadata IPv6 literals (e.g. AWS IMDS over IPv6). Always blocked. */
const BLOCKED_METADATA_V6 = new Set(["fd00:ec2::254"]);

type HostClass = "loopback" | "metadata" | "private" | "public";

function ipv4FromInteger(n: number): number[] | null {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function ipv4Octets(host: string): number[] | null {
  if (/^\d+$/.test(host)) return ipv4FromInteger(Number(host));
  const octets = host.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

function isLoopbackIpv4(o: number[]): boolean {
  return o[0] === 127;
}

function isMetadataIpv4(o: number[]): boolean {
  return (
    (o[0] === 169 && o[1] === 254 && o[2] === 169 && o[3] === 254) ||
    (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200)
  );
}

function isPrivateIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv4MappedOctets(ip: string): number[] | null {
  const dotted = ip.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) return dotted.slice(1).map(Number);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  return null;
}

function classifyIpv4Octets(o: number[]): HostClass {
  if (isLoopbackIpv4(o)) return "loopback";
  if (isMetadataIpv4(o)) return "metadata";
  if (isPrivateIpv4(o)) return "private";
  return "public";
}

function classifyIpv6Host(host: string): HostClass {
  const ip = host.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  if (BLOCKED_METADATA_V6.has(ip)) return "metadata";
  if (ip === "::1") return "loopback";
  const mapped = ipv4MappedOctets(ip);
  if (mapped) return classifyIpv4Octets(mapped);
  if (ip === "::") return "private";
  if (/^f[cd]/.test(ip)) return "private";
  if (/^fe[89ab]/.test(ip)) return "private";
  if (/^ff/.test(ip)) return "private";
  return "public";
}

function classifyHost(host: string): HostClass {
  const lowered = host.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(lowered)) return "metadata";
  if (lowered === "localhost" || lowered.endsWith(".localhost")) return "loopback";
  if (lowered.includes(":")) return classifyIpv6Host(lowered);
  const octets = ipv4Octets(lowered);
  return octets ? classifyIpv4Octets(octets) : "public";
}

function isBlockedNetworkHost(host: string, allowPrivateNetwork: boolean): boolean {
  const cls = classifyHost(host);
  if (cls === "metadata") return true;
  if (cls === "loopback" || cls === "public") return false;
  return !allowPrivateNetwork;
}

/**
 * Normalize a URL, allowing only http/https, so `file:`/`data:`/`javascript:` URLs and SSRF
 * targets can't be navigated (file:// + evaluate = local file bytes returned into model context).
 * Loopback is allowed by default for local development; private/link-local/reserved ranges are
 * blocked unless allowPrivateNetwork is set; cloud metadata is always blocked.
 */
export function assertHttpUrl(url: string, opts: HttpUrlOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http/https URLs are allowed, got ${parsed.protocol}//`);
  }
  if (isBlockedNetworkHost(parsed.hostname, opts.allowPrivateNetwork === true)) {
    throw new Error(`blocked network host "${parsed.hostname}" — private, link-local, reserved, and cloud-metadata URLs are not allowed (set allowPrivateNetwork to opt in to private ranges; metadata is always blocked)`);
  }
  return parsed.href;
}

/** Require a screenshot path to stay within the project directory and refuse to overwrite
 *  existing files (guard against overwriting project files or writing outside the repo). */
export function safeScreenshotPath(file: string, cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  const abs = resolve(cwd, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`screenshot path must stay within the project directory: ${file}`);
  }
  if (!/\.(png|jpe?g)$/i.test(file)) {
    throw new Error(`screenshot path must end in .png or .jpg: ${file}`);
  }
  if (existsSync(abs)) {
    throw new Error(`screenshot path already exists (refusing to overwrite): ${file}`);
  }
  return file;
}