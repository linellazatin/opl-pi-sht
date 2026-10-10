import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  CACHE_TTL_MS,
  PREVIEW_ITEM_BYTES,
  cacheDir,
  clearStore,
  generateId,
  getResult,
  persistResult,
  previewize,
  pruneCache,
  restoreFromSession,
  storeResult,
} from "../extensions/opl-webaccess/storage.ts";

function withAgentDir(fn) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "opl-wa-store-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  clearStore();
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    clearStore();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakePi() {
  const journal = [];
  return { journal, appendEntry: (type, data) => journal.push({ type, data }) };
}

function fetchBody(chars = 200_000) {
  const id = generateId();
  return {
    id,
    type: "fetch",
    timestamp: Date.now(),
    urls: [
      { url: "https://example.com/long", title: "Long read", content: "a".repeat(chars), error: null },
      { url: "https://example.com/short", title: "Short read", content: "brief body", error: null },
    ],
  };
}

function ctxWith(entries) {
  return { sessionManager: { getBranch: () => entries.map((e) => ({ type: "custom", customType: "web-access-results", data: e })) } };
}

test("persistResult keeps the body out of the session entry and on disk", () =>
  withAgentDir(() => {
    const pi = fakePi();
    const data = fetchBody();
    persistResult(pi, data);

    assert.equal(pi.journal.length, 1);
    const entry = pi.journal[0].data;
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    assert.ok(entryBytes < 4096, `session entry is ${entryBytes} bytes for a 200 KB body`);
    assert.equal(entry.truncated, true);
    assert.match(entry.urls[0].content, /omitted from the session copy/);
    assert.equal(entry.urls[1].content, "brief body", "a body under the preview cap is kept whole");

    const spilled = readFileSync(entry.file, "utf8");
    assert.ok(spilled.includes("a".repeat(1000)), "the full body is on disk");
    assert.equal(JSON.parse(spilled).id, data.id);
    assert.equal(entry.file, join(cacheDir(), `${data.id}.json`));
  }));

test("a restored result hydrates the full body from disk on first read", () =>
  withAgentDir(() => {
    const pi = fakePi();
    const data = fetchBody();
    persistResult(pi, data);
    clearStore();

    restoreFromSession(ctxWith([pi.journal[0].data]));
    const hit = getResult(data.id);
    assert.ok(hit, "the restored id resolves");
    assert.equal(hit.urls[0].content.length, 200_000);
    assert.ok(!hit.truncated, "a hydrated result is not a preview");
  }));

test("a restored result whose cache file is gone stays a marked preview", () =>
  withAgentDir(() => {
    const pi = fakePi();
    const data = fetchBody();
    persistResult(pi, data);
    rmSync(pi.journal[0].data.file, { force: true });
    clearStore();

    restoreFromSession(ctxWith([pi.journal[0].data]));
    const hit = getResult(data.id);
    assert.equal(hit.truncated, true);
    assert.ok(hit.urls[0].content.length < 2000, "only the preview survives");
    assert.match(hit.urls[0].content, /omitted from the session copy/);
    assert.equal(hit.urls[1].content, "brief body");
  }));

test("an entry older than the TTL is not restored at all", () =>
  withAgentDir(() => {
    const stale = { ...fetchBody(1000), timestamp: Date.now() - CACHE_TTL_MS - 1000 };
    restoreFromSession(ctxWith([stale]));
    assert.equal(getResult(stale.id), null);
  }));

test("previewize caps each item and leaves a short payload unmarked", () => {
  const long = previewize(fetchBody(50_000));
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.urls[0].content, "utf8") < PREVIEW_ITEM_BYTES + 200);

  const short = previewize({
    id: "abc",
    type: "search",
    timestamp: 1,
    queries: [{ query: "q", answer: "short answer", results: [{ title: "t", url: "u" }], error: null }],
  });
  assert.equal(short.truncated, undefined);
  assert.equal(short.queries[0].answer, "short answer");
});

test("previewize does not cut a multi-byte character in half", () =>
  withAgentDir(() => {
    const out = previewize({
      id: "x",
      type: "fetch",
      timestamp: 1,
      urls: [{ url: "u", title: "t", content: "é".repeat(5000), error: null }],
    });
    assert.ok(!out.urls[0].content.includes("\uFFFD"));
  }));

test("pruneCache drops bodies older than the TTL", () =>
  withAgentDir((dir) => {
    mkdirSync(cacheDir(), { recursive: true });
    const fresh = join(cacheDir(), "fresh.json");
    const stale = join(cacheDir(), "stale.json");
    writeFileSync(fresh, "{}");
    writeFileSync(stale, "{}");
    const past = (CACHE_TTL_MS + 60_000) / 1000;
    utimesSync(stale, new Date(Date.now() - past * 1000), new Date(Date.now() - past * 1000));

    const removed = pruneCache();
    assert.equal(removed, 1);
    assert.ok(existsSync(fresh), "a live body survives");
    assert.ok(!existsSync(stale), "an expired body is gone");
    assert.ok(dir);
  }));

test("pruneCache trims the oldest bodies until the directory fits the cap", () =>
  withAgentDir(() => {
    mkdirSync(cacheDir(), { recursive: true });
    const names = ["old", "mid", "new"];
    for (const n of names) writeFileSync(join(cacheDir(), `${n}.json`), "x".repeat(4000));
    // Distinct, ordered mtimes: old < mid < new.
    let clock = Date.now() - 3000;
    for (const n of names) {
      const t = new Date(clock);
      utimesSync(join(cacheDir(), `${n}.json`), t, t);
      clock += 1000;
    }

    const removed = pruneCache(Date.now(), 5000);
    assert.equal(removed, 2, "two of three 4 KB bodies must go to fit 5 KB");
    assert.ok(!existsSync(join(cacheDir(), "old.json")), "oldest dropped first");
    assert.ok(existsSync(join(cacheDir(), "new.json")), "newest kept");
  }));

test("an id that is not a generated id never becomes a path", () =>
  withAgentDir(() => {
    const pi = fakePi();
    const hostile = {
      id: "../../escaped",
      type: "fetch",
      timestamp: Date.now(),
      urls: [{ url: "u", title: "t", content: "y".repeat(5000), error: null }],
    };
    persistResult(pi, hostile);
    assert.equal(hostile.id.includes("/"), true, "the fixture is the hostile case");
    assert.ok(!pi.journal[0].data.file, "no spill path is recorded");
    assert.ok(!existsSync(join(cacheDir(), "..", "..", "escaped.json")), "nothing written outside the cache dir");
    assert.ok(Buffer.byteLength(JSON.stringify(pi.journal[0].data), "utf8") < 4096, "the preview is still bounded");
  }));

test("a legacy session entry that still carries the whole body restores unchanged", () =>
  withAgentDir(() => {
    // Sessions written before the spill layer hold full bodies and no file field.
    const legacy = fetchBody(200);
    restoreFromSession(ctxWith([legacy]));
    const hit = getResult(legacy.id);
    assert.equal(hit.urls[0].content.length, 200);
    assert.equal(hit.truncated, undefined);
  }));

test("storeResult keeps serving what was stored this session", () =>
  withAgentDir(() => {
    const data = fetchBody(200);
    storeResult(data.id, data);
    assert.equal(getResult(data.id).urls[0].content.length, 200);
    assert.ok(!existsSync(join(cacheDir(), `${data.id}.json`)), "an in-session store writes no cache file");
  }));

test("the cache directory sits in pi's agent dir, not the project", () =>
  withAgentDir((dir) => {
    assert.equal(cacheDir(), join(dir, "web-access-cache"));
  }));
