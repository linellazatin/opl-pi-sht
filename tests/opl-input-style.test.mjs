// Regression tests for opl-input mode-style resolution. Requires Bun.
// Run: bun tests/opl-input-style.test.mjs
import assert from "node:assert/strict";
import { resolveModeStyle } from "../extensions/opl-input/mode-style.ts";

const cfg = {
	PREFIX: "❯",
	BORDER_COLOR: "border",
	PREFIX_COLOR: "accent",
	PLAN_MODE_PREFIX: "⏸",
	PLAN_MODE_BORDER_COLOR: "customMessageLabel",
	PLAN_MODE_PREFIX_COLOR: "customMessageLabel",
	CHAT_MODE_PREFIX: "»",
	CHAT_MODE_BORDER_COLOR: "chatModeBorder",
	CHAT_MODE_PREFIX_COLOR: "chatModeBorder",
	MODES: {
		audit: { prefix: "⚑", prefixColor: "warning", borderColor: "#c07898" },
		partial: { prefix: "◐" },
		empty: {},
	},
};

// Default
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: false, custom: null }, cfg), {
	borderColor: "border",
	prefixColor: "accent",
	prefix: "❯",
});

// Bash wins over everything
assert.equal(resolveModeStyle({ bash: true, plan: true, chat: true, custom: "audit" }, cfg).prefixColor, "bashMode");

// Plan
assert.deepEqual(resolveModeStyle({ bash: false, plan: true, chat: false, custom: null }, cfg), {
	borderColor: "customMessageLabel",
	prefixColor: "customMessageLabel",
	prefix: "⏸",
});

// Chat
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: true, custom: null }, cfg), {
	borderColor: "chatModeBorder",
	prefixColor: "chatModeBorder",
	prefix: "»",
});

// Custom mode: full override incl. hex border
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: false, custom: "audit" }, cfg), {
	borderColor: "#c07898",
	prefixColor: "warning",
	prefix: "⚑",
});

// Custom mode with partial config falls back per-field to defaults
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: false, custom: "partial" }, cfg), {
	borderColor: "border",
	prefixColor: "accent",
	prefix: "◐",
});

// Custom mode with empty config equals default
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: false, custom: "empty" }, cfg), {
	borderColor: "border",
	prefixColor: "accent",
	prefix: "❯",
});

// Unknown custom mode equals default
assert.deepEqual(resolveModeStyle({ bash: false, plan: false, chat: false, custom: "ghost" }, cfg), {
	borderColor: "border",
	prefixColor: "accent",
	prefix: "❯",
});

console.log("opl-input style resolution test passed");
