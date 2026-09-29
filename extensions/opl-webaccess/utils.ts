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
    a === 0 || a === 10 || // 0.0.0.0/8, 10/8
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
  if (isPrivateIpv4(o)) return "private";
  return "public";
}

function classifyIpv6Host(host: string): HostClass {
  const ip = host.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  if (BLOCKED_METADATA_V6.has(ip)) return "metadata";
  if (ip === "::1") return "loopback";
  const mapped = ipv4MappedOctets(ip);
  if (mapped) return classifyIpv4Octets(mapped);
  if (ip === "::") return "private"; // unspecified
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

function isBlockedNetworkHost(host: string, allowPrivateNetwork: boolean): boolean {
  const cls = classifyHost(host);
  if (cls === "metadata") return true; // never toggleable
  if (cls === "loopback" || cls === "public") return false;
  return !allowPrivateNetwork; // private / link-local / reserved
}

/**
 * Normalize a URL, allowing only http/https. Loopback (localhost/127.0.0.0/8/::1) is
 * allowed by default for local development; private/link-local/reserved ranges are blocked
 * unless allowPrivateNetwork is set; cloud metadata is always blocked.
 */
export function assertHttpUrl(url: string, opts: HttpUrlOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}//" — only http/https`);
  }
  if (isBlockedNetworkHost(parsed.hostname, opts.allowPrivateNetwork === true)) {
    throw new Error(`Blocked network host "${parsed.hostname}" — private, link-local, reserved, and cloud-metadata URLs are not allowed (set allowPrivateNetwork to opt in to private ranges; metadata is always blocked)`);
  }
  return parsed.href;
}
