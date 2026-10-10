// `opl-input` re-frames the stock pi-tui editor output, which means it has to recognise
// pi-tui's border and scroll-indicator lines. pi-tui exposes neither as an API, so the
// coupling is text: `─` borders and `─── ↑ 3 more `. These tests pin both halves - the
// classifiers keep working, and the installed pi-tui still emits those exact markers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "bun:test";

import { isBorderLike, isSolidBorder, scrollIndicatorText } from "../extensions/opl-input/index.ts";

const require = createRequire(import.meta.url);
const editorModule = require.resolve("@earendil-works/pi-tui/dist/components/editor.js");
const editorSource = readFileSync(editorModule, "utf8");
const piTuiVersion = require("@earendil-works/pi-tui/package.json").version;

test("border and scroll lines are recognised, content lines are not", () => {
  const colour = (s) => `\u001b[38;5;244m${s}\u001b[39m`;
  assert.equal(isSolidBorder(colour("─".repeat(42))), true);
  assert.equal(isSolidBorder("hello"), false);
  assert.equal(isSolidBorder("─ mixed ─"), false, "a border with content inside is not solid");

  assert.equal(scrollIndicatorText(colour("─── ↑ 3 more ")), "↑ 3 more");
  assert.equal(scrollIndicatorText("─── ↓ 12 more"), "↓ 12 more");
  assert.equal(scrollIndicatorText("───────"), null, "a plain border carries no indicator");
  assert.equal(scrollIndicatorText("↑ 3 more"), null, "the indicator line must start with the border");
  assert.equal(scrollIndicatorText("↑ more"), null, "a count is required");

  assert.equal(isBorderLike("─── ↑ 3 more "), true);
  assert.equal(isBorderLike("─".repeat(10)), true);
  assert.equal(isBorderLike("export const x = 1;"), false);
});

test("the pi-tui text this extension sniffs is still there", () => {
  // Measured byte-identical in 0.87.0, 0.99.1 and 1.1.0. If this fails, pi-tui changed the
  // editor's border or scroll-indicator format and opl-input's re-framing must be updated.
  assert.ok(
    editorSource.includes("`─── ${direction} ${hiddenLineCount} more `"),
    `pi-tui ${piTuiVersion} no longer builds the scroll indicator this way`,
  );
  assert.ok(
    editorSource.includes("const label = ` ${direction} ${hiddenLineCount} more `"),
    `pi-tui ${piTuiVersion} no longer builds the indicator label this way`,
  );
});
