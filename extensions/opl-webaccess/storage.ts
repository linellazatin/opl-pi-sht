import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StoredData } from "./types.js";

const CUSTOM_TYPE = "web-access-results";
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Bytes of body text kept per item in the session copy. The body itself is
 * spilled to `cacheDir()`; a session used to hold every fetched byte forever
 * (up to 10 MB x 20 URLs per call) while the in-memory cache only lives an hour.
 */
export const PREVIEW_ITEM_BYTES = 512;
/** Ceiling for the spill directory; the oldest bodies are dropped past it. */
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;

const store = new Map<string, StoredData>();

/** Evict expired entries to prevent unbounded growth. */
function evictExpired(): void {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [id, data] of store) {
    if (data.timestamp < cutoff) store.delete(id);
  }
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Where full bodies are spilled: outside the session file, inside pi's agent dir. */
export function cacheDir(): string {
  return join(getAgentDir(), "web-access-cache");
}

/** Only our own ids are ever turned into a path. */
function cacheFileFor(id: string): string | null {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  return join(cacheDir(), `${id}.json`);
}

function capItem(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= PREVIEW_ITEM_BYTES) return text;
  let head = Buffer.from(text, "utf8").subarray(0, PREVIEW_ITEM_BYTES).toString("utf8");
  if (head.endsWith("\uFFFD")) head = head.slice(0, -1); // never cut mid-codepoint
  const omitted = bytes - Buffer.byteLength(head, "utf8");
  return `${head}\n\n[… ${omitted} bytes omitted from the session copy — the full body stays in the disk cache for ${Math.round(CACHE_TTL_MS / 60000)} minutes]`;
}

/** A bounded copy for the session entry: identity plus the head of each body. */
export function previewize(data: StoredData): StoredData {
  const out: StoredData = { id: data.id, type: data.type, timestamp: data.timestamp };
  let truncated = false;
  if (data.queries) {
    out.queries = data.queries.map((q) => {
      const answer = capItem(q.answer ?? "");
      truncated ||= answer !== (q.answer ?? "");
      return { ...q, answer };
    });
  }
  if (data.urls) {
    out.urls = data.urls.map((u) => {
      const content = capItem(u.content ?? "");
      truncated ||= content !== (u.content ?? "");
      return { ...u, content };
    });
  }
  if (truncated) out.truncated = true;
  return out;
}

/** Write the full body to the disk cache. A cache we cannot write must not fail the call. */
function spill(data: StoredData): string | null {
  const file = cacheFileFor(data.id);
  if (!file) return null;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(data), "utf8");
    return file;
  } catch {
    return null;
  }
}

function readSpill(data: StoredData): StoredData | null {
  if (!data.file) return null;
  try {
    const parsed = JSON.parse(readFileSync(data.file, "utf8")) as StoredData;
    return parsed && parsed.id === data.id && parsed.type === data.type ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Drop expired bodies, then trim the oldest ones until the directory fits
 * MAX_CACHE_BYTES. Returns how many files were removed.
 */
export function pruneCache(now: number = Date.now(), maxBytes: number = MAX_CACHE_BYTES): number {
  const dir = cacheDir();
  if (!existsSync(dir)) return 0;
  const cutoff = now - CACHE_TTL_MS;
  let removed = 0;
  const alive: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed++;
        continue;
      }
      alive.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Raced away between readdir and stat: nothing to keep.
    }
  }
  let total = alive.reduce((sum, f) => sum + f.size, 0);
  if (total > maxBytes) {
    alive.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const f of alive) {
      if (total <= maxBytes) break;
      rmSync(f.path, { force: true });
      total -= f.size;
      removed++;
    }
  }
  return removed;
}

export function storeResult(id: string, data: StoredData): void {
  store.set(id, data);
  evictExpired();
}

/**
 * Read a result. Entries restored from the session hold a preview plus a pointer;
 * the full body is hydrated from disk on first read and cached in memory, so
 * session_start never has to open every file.
 */
export function getResult(id: string, now: number = Date.now()): StoredData | null {
  const data = store.get(id);
  if (!data) return null;
  if (now - data.timestamp >= CACHE_TTL_MS) {
    store.delete(id);
    return null;
  }
  if (data.truncated && data.file) {
    const full = readSpill(data);
    if (full) {
      store.set(id, full);
      return full;
    }
  }
  return data;
}

export function clearStore(): void {
  store.clear();
}

/** Persist a pointer plus a bounded preview; the body goes to the disk cache. */
export function persistResult(pi: ExtensionAPI, data: StoredData): void {
  const entry = previewize(data);
  const file = spill(data);
  if (file) entry.file = file;
  pi.appendEntry(CUSTOM_TYPE, entry);
  pruneCache();
}

export function restoreFromSession(ctx: ExtensionContext): void {
  store.clear();
  const now = Date.now();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
      const data = entry.data as StoredData;
      if (data?.id && data?.type && now - data.timestamp < CACHE_TTL_MS) {
        store.set(data.id, data);
      }
    }
  }
}
