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

function mount() {
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
    model: { provider: "openai-codex", id: "gpt-5" },
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
  const fire = async (name) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  return { ctx, fire, render: () => footerComponent.render(200).join("\n") };
}

function writeConfig(home, enabled) {
  const configDir = join(home, ".pi", "agent", "configs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opl-footer.json"), JSON.stringify({
    row1LeftSegments: enabled ? ["codex_usage"] : [],
    row1RightSegments: [], row2LeftSegments: [], row2RightSegments: [], row3LeftSegments: [], row3RightSegments: [],
  }));
  clearUserConfigCache();
}

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
