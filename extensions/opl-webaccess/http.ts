/**
 * Pinned HTTP transport for model-supplied URLs.
 *
 * The guard in utils.ts classifies every DNS answer for a hostname. Handing only the *name* to a
 * generic client throws that work away: the client resolves again, and a record with a one-second
 * TTL can answer a public address at check time and 127.0.0.1 or 169.254.169.254 at connect time.
 * This module takes the validated set and dials it, so the socket cannot be re-steered.
 *
 * Node's global fetch has no resolver hook, so the transport is node:http/node:https with a
 * `lookup` that never reaches DNS. The hostname still drives TLS (`servername`) and the `Host`
 * header, so certificate validation and virtual hosting behave as they would without pinning.
 */
import http from "node:http";
import https from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Transform } from "node:stream";
import type { SafeHttpTarget } from "./utils.ts";

/** Keeps site responses identical to the fetch path this replaces. */
const USER_AGENT = "Mozilla/5.0 (compatible; opl-pi-sht/webaccess)";

export interface PinnedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Caller's abort signal; aborting destroys the socket and rejects with an AbortError. */
  signal?: AbortSignal;
  /** Socket inactivity deadline (ms). 0 or unset means no transport-side deadline. */
  timeoutMs?: number;
  /** Hard ceiling on both received and decoded body bytes. 0 or unset means unlimited. */
  maxResponseBytes?: number;
}

export interface PinnedResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: Buffer;
  text(): string;
}

function isIpv6(address: string): boolean {
  return address.includes(":");
}

function familyOf(address: string): 4 | 6 {
  return isIpv6(address) ? 6 : 4;
}

function abortError(): Error & { name: string } {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/**
 * A resolver that answers only from the addresses the guard approved. It ignores the name it is
 * asked about - the point is that nothing downstream gets to choose a different answer.
 */
export function pinnedLookup(addresses: string[]) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void,
  ): void => {
    if (options && options.all) {
      callback(null, addresses.map((address) => ({ address, family: familyOf(address) })));
      return;
    }
    const asked = options && typeof options.family === "string" ? (options.family === "IPv6" ? 6 : 4) : options?.family;
    const want = asked === 6 ? 6 : asked === 4 ? 4 : 0;
    const hit = want ? addresses.find((address) => familyOf(address) === want) ?? addresses[0] : addresses[0];
    if (!hit) {
      callback(new Error(`No pinned address available for "${hostname}"`));
      return;
    }
    callback(null, hit, familyOf(hit));
  };
}

/** The request options for one pinned hop. Exported so the contract is testable without a socket. */
export function buildRequestOptions(
  target: SafeHttpTarget,
  opts: PinnedFetchOptions = {},
): http.RequestOptions & { servername?: string } {
  const parsed = new URL(target.url);
  const tls = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : tls ? 443 : 80;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    // Prefer identity, but decode supported encodings if the server compresses anyway.
    "accept-encoding": "identity",
    ...opts.headers,
  };
  headers.host = parsed.host; // keeps the port and IPv6 brackets exactly as the URL spells them
  const options: http.RequestOptions & { servername?: string } = {
    protocol: parsed.protocol,
    method: (opts.method ?? "GET").toUpperCase(),
    host: target.host,
    hostname: target.host,
    port,
    path: `${parsed.pathname}${parsed.search}`,
    headers,
    agent: pinnedAgent(target.url),
    // Node declares this hook as two overloads (`all` or not); the pin answers both, so the widening
    // happens here instead of pretending it is only one of them.
    lookup: pinnedLookup(target.addresses) as http.RequestOptions["lookup"],
  };
  if (tls) options.servername = target.host; // certificate validation stays bound to the name
  return options;
}

/**
 * A fresh agent per request. Pooling is off (`keepAlive: false`) and, because nothing is shared,
 * a socket established under one hop's approved address can never be reused by a later request
 * whose guard approved a different one.
 */
export function pinnedAgent(url: string): http.Agent | https.Agent {
  return url.startsWith("https:") ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
}

/** Only these status codes redirect a GET; other 3xx responses are final. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch one already-validated target. Redirects are returned, never followed: the caller re-runs the
 * guard and re-pins for each hop, which is the only place a new host can appear.
 */
export function pinnedFetch(target: SafeHttpTarget, opts: PinnedFetchOptions = {}): Promise<PinnedResponse> {
  const options = buildRequestOptions(target, opts);
  const transport = new URL(target.url).protocol === "https:" ? https : http;
  const limit = opts.maxResponseBytes && opts.maxResponseBytes > 0 ? opts.maxResponseBytes : 0;

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    let incoming: http.IncomingMessage | undefined;
    let decoder: Transform | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => fail(abortError());
    const resetTimeout = () => {
      if (!opts.timeoutMs || opts.timeoutMs <= 0) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => fail(new Error(`Request to ${target.host} timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    };
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", abort);
      clearTimeout(inactivityTimer);
      decoder?.destroy();
      incoming?.destroy();
      request.destroy();
      if (options.agent && typeof options.agent === "object") options.agent.destroy();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const request = transport.request(options, (response) => {
      incoming = response;
      response.on("error", fail);
      response.on("aborted", () => fail(new Error(`Response from ${target.host} ended before its body completed`)));
      const status = response.statusCode ?? 0;
      const headers = {
        get(name: string): string | null {
          const value = response.headers[name.toLowerCase()];
          if (Array.isArray(value)) return value.join(", ");
          return value === undefined ? null : String(value);
        },
      };
      const finish = (body: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status, ok: status >= 200 && status < 300, headers, body, text: () => body.toString("utf8") });
      };
      // A redirect body is irrelevant. Close this socket and let the caller validate the next hop.
      if (isRedirectStatus(status) && headers.get("location")) {
        finish(Buffer.alloc(0));
        return;
      }
      // These responses cannot carry a body, even if they advertise its size or encoding.
      if (options.method === "HEAD" || status === 204 || status === 304) {
        finish(Buffer.alloc(0));
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (limit > 0 && Number.isFinite(declared) && declared > limit) {
        fail(new Error(`Response from ${target.host} is ${declared} bytes, over the ${limit} byte limit (set maxResponseBytes to raise it)`));
        return;
      }
      const encoding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
      switch (encoding) {
        case "identity": break;
        case "gzip": decoder = createGunzip(); break;
        case "deflate": decoder = createInflate(); break;
        case "br": decoder = createBrotliDecompress(); break;
        default:
          fail(new Error(`Unsupported content encoding "${encoding}" from ${target.host}`));
          return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let decoded = 0;
      const collect = (chunk: Buffer) => {
        if (settled) return;
        decoded += chunk.length;
        if (limit > 0 && decoded > limit) {
          fail(new Error(`Decoded response from ${target.host} exceeds the ${limit} byte limit (set maxResponseBytes to raise it)`));
          return;
        }
        chunks.push(chunk);
      };
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        resetTimeout();
        received += chunk.length;
        if (limit > 0 && received > limit) {
          fail(new Error(`Response from ${target.host} exceeds the ${limit} byte limit (set maxResponseBytes to raise it)`));
        }
      });
      const bodyStream = decoder ?? response;
      bodyStream.on("data", collect);
      bodyStream.on("end", () => finish(Buffer.concat(chunks)));
      if (decoder) {
        decoder.on("error", (err: Error) => fail(new Error(`Cannot decompress ${encoding} response from ${target.host}: ${err.message}`, { cause: err })));
        response.pipe(decoder);
      }
    });
    request.on("error", (err) => {
      const failure = err as Error & { code?: string };
      if (failure.name === "AbortError" || /byte limit|timed out/.test(failure.message)) {
        fail(failure);
        return;
      }
      // Name the address the guard approved: "connect ECONNREFUSED api.internal:80" on its own hides
      // which validated answer the socket was pinned to, which is the first thing triage needs.
      fail(
        Object.assign(new Error(`${target.host} -> ${target.addresses.join(", ")}: ${failure.message}`), {
          code: failure.code,
          cause: failure,
        }),
      );
    });
    // Both the deadline and the caller's abort own their error objects. Handing destroy() an error
    // reaches the rejection reliably on Node; on Bun the socket comes back as ECONNRESET or a bare
    // "Connection closed", which would hide the reason from the model and from these tests.
    resetTimeout();
    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(abortError());
        return;
      }
      opts.signal.addEventListener("abort", abort, { once: true });
    }
    request.end();
  });
}
