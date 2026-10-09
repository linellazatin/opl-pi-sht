import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { TodoWidgetComponent, widgetMaxItems } from "../extensions/opl-todo/index.ts";

const theme = {
  fg: (_name, text) => text,
  bg: (_name, text) => text,
};

function makeTodos(count) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, text: `task ${i + 1}`, done: i % 3 === 0 }));
}

function body(count, rows) {
  const widget = new TodoWidgetComponent(makeTodos(count), theme, () => rows);
  return widget.render(60);
}

test("widgetMaxItems scales with the rows the renderer reports", () => {
  const small = widgetMaxItems(10);
  const large = widgetMaxItems(80);
  assert.ok(large > small, `expected ${large} > ${small}`);
});

test("widgetMaxItems never collapses below three items", () => {
  assert.equal(widgetMaxItems(1), 3);
  assert.equal(widgetMaxItems(8), 3);
  // 0 means "the renderer has not reported a height yet", which falls back to a standard screen.
  assert.equal(widgetMaxItems(0), widgetMaxItems(24));
});

test("the widget lists every todo when the terminal is tall enough", () => {
  const lines = body(4, 80);
  const listed = lines.filter((l) => /task \d/.test(l));
  assert.equal(listed.length, 4);
  // title + 4 rows + progress + footer
  assert.equal(lines.length, 7);
});

test("the widget collapses and reports the remainder on a short terminal", () => {
  const lines = body(20, 12);
  const listed = lines.filter((l) => /task \d/.test(l));
  assert.equal(listed.length, widgetMaxItems(12));
  assert.ok(lines.some((l) => /more/.test(l)), "the overflow marker is missing");
});

test("an empty list still renders a box", () => {
  const lines = body(0, 24);
  assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => l.includes("No active todos")));
});

test("the widget does not measure the harness terminal", () => {
  const src = readFileSync(new URL("../extensions/opl-todo/index.ts", import.meta.url), "utf-8");
  assert.ok(!src.includes("process.stdout.rows"), "the widget went back to process.stdout.rows");
  const widgetSrc = src.slice(src.indexOf("class TodoWidgetComponent"), src.indexOf("class TodoListComponent"));
  assert.match(widgetSrc, /widgetMaxItems\(/);
  assert.match(widgetSrc, /terminalRows/);
  // The overlay must be the thing that supplies the height.
  assert.match(src, /visible: \(w, h\) =>/);
});
