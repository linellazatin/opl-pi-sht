import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { searchWeb } from "../extensions/opl-webaccess/search.ts";
import { DEFAULT_TIMEOUT_MS, resolveTimeoutMs } from "../extensions/opl-webaccess/config.ts";

function hangingFetch(seen) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push({ url: String(url), signal: init?.signal });
    return new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  return () => {
    globalThis.fetch = real;
  };
}

const ddgsConfig = (timeoutMs) => ({
  provider: "ddgs",
  providers: { ddgs: { apiUrl: "http://127.0.0.1:9" } },
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

test("a provider that never answers is cut off by the configured deadline", async () => {
  const seen = [];
  const restore = hangingFetch(seen);
  try {
    const started = Date.now();
    const result = await searchWeb("quiet query", undefined, ddgsConfig(40));
    assert.ok(Date.now() - started < 5000, "the deadline must fire, not a hang");
    assert.equal(result.error, "Aborted", `expected the deadline to abort the call, got ${JSON.stringify(result)}`);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].signal instanceof AbortSignal, "the provider call is given a signal even with no caller signal");
  } finally {
    restore();
  }
});

test("the default deadline is 30s and a bogus value falls back to it", () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ timeoutMs: 45_000 }), 45_000);
  for (const bad of [0, -1, "30000", Number.NaN, null]) {
    assert.equal(resolveTimeoutMs({ timeoutMs: bad }), DEFAULT_TIMEOUT_MS, `${String(bad)} must not disable the deadline`);
  }
});

test("a caller abort still wins over the deadline", async () => {
  const seen = [];
  const restore = hangingFetch(seen);
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await searchWeb("cancelled", controller.signal, ddgsConfig(30_000));
    assert.equal(result.error, "Aborted");
    assert.equal(seen.length, 0, "an already-aborted call must not reach the network");
  } finally {
    restore();
  }
});

test("searchWeb uses the config it is handed instead of re-reading the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opl-wa-search-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  // A file that would select a different provider with a different port.
  writeFileSync(
    join(dir, "configs", "opl-webaccess.json"),
    JSON.stringify({ provider: "searxng", providers: { searxng: { instanceUrl: "http://127.0.0.1:8" } } }),
  );
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const seen = [];
  const restore = hangingFetch(seen);
  try {
    await searchWeb("passed config", undefined, ddgsConfig(40));
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.startsWith("http://127.0.0.1:9/"), `used ${seen[0].url}, expected the passed ddgs endpoint`);
  } finally {
    restore();
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a web_search call fans out over queries on one loaded config", async () => {
  // Regression guard for the per-query config read: the tool must load config once
  // and hand the same object to every query.
  const seen = [];
  const restore = hangingFetch(seen);
  try {
    const config = ddgsConfig(30);
    const results = await Promise.all([1, 2, 3].map((n) => searchWeb(`q${n}`, undefined, config)));
    assert.equal(results.length, 3);
    assert.deepEqual(seen.map((s) => new URL(s.url).searchParams.get("query")), ["q1", "q2", "q3"]);
    assert.ok(seen.every((s) => s.signal instanceof AbortSignal));
  } finally {
    restore();
  }
});
