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
async function mount({ config = {}, throwOn = null, branchRef = { value: [] }, projectionMessages = [] } = {}) {
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
    getContextUsage: () => ({ percent: null, contextWindow: 1000 }),
    sessionManager: {
      getBranch: () => branchRef.value,
      getSessionId: () => "session-1",
      buildSessionProjection: () => {
        projectionsBuilt++;
        return { messages: projectionMessages };
      },
    },
    ui: {
      notify() {},
      setFooter(factory) {
        component = factory(
          { requestRender() {} },
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
