// Regression tests for opl-input mode-style resolution. Requires Bun.
// Run: bun tests/opl-input-style.test.mjs
import assert from "node:assert/strict";
import { resolveModeStyle } from "../extensions/opl-input/mode-style.ts";

assert.deepEqual(resolveModeStyle({ bash: false, mode: "off" }), {
	borderColor: "border",
	prefixColor: "accent",
	prefix: "❯",
});

assert.deepEqual(resolveModeStyle({ bash: false, mode: "chat" }), {
	borderColor: "chatModeBorder",
	prefixColor: "chatModeBorder",
	prefix: "»",
});

assert.deepEqual(resolveModeStyle({ bash: false, mode: "plan" }), {
	borderColor: "customMessageLabel",
	prefixColor: "customMessageLabel",
	prefix: "⏸",
});

assert.deepEqual(resolveModeStyle({ bash: false, mode: "execute" }), {
	borderColor: "customMessageLabel",
	prefixColor: "customMessageLabel",
	prefix: "⏸",
});

assert.deepEqual(resolveModeStyle({ bash: false, mode: "chat", appearance: {
	prefix: "󰭻", prefixColor: "#157cd6", borderColor: "#157cd6",
} }), {
	borderColor: "#157cd6",
	prefixColor: "#157cd6",
	prefix: "󰭻",
});

assert.deepEqual(resolveModeStyle({ bash: false, mode: "research", appearance: {
	prefixColor: "warning",
} }), {
	borderColor: "border",
	prefixColor: "warning",
	prefix: "❯",
});

assert.equal(resolveModeStyle({ bash: true, mode: "research", appearance: {
	prefixColor: "warning",
} }).prefixColor, "bashMode");

console.log("opl-input style resolution test passed");
