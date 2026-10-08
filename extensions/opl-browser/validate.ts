// Pure URL/path guards for the browser tool. No Playwright import so tests load it directly.

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promises as dns } from "node:dns";

export interface HttpUrlOptions {
  /** Allow private, link-local, and reserved network hosts (default false). Cloud metadata is always blocked. */
  allowPrivateNetwork?: boolean;
  /** Allow loopback hosts — localhost, 127.0.0.0/8, ::1 (default true). */
  allowLoopback?: boolean;
  /** Test seam for host resolution; production callers leave it unset and use node:dns. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Caller's abort signal. The lookup itself cannot be cancelled, so this only bounds how long
   *  the caller waits; without it a stalled getaddrinfo outlives the caller's own timeout. */
  signal?: AbortSignal;
  /** Self-bound for the DNS round-trip when the caller passes no signal (ms). */
  dnsTimeoutMs?: number;
}

// BEGIN SHARED HOST GUARD — mirrored verbatim from extensions/opl-webaccess/utils.ts
// (install.sh installs one extension directory at a time, so this cannot be a shared import;
//  tests/net-guard-parity.test.mjs fails if the two copies drift)
/** Well-known cloud metadata hostnames that resolve to instance-credential endpoints. */
const BLOCKED_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Cloud metadata IPv6 literals (e.g. AWS IMDS over IPv6). Always blocked. */
const BLOCKED_METADATA_V6 = new Set(["fd00:ec2::254"]);

type HostClass = "loopback" | "metadata" | "unspecified" | "private" | "public";

/** Decode a bare unsigned 32-bit integer hostname (e.g. 2130706433) into octets. */
function ipv4FromInteger(n: number): number[] | null {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Parse a host into IPv4 octets (dotted-quad or integer form), or null when not an IPv4 literal. */
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
    (o[0] === 169 && o[1] === 254 && o[2] === 169 && o[3] === 254) || // AWS/Azure/GCP/Oracle
    (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) // Alibaba
  );
}

/** Non-globally-routable (blocked by default, opt-in via allowPrivateNetwork). */
function isPrivateIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 10 || // 10/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) || // 169.254/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24, 192.0.2/24
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
    (a === 198 && b === 51 && c === 100) || // 198.51.100/24
    (a === 203 && b === 0 && c === 113) || // 203.0.113/24
    a >= 224 // 224/4 multicast and 240/4 reserved
  );
}

/** "This host on this network" (0.0.0.0/8, ::) — reaching it means reaching local listeners,
 * so it is never toggleable the way cloud metadata is not. */
function isUnspecifiedIpv4(o: number[]): boolean {
  return o[0] === 0;
}

/** Decode IPv4 from an IPv4-mapped IPv6 literal (::ffff:a.b.c.d or ::ffff:hex:hex). */
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
  if (isUnspecifiedIpv4(o)) return "unspecified";
  if (isPrivateIpv4(o)) return "private";
  return "public";
}

function classifyIpv6Host(host: string): HostClass {
  const ip = host.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  if (BLOCKED_METADATA_V6.has(ip)) return "metadata";
  if (ip === "::1") return "loopback";
  const mapped = ipv4MappedOctets(ip);
  if (mapped) return classifyIpv4Octets(mapped);
  if (ip === "::") return "unspecified";
  if (/^f[cd]/.test(ip)) return "private"; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return "private"; // fe80::/10 link-local
  if (/^ff/.test(ip)) return "private"; // ff00::/8 multicast
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

function isBlockedNetworkHost(host: string, allowPrivateNetwork: boolean, allowLoopback: boolean): boolean {
  const cls = classifyHost(host);
  if (cls === "metadata" || cls === "unspecified") return true; // never toggleable
  if (cls === "loopback") return !allowLoopback;
  if (cls === "public") return false;
  return !allowPrivateNetwork; // private / link-local / reserved
}

/**
 * Normalize a URL, allowing only http/https. Loopback (localhost/127.0.0.0/8/::1) is
 * allowed by default for local development and gated by allowLoopback; private/link-local/
 * reserved ranges are blocked unless allowPrivateNetwork is set; cloud metadata is always blocked.
 */
export function assertHttpUrl(url: string, opts: HttpUrlOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs are allowed, "${parsed.protocol}"`);
  }
  if (isBlockedNetworkHost(parsed.hostname, opts.allowPrivateNetwork === true, opts.allowLoopback !== false)) {
    throw new Error(`Blocked network host "${parsed.hostname}" — private, link-local, and reserved URLs are not allowed (set allowPrivateNetwork to opt in to private ranges; cloud-metadata and unspecified addresses such as 0.0.0.0 are always blocked)`);
  }
  return parsed.href;
}

export function isIpLiteralHost(host: string): boolean {
  const lowered = host.toLowerCase().replace(/^\[|\]$/g, "");
  return lowered.includes(":") || /^\d+$/.test(lowered) || /^\d{1,3}(\.\d{1,3}){3}$/.test(lowered);
}

/** In-flight lookups by host. A page with hundreds of subresources on one host would otherwise
 *  serialize hundreds of getaddrinfo calls on libuv's small thread pool. Entries are dropped as
 *  soon as the lookup settles, so this deduplicates concurrency only: no decision is reused, and
 *  a hostname that changes between two calls still gets two independent answers. */
const inflightLookups = new Map<string, Promise<string[]>>();

/** Default resolver. Rethrows the original error so `.code` survives for callers. */
export function resolveHostAddresses(host: string): Promise<string[]> {
  const running = inflightLookups.get(host);
  if (running) return running;
  const pending = dns
    .lookup(host, { all: true, verbatim: true })
    .then((hits) => hits.map((hit) => hit.address));
  inflightLookups.set(host, pending);
  const stop = () => {
    if (inflightLookups.get(host) === pending) inflightLookups.delete(host);
  };
  pending.then(stop, stop);
  return pending;
}

/** Reject as soon as the caller gives up. `dns.lookup` cannot be cancelled, so without this a
 *  stalled getaddrinfo would hold the tool past its own timeout. */
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([pending, aborted]);
}

/**
 * Same policy as assertHttpUrl, plus a DNS round-trip: a hostname that answers with a
 * loopback, private, link-local, reserved, or metadata address is rejected before any
 * request is made. Literal-IP hosts skip the lookup. Text-only classification is not enough
 * on its own — `http://169.254.169.254.nip.io/` reads as a public hostname.
 */
export async function assertSafeHttpUrl(url: string, opts: HttpUrlOptions = {}): Promise<string> {
  const normalized = assertHttpUrl(url, opts);
  const host = new URL(normalized).hostname;
  if (isIpLiteralHost(host)) return normalized; // already classified; no DNS round-trip
  // A stalled getaddrinfo must not outlive the caller's own budget, and with no caller signal
  // (a browser route handler, a frame re-check) the guard bounds itself instead of hanging.
  const dnsSignal = opts.signal ?? (opts.dnsTimeoutMs ? AbortSignal.timeout(opts.dnsTimeoutMs) : undefined);
  const answers = opts.resolveHost
    ? await untilAborted(Promise.resolve(opts.resolveHost(host)), dnsSignal)
    : await untilAborted(resolveHostAddresses(host), dnsSignal);
  if (!answers.length) throw new Error(`Could not resolve host "${host}"`);
  const allowPrivate = opts.allowPrivateNetwork === true;
  const allowLoopback = opts.allowLoopback !== false;
  for (const answer of answers) {
    if (isBlockedNetworkHost(answer, allowPrivate, allowLoopback)) {
      throw new Error(`Blocked network host "${host}" — it resolves to ${answer}, and private, link-local, and reserved addresses are not allowed (set allowPrivateNetwork to opt in to private ranges; cloud-metadata and unspecified addresses such as 0.0.0.0 are always blocked)`);
    }
  }
  return normalized;
}
// END SHARED HOST GUARD

const NON_HTTP = /^(data|blob|about|chrome|chrome-extension|devtools|view-source):/i;

/**
 * Route-level decision for requests a page makes on its own (subresources, scripts,
 * popups, JS-driven redirects). Only ENOTFOUND fails open: a genuinely missing host
 * cannot be reached by the page either, while any other resolver failure could be
 * hiding an internal answer and must abort.
 */
export async function decideSubresource(url: string, opts: HttpUrlOptions = {}): Promise<"continue" | "abort"> {
  if (NON_HTTP.test(url)) return "continue";
  try {
    await assertSafeHttpUrl(url, opts);
    return "continue";
  } catch (err) {
    return (err as { code?: string })?.code === "ENOTFOUND" ? "continue" : "abort";
  }
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