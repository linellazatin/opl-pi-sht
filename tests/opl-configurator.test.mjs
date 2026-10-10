// The /configurator seam: opl-configurator owns a generic tabbed shell and reads a
// globalThis registry that instrumented extensions publish into. Because install.sh copies
// one extension directory at a time, the two sides cannot share an import, so this pins
// that the registry key and tab contract match, and that the shell reads defensively.
import assert from "node:assert/strict";
import { test } from "bun:test";

import { CONFIGURATOR_REGISTRY_KEY, readConfiguratorTabs, showConfigurator } from "../extensions/opl-configurator/configurator.ts";
import { CONFIGURATOR_REGISTRY_KEY as footerKey, registerFooterConfiguratorTab } from "../extensions/opl-footer/configure.ts";
import { CONFIGURATOR_REGISTRY_KEY as inputKey, companionTypeValues, registerInputConfiguratorTab } from "../extensions/opl-input/configure.ts";

function withGlobal(name, value, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const prev = globalThis[name];
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
  try {
    return run();
  } finally {
    if (had) globalThis[name] = prev;
    else delete globalThis[name];
  }
}

const validTab = (overrides = {}) => ({
  id: "opl-x",
  hotkey: "x",
  label: "X",
  create: () => ({ render: () => [] }),
  ...overrides,
});

test("both sides agree on the registry key", () => {
  assert.equal(CONFIGURATOR_REGISTRY_KEY, footerKey);
  assert.equal(CONFIGURATOR_REGISTRY_KEY, inputKey);
  assert.equal(CONFIGURATOR_REGISTRY_KEY, "__oplConfiguratorTabs");
});

test("readConfiguratorTabs is empty when nothing is registered or the value is not an array", () => {
  withGlobal(CONFIGURATOR_REGISTRY_KEY, undefined, () => {
    assert.deepEqual(readConfiguratorTabs(), []);
  });
  withGlobal(CONFIGURATOR_REGISTRY_KEY, { tabs: [] }, () => {
    assert.deepEqual(readConfiguratorTabs(), []);
  });
});

test("readConfiguratorTabs drops malformed entries and keeps valid ones in order", () => {
  const good1 = validTab({ id: "a", hotkey: "a" });
  const good2 = validTab({ id: "b", hotkey: "b" });
  const cases = [
    null,
    7,
    "tab",
    validTab({ id: "" }),
    validTab({ id: "c", hotkey: "" }),
    validTab({ id: "d", hotkey: "X" }),
    validTab({ id: "e", hotkey: "ab" }),
    validTab({ id: "f", label: "" }),
    validTab({ id: "g", create: "nope" }),
  ];
  withGlobal(CONFIGURATOR_REGISTRY_KEY, [cases[0], good1, ...cases.slice(1), good2], () => {
    assert.deepEqual(readConfiguratorTabs().map((tab) => tab.id), ["a", "b"]);
  });
});

test("readConfiguratorTabs keeps the first id and the first hotkey", () => {
  const first = validTab({ id: "dup", hotkey: "h" });
  withGlobal(CONFIGURATOR_REGISTRY_KEY, [
    first,
    validTab({ id: "dup", hotkey: "other" }),
    validTab({ id: "other", hotkey: "h" }),
    validTab({ id: "later", hotkey: "l" }),
  ], () => {
    assert.deepEqual(readConfiguratorTabs().map((tab) => tab.id), ["dup", "later"]);
    assert.equal(readConfiguratorTabs()[0], first);
  });
});

test("registerFooterConfiguratorTab publishes a well-formed, unique footer tab", () => {
  withGlobal(CONFIGURATOR_REGISTRY_KEY, undefined, () => {
    registerFooterConfiguratorTab(() => {});
    registerFooterConfiguratorTab(() => {});

    const raw = globalThis[CONFIGURATOR_REGISTRY_KEY];
    assert.ok(Array.isArray(raw), "registry must be an array after registration");
    assert.equal(raw.length, 1, "a second registration must not append a duplicate");

    const tab = raw[0];
    assert.equal(tab.id, "opl-footer");
    assert.equal(tab.hotkey, "f");
    assert.equal(tab.label, "Footer");
    assert.equal(typeof tab.create, "function");
  });
});

test("registerInputConfiguratorTab publishes a well-formed, unique input tab", () => {
  withGlobal(CONFIGURATOR_REGISTRY_KEY, undefined, () => {
    registerInputConfiguratorTab();
    registerInputConfiguratorTab();

    const raw = globalThis[CONFIGURATOR_REGISTRY_KEY];
    assert.ok(Array.isArray(raw), "registry must be an array after registration");
    assert.equal(raw.length, 1, "a second registration must not append a duplicate");

    const tab = raw[0];
    assert.equal(tab.id, "opl-input");
    assert.equal(tab.hotkey, "i");
    assert.equal(tab.label, "Input");
    assert.equal(typeof tab.create, "function");
  });
});

test("companionTypeValues starts with built-ins and folds in declared plus current types", () => {
  assert.deepEqual(companionTypeValues({}), ["cat", "dog", "bunny"]);
  assert.deepEqual(companionTypeValues({ companion: {} }), ["cat", "dog", "bunny"]);
  assert.deepEqual(companionTypeValues({ companion: { type: "otter" } }), ["cat", "dog", "bunny", "otter"]);
  assert.deepEqual(
    companionTypeValues({ companion: { type: "dog", types: [{ typeName: "otter" }, { typeName: "cat" }, { typeName: 7 }, null] } }),
    ["cat", "dog", "bunny", "otter"],
  );
});

test("the shell reserves esc, focuses tabs by hotkey, and delegates everything else", () => {
  const delegated = [];
  const makeTab = (id, hotkey, label, output) => ({
    id,
    hotkey,
    label,
    create: () => ({
      render: () => [output],
      handleInput: (data) => delegated.push(`${id}:${data}`),
    }),
  });

  withGlobal(
    CONFIGURATOR_REGISTRY_KEY,
    [makeTab("a", "a", "Alpha", "A-UI"), makeTab("b", "b", "Beta", "B-UI")],
    () => {
      let doneCalls = 0;
      let captured;
      const theme = { fg: (name, text) => `${name}:${text}`, bold: (text) => text };
      const ctx = {
        mode: "tui",
        ui: {
          notify() {},
          custom(factory) {
            captured = factory({ requestRender() {} }, theme, {}, () => { doneCalls++; });
            return Promise.resolve(undefined);
          },
        },
      };

      // Runs synchronously until its first await, so the factory has run and `captured` is set.
      showConfigurator(ctx);

      const r0 = captured.render(80).join("\n");
      assert.ok(r0.includes("accent:[a] Alpha"), "first tab starts focused");
      assert.ok(r0.includes("dim:[b] Beta"));
      assert.ok(r0.includes("A-UI"), "active tab renders its body");

      captured.handleInput("b");
      const r1 = captured.render(80).join("\n");
      assert.ok(r1.includes("dim:[a] Alpha"));
      assert.ok(r1.includes("accent:[b] Beta"));
      assert.ok(r1.includes("B-UI"));

      assert.doesNotThrow(() => captured.invalidate());

      captured.handleInput("z");
      assert.deepEqual(delegated, ["b:z"], "non-hotkey input reaches the focused tab");

      captured.handleInput("\x1b");
      assert.equal(doneCalls, 1, "escape closes the shell");
    },
  );
});