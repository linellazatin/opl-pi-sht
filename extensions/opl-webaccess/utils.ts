import { promises as dns } from "node:dns";
import type { PinnedFetchOptions, PinnedResponse } from "./http.js";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("abort") || msg.includes("cancelled");
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    "\n\n[Content truncated. Use get_search_content with the responseId to retrieve the full content.]"
  );
}

export interface ContentPage {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}

/** Slice stored content to one bounded page. Offsets past the end yield empty text. */
export function paginateContent(text: string, offset: number, maxChars: number): ContentPage {
  const totalChars = text.length;
  const safeOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const start = Math.min(Math.max(0, safeOffset), totalChars);
  const end = Math.min(start + maxChars, totalChars);
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars,
    nextOffset: end < totalChars ? end : null,
  };
}

/** Model-facing continuation metadata, empty when the page was complete. */
export function continuationNotice(page: ContentPage): string {
  if (page.nextOffset === null) return "";
  return `\n\n[Content truncated at ${page.offset + page.text.length} of ${page.totalChars} chars. Continue with get_search_content offset=${page.nextOffset}.]`;
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().endsWith(".pdf");
  }
}

export function isPdfContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/pdf");
}

export interface HttpUrlOptions {
  /** Allow private, link-local, and reserved network hosts (default false). Cloud metadata is always blocked. */
  allowPrivateNetwork?: boolean;
  /** Allow loopback hosts — localhost, 127.0.0.0/8, ::1 (default false: opt in). */
  allowLoopback?: boolean;
  /** Deadline for one request (ms), combined with the caller's signal so the shorter
   *  of the two wins. Used by the fetch path; the guard itself ignores it. */
  timeoutMs?: number;
  /** Ceiling on one response body (bytes). The transport stops reading and drops the socket
   *  past it, so an oversized page cannot cost memory before truncation gets a say. */
  maxResponseBytes?: number;
  /** Test seam for host resolution; production callers leave it unset and use node:dns. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Test seam for the socket layer; production callers leave it unset and use pinnedFetch.
   *  The guard still runs - only the connection is replaced. */
  transport?: (target: SafeHttpTarget, opts: PinnedFetchOptions) => Promise<PinnedResponse>;
  /** Caller's abort signal. The lookup itself cannot be cancelled, so this only bounds how long
   *  the caller waits; without it a stalled getaddrinfo outlives the caller's own timeout. */
  signal?: AbortSignal;
  /** Self-bound for the DNS round-trip when the caller passes no signal (ms). */
  dnsTimeoutMs?: number;
}

// BEGIN SHARED HOST GUARD — duplicated verbatim in extensions/opl-browser/validate.ts
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

/** Expand a compressed, dotted-suffix or full IPv6 literal into its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  const sides = ip.split("::");
  if (sides.length > 2) return null;
  const parse = (side: string): number[] | null => {
    if (!side) return [];
    const out: number[] = [];
    for (const part of side.split(":")) {
      const dotted = part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (dotted) {
        const o = dotted.slice(1).map(Number);
        if (o.some((n) => n > 255)) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!part || !/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parse(sides[0] ?? "");
  const tail = sides.length === 2 ? parse(sides[1] ?? "") : null;
  if (!head || !tail) return null;
  if (sides.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // `::` must stand for at least one zero group
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** IPv4 that an IPv6 literal still routes to: mapped (`::ffff:`), NAT64 (`64:ff9b::/96` and the
 *  local-use `64:ff9b:1::`), 6to4 (`2002::/16`) and the deprecated IPv4-compatible form (`::a.b`).
 *  Wherever those prefixes are still routable they reach the embedded address, so the embedded
 *  address is what has to be classified — otherwise `http://[64:ff9b::a9fe:a9fe]/` walks past the
 *  metadata block one literal away from 169.254.169.254, and a DNS64 answer can do the same. */
function embeddedIpv4Octets(ip: string): number[] | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const low32 = () => [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
  if (g[5] === 0xffff && zeros(0, 5)) return low32();
  if (g[0] === 0x2002 && (g[1] !== 0 || g[2] !== 0)) {
    return [(g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff]; // 6to4 carries v4 after the prefix
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    if (zeros(2, 6)) return low32(); // NAT64 well-known prefix
    if (g[2] === 0x0001 && zeros(3, 6)) return low32(); // NAT64 local-use prefix
  }
  if (zeros(0, 6) && (g[6] !== 0 || g[7] !== 0)) return low32(); // IPv4-compatible (deprecated)
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
  const embedded = embeddedIpv4Octets(ip);
  if (embedded) return classifyIpv4Octets(embedded);
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
 * opt-in through allowLoopback; private/link-local/reserved ranges are blocked unless
 * allowPrivateNetwork is set; cloud metadata and unspecified addresses are always blocked.
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
  if (isBlockedNetworkHost(parsed.hostname, opts.allowPrivateNetwork === true, opts.allowLoopback === true)) {
    throw new Error(`Blocked network host "${parsed.hostname}" — private, link-local, and reserved URLs are not allowed (set allowPrivateNetwork to opt in to private ranges, or allowLoopback for localhost and 127.0.0.0/8; cloud-metadata and unspecified addresses such as 0.0.0.0 are always blocked)`);
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

/** A URL that passed the policy check, together with the addresses that decision used. */
export interface SafeHttpTarget {
  /** Normalized absolute URL. */
  url: string;
  /** Hostname with any IPv6 brackets stripped. */
  host: string;
  /** The classified answers. A literal-IP host contributes that literal. */
  addresses: string[];
}

/**
 * Same policy as assertHttpUrl, plus a DNS round-trip: a hostname that answers with a
 * loopback, private, link-local, reserved, or metadata address is rejected before any
 * request is made. Literal-IP hosts skip the lookup. Text-only classification is not enough
 * on its own — `http://169.254.169.254.nip.io/` reads as a public hostname.
 *
 * The answers are returned so a caller can pin its socket to one of them: validating a name
 * and then letting the transport resolve it again leaves a window where a short-TTL record
 * answers a public address at check time and an internal one at connect time.
 */
export async function resolveSafeHostUrl(url: string, opts: HttpUrlOptions = {}): Promise<SafeHttpTarget> {
  const normalized = assertHttpUrl(url, opts);
  const host = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteralHost(host)) return { url: normalized, host, addresses: [host] }; // already classified; no DNS round-trip
  // A stalled getaddrinfo must not outlive the caller's own budget, and with no caller signal
  // (a browser route handler, a frame re-check) the guard bounds itself instead of hanging.
  const dnsSignal = opts.signal ?? (opts.dnsTimeoutMs ? AbortSignal.timeout(opts.dnsTimeoutMs) : undefined);
  const answers = opts.resolveHost
    ? await untilAborted(Promise.resolve(opts.resolveHost(host)), dnsSignal)
    : await untilAborted(resolveHostAddresses(host), dnsSignal);
  if (!answers.length) throw new Error(`Could not resolve host "${host}"`);
  const allowPrivate = opts.allowPrivateNetwork === true;
  const allowLoopback = opts.allowLoopback === true;
  for (const answer of answers) {
    if (isBlockedNetworkHost(answer, allowPrivate, allowLoopback)) {
      throw new Error(`Blocked network host "${host}" — it resolves to ${answer}, and private, link-local, and reserved addresses are not allowed (set allowPrivateNetwork to opt in to private ranges, or allowLoopback for localhost and 127.0.0.0/8; cloud-metadata and unspecified addresses such as 0.0.0.0 are always blocked)`);
    }
  }
  return { url: normalized, host, addresses: answers };
}

/** `resolveSafeHostUrl` for callers that do not open a socket. */
export async function assertSafeHttpUrl(url: string, opts: HttpUrlOptions = {}): Promise<string> {
  return (await resolveSafeHostUrl(url, opts)).url;
}
// END SHARED HOST GUARD
