import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import footer from "../extensions/opl-footer/index.ts";
import { clearUserConfigCache } from "../extensions/opl-footer/config.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function usageResponse(usedPercent) {
  return new Response(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000, reset_at: 1_700_018_000 },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function mount(provider = "openai-codex") {
  const handlers = new Map();
  let footerComponent;
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand() {},
    getThinkingLevel: () => "off",
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    model: { provider, id: "gpt-5" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "header.payload.signature" }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter(factory) {
        footerComponent = factory(
          { requestRender() {} },
          { fg: (_color, text) => text },
          { getGitBranch: () => null, onBranchChange: () => () => {} },
        );
      },
    },
  };
  footer(pi);
  const fire = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { ctx, fire, render: () => footerComponent.render(200).join("\n") };
}

function writeConfig(home, enabled, segment = "codex_usage") {
  const configDir = join(home, ".pi", "agent", "configs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opl-footer.json"), JSON.stringify({
    row1LeftSegments: enabled ? [segment] : [],
    row1RightSegments: [], row2LeftSegments: [], row2RightSegments: [], row3LeftSegments: [], row3RightSegments: [],
  }));
  clearUserConfigCache();
}

// Control only the quota scheduler's clock; network mocks still resolve normally.
async function withCodexClock(run) {
  const home = mkdtempSync(join(tmpdir(), "opl-footer-codex-clock-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let now = 100_000;
  let requests = 0;
  const timers = new Map();
  let nextTimer = 0;
  let h;
  const flush = () => new Promise((resolve) => previousSetTimeout(resolve, 0));
  try {
    process.env.HOME = home;
    writeConfig(home, true);
    Date.now = () => now;
    globalThis.setTimeout = (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);
    globalThis.fetch = async () => usageResponse(++requests * 10);
    h = mount();
    await h.fire("session_start");
    await flush();
    await run({
      ...h, flush, home,
      requests: () => requests,
      timers: () => timers.size,
      async advance(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.callback();
          }
        }
        await flush();
      },
    });
  } finally {
    await h?.fire("session_shutdown");
    globalThis.fetch = previousFetch;
    Date.now = previousNow;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    clearUserConfigCache();
    rmSync(home, { recursive: true, force: true });
  }
}

for (const event of ["message_end", "tool_execution_end"]) {
  test(`Codex quota refreshes mid-run after ${event}`, async () => {
    await withCodexClock(async (h) => {
      await h.advance(30_000);
      await h.fire(event, { message: { role: "assistant" }, toolCallId: "tool-1" });
      await h.flush();
      assert.equal(h.requests(), 2);
      assert.match(h.render(), /5h 80%/);
    });
  });
}

test("Codex refresh coalesces throttled events into one trailing snapshot", async () => {
  await withCodexClock(async (h) => {
    await h.fire("message_end", { message: { role: "assistant" } });
    await h.fire("tool_execution_end", { toolCallId: "tool-1" });
    await h.fire("tool_execution_end", { toolCallId: "tool-2" });
    await h.fire("agent_settled");
    assert.equal(h.requests(), 1);
    assert.equal(h.timers(), 1);
    await h.advance(29_999);
    assert.equal(h.requests(), 1);
    await h.advance(1);
    assert.equal(h.requests(), 2);
    assert.match(h.render(), /5h 80%/);
    await h.advance(30_000);
    assert.equal(h.requests(), 2, "no recurring polling without new events");
  });
});

test("Codex ignores non-assistant message completion", async () => {
  await withCodexClock(async (h) => {
    await h.advance(30_000);
    await h.fire("message_end", { message: { role: "user" } });
    await h.fire("message_end", { message: { role: "toolResult" } });
    await h.flush();
    assert.equal(h.requests(), 1);
    assert.equal(h.timers(), 0);
  });
});

for (const cancellation of ["disable", "model", "shutdown"]) {
  test(`Codex trailing refresh is cancelled on ${cancellation}`, async () => {
    await withCodexClock(async (h) => {
      await h.fire("agent_settled");
      assert.equal(h.timers(), 1);
      if (cancellation === "disable") writeConfig(h.home, false);
      if (cancellation === "model") {
        h.ctx.model = { provider: "other" };
        await h.fire("model_select");
      }
      if (cancellation === "shutdown") await h.fire("session_shutdown");
      await h.advance(30_000);
      assert.equal(h.requests(), 1);
      assert.equal(h.timers(), 0);
    });
  });
}

test("Codex completion during an in-flight fetch queues a trailing refresh without blocking", async () => {
  await withCodexClock(async (h) => {
    await h.advance(30_000);
    let resolveFetch;
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    };
    await h.fire("message_end", { message: { role: "assistant" } });
    await h.flush();
    assert.equal(requests, 1);
    await h.fire("tool_execution_end", { toolCallId: "tool-1" });
    assert.equal(requests, 1);
    resolveFetch(usageResponse(30));
    await h.flush();
    assert.equal(h.timers(), 1);
    await h.advance(30_000);
    assert.equal(requests, 2);
    resolveFetch(usageResponse(40));
    await h.flush();
    assert.match(h.render(), /5h 60%/);
  });
});

test("Codex shutdown discards an in-flight result and its queued refresh", async () => {
  await withCodexClock(async (h) => {
    await h.advance(30_000);
    let resolveFetch;
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    await h.fire("message_end", { message: { role: "assistant" } });
    await h.flush();
    await h.fire("tool_execution_end", { toolCallId: "tool-1" });
    await h.fire("session_shutdown");
    resolveFetch(usageResponse(40));
    await h.flush();
    assert.match(h.render(), /5h 90%/, "shutdown must not accept the late snapshot");
    assert.equal(h.timers(), 0);
  });
});

test("OpenRouter usage appears only for the selected OpenRouter provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "opl-footer-openrouter-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.HOME = home;
    writeConfig(home, true, "openrouter_usage");
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { limit: 25, limit_remaining: 21.55 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const h = mount("openrouter");

    await h.fire("session_start");
    await tick();
    assert.match(h.render(), /\$3\.4500 \/ \$25\.0000 \(13\.8%\)/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    clearUserConfigCache();
    rmSync(home, { recursive: true, force: true });
  }
});

test("model selection does not wait for a pending Codex usage fetch", async () => {
  const home = mkdtempSync(join(tmpdir(), "opl-footer-codex-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  let resolveFetch;
  try {
    process.env.HOME = home;
    writeConfig(home, true);
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    const h = mount();

    const selected = h.fire("model_select");
    assert.equal(await Promise.race([selected.then(() => "settled"), tick().then(() => "pending")]), "settled");
    resolveFetch(usageResponse(24));
    await tick();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    clearUserConfigCache();
    rmSync(home, { recursive: true, force: true });
  }
});

test("disabling codex_usage discards an in-flight snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "opl-footer-codex-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  let resolveFetch;
  try {
    process.env.HOME = home;
    writeConfig(home, true);
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    const h = mount();

    await h.fire("session_start");
    writeConfig(home, false);
    await h.fire("model_select");
    writeConfig(home, true);
    resolveFetch(usageResponse(24));
    await tick();

    assert.doesNotMatch(h.render(), /5h 76%/, "a fetch begun before disable cannot populate the re-enabled segment");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    clearUserConfigCache();
    rmSync(home, { recursive: true, force: true });
  }
});
