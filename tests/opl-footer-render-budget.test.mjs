import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import footer from "../extensions/opl-footer/index.ts";
import { clearUserConfigCache } from "../extensions/opl-footer/config.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI, "");

/**
 * Mount the footer against a stub host. `theme.fg` behaves like pi's: it throws on an
 * unknown colour token, which is how one bad value in opl-footer.json used to take the
 * whole footer down.
 */
async function mount({ config = {}, throwOn = null, branchRef = { value: [] }, projectionMessages = [], projectionRef = { value: projectionMessages }, usageRef = { value: { percent: null, contextWindow: 1000 } }, leafRef = { value: "leaf-1" }, sessionRef = { value: "session-1" } } = {}) {
  clearUserConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "opl-footer-budget-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  writeFileSync(join(dir, "configs", "opl-footer.json"), JSON.stringify(config));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const handlers = new Map();
  let component;
  let projectionsBuilt = 0;
  let themeLookups = 0;
  let renderRequests = 0;
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
    model: { provider: "alpha", id: "model-a", contextWindow: 1000 },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => usageRef.value,
    sessionManager: {
      getBranch: () => branchRef.value,
      getSessionId: () => sessionRef.value,
      getLeafId: () => leafRef.value,
      buildSessionProjection: () => {
        projectionsBuilt++;
        return { messages: projectionRef.value };
      },
    },
    ui: {
      notify() {},
      setFooter(factory) {
        component = factory(
          { requestRender() { renderRequests++; } },
          {
            fg: (name, text) => {
              themeLookups++;
              if (name === throwOn) throw new Error(`Unknown colour token: "${name}"`);
              return text;
            },
          },
          { getGitBranch: () => null, onBranchChange: () => () => {} },
        );
      },
    },
  };

  footer(pi);
  clearUserConfigCache();
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

  return {
    projectionsBuilt: () => projectionsBuilt,
    renderRequests: () => renderRequests,
    themeLookups: () => themeLookups,
    fire: async (name, event) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    render: () => component.render(120),
    dispose() {
      clearUserConfigCache();
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const singleRow = (segments) => ({
  row1LeftSegments: segments,
  row1RightSegments: [],
  row2LeftSegments: [],
  row2RightSegments: [],
  row3LeftSegments: [],
  row3RightSegments: [],
});

const dividers = (lines) => lines.filter((l) => /^─+$/.test(stripAnsi(l))).length;

test("a layout with one populated row costs two lines, not six", async () => {
  const h = await mount({ config: singleRow(["text:branch"]) });
  try {
    const lines = h.render();
    assert.equal(lines.length, 2, `expected a blank plus one row, got ${JSON.stringify(lines)}`);
    assert.equal(lines[0], "", "the leading blank keeps the transcript off the footer");
    assert.ok(lines[1].includes("branch"));
    assert.equal(dividers(lines), 0, "no divider is emitted for rows that do not exist");
  } finally {
    h.dispose();
  }
});

test("two populated rows share exactly one divider", async () => {
  const h = await mount({
    config: {
      row1LeftSegments: ["text:top"],
      row1RightSegments: [],
      row2LeftSegments: ["text:middle"],
      row2RightSegments: [],
      row3LeftSegments: [],
      row3RightSegments: [],
    },
  });
  try {
    const lines = h.render();
    assert.equal(lines.length, 4, `blank + row + divider + row, got ${JSON.stringify(lines.map(stripAnsi))}`);
    assert.equal(dividers(lines), 1);
    console.log(`[opl-footer] one row = 2 lines, two rows = 4 lines, three rows = 6 lines (was always 6)`);
  } finally {
    h.dispose();
  }
});

test("three populated rows keep the old six-line footer", async () => {
  const h = await mount({
    config: {
      row1LeftSegments: ["text:one"],
      row1RightSegments: [],
      row2LeftSegments: ["text:two"],
      row2RightSegments: [],
      row3LeftSegments: ["text:three"],
      row3RightSegments: [],
    },
  });
  try {
    const lines = h.render();
    assert.equal(lines.length, 6, `a full layout must not lose a line, got ${JSON.stringify(lines.map(stripAnsi))}`);
    assert.equal(dividers(lines), 2);
  } finally {
    h.dispose();
  }
});

test("a segment that throws renders a marker and leaves the rest alone", async () => {
  // A thinking_level_change entry whose level is not a string is the kind of oddity a
  // resumed or edited session can carry; it used to blank every footer row on every frame.
  const branchRef = { value: [{ type: "thinking_level_change", thinkingLevel: 5 }] };
  const h = await mount({ config: singleRow(["thinking", "text:still here"]), branchRef });
  try {
    const lines = h.render();
    assert.equal(lines.length, 2, "the footer survives a broken segment");
    assert.ok(lines[1].includes("[?]"), `expected the failure marker, got ${JSON.stringify(stripAnsi(lines[1]))}`);
    assert.ok(lines[1].includes("still here"), "the sibling segment still renders");
  } finally {
    h.dispose();
  }
});

test("an odd transcript entry degrades the counters instead of blanking the footer", async () => {
  const branchRef = {
    value: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
          usage: undefined,
        },
      },
    ],
  };
  const h = await mount({ config: singleRow(["text:alive", "tokens", "session_stats"]), branchRef });
  try {
    const lines = h.render();
    assert.equal(lines.length, 2, `footer must still render, got ${JSON.stringify(lines.map(stripAnsi))}`);
    assert.ok(lines[1].includes("alive"), "the rest of the row survives");
    assert.ok(!lines[1].includes("[?]"), "a missing usage block is read as zero, not treated as a broken segment");
  } finally {
    h.dispose();
  }
});

test("branch-derived counts and the projection estimate are derived once per branch", async () => {
  const h = await mount({
    config: singleRow(["tokens", "context_pct"]),
    projectionMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  try {
    h.render();
    h.render();
    h.render();
    assert.equal(h.projectionsBuilt(), 1, `projection built ${h.projectionsBuilt()} times for an unchanged branch`);
  } finally {
    h.dispose();
  }
});

test("the estimate is re-derived when the branch grows", async () => {
  const branchRef = { value: [] };
  const h = await mount({
    config: singleRow(["tokens", "context_pct"]),
    branchRef,
    projectionMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  try {
    h.render();
    assert.equal(h.projectionsBuilt(), 1);
    h.render();
    assert.equal(h.projectionsBuilt(), 1, "an unchanged branch must not re-estimate");
    branchRef.value = [
      ...branchRef.value,
      { type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } },
    ];
    h.render();
    assert.equal(h.projectionsBuilt(), 2, "a longer branch re-derives the facts");
  } finally {
    h.dispose();
  }
});

test("equal-length branch switches refresh counts, thinking, cost and tokens", async () => {
  const branchRef = { value: [
    { type: "message", message: { role: "user", content: "one" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], usage: { input: 100, output: 10, cost: { total: 0.1 } } } },
    { type: "thinking_level_change", thinkingLevel: "off" },
  ] };
  const leafRef = { value: "branch-a" };
  const h = await mount({ config: singleRow(["session_stats", "thinking", "token_in", "cost"]), branchRef, leafRef });
  try {
    const first = stripAnsi(h.render().join("\n"));
    assert.match(first, /1 prompts.*1 api calls.*1 tool calls/);
    assert.match(first, /↑ 100/);
    assert.match(first, /0\.10/);
    branchRef.value = [
      { type: "message", message: { role: "user", content: "one" } },
      { type: "message", message: { role: "user", content: "two" } },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ];
    leafRef.value = "branch-b";
    const second = stripAnsi(h.render().join("\n"));
    assert.match(second, /2 prompts.*0 api calls.*0 tool calls/);
    assert.match(second, /HIGH/);
    assert.match(second, /↑ 0/);
    assert.ok(!second.includes("0.10"));
  } finally { h.dispose(); }
});

for (const event of ["session_tree", "session_compact"]) {
  test(`${event} refreshes the projection even when the cache key inputs stay equal`, async () => {
    const projectionRef = { value: [{ role: "user", content: "hi" }] };
    const h = await mount({ config: singleRow(["context_pct"]), projectionRef });
    try {
      const before = stripAnsi(h.render().join("\n"));
      const requests = h.renderRequests();
      projectionRef.value = [{ role: "user", content: "changed projection ".repeat(100) }];
      await h.fire(event, {});
      assert.ok(h.renderRequests() > requests);
      const after = stripAnsi(h.render().join("\n"));
      assert.notEqual(after, before);
      assert.equal(h.projectionsBuilt(), 2);
      h.render();
      assert.equal(h.projectionsBuilt(), 2);
    } finally { h.dispose(); }
  });
}

test("canonical usage replaces the estimate and a later unknown usage rebuilds it", async () => {
  const usageRef = { value: { percent: null, contextWindow: 1000 } };
  const h = await mount({ config: singleRow(["context_pct"]), usageRef });
  try {
    assert.match(stripAnsi(h.render().join("\n")), /≈/);
    usageRef.value = { percent: 25, contextWindow: 1000 };
    const exact = stripAnsi(h.render().join("\n"));
    assert.match(exact, /25\.00%/);
    assert.ok(!exact.includes("≈"));
    assert.equal(h.projectionsBuilt(), 1);
    usageRef.value = { percent: null, contextWindow: 1000 };
    assert.match(stripAnsi(h.render().join("\n")), /≈/);
    assert.equal(h.projectionsBuilt(), 2);
  } finally { h.dispose(); }
});

test("changing sessions with an equal-length branch invalidates the estimate", async () => {
  const sessionRef = { value: "session-a" };
  const h = await mount({ config: singleRow(["context_pct"]), sessionRef });
  try {
    h.render();
    sessionRef.value = "session-b";
    h.render();
    assert.equal(h.projectionsBuilt(), 2);
  } finally { h.dispose(); }
});

test("the unfilled bar colour is resolved once per frame, not per cell", async () => {
  const h = await mount({
    config: {
      ...singleRow(["context_pct"]),
      segmentOptions: { contextBar: { unfilledColor: "muted", barWidth: 18 } },
    },
  });
  try {
    h.themeLookups();
    const lines = h.render();
    const lookups = h.themeLookups();
    assert.ok(stripAnsi(lines[1]).includes("%"), "the bar still renders");
    assert.ok(lookups < 10, `the bar cost ${lookups} theme lookups for 18 cells`);
  } finally {
    h.dispose();
  }
});

test("session_shutdown releases the cross-extension render trigger", async () => {
  const h = await mount({ config: singleRow(["text:alive"]) });
  try {
    assert.equal(typeof globalThis.__footerRequestRender, "function", "mounting publishes the seam");
    await h.fire("session_shutdown", {});
    assert.equal(globalThis.__footerRequestRender, undefined, "the closure over a dead TUI is dropped");
  } finally {
    h.dispose();
  }
});
