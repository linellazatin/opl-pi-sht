import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { configPath as browserConfigPath } from "../extensions/opl-browser/config.ts";
import { configPath as footerConfigPath } from "../extensions/opl-footer/config.ts";
import { loadGuardianConfig, configPath as guardianConfigPath } from "../extensions/opl-guardian/config.ts";
import { configPath as inputConfigPath } from "../extensions/opl-input/config.ts";
import { configPath as modesConfigPath } from "../extensions/opl-modes/config.ts";
import { authJsonPath, modelsJsonPath } from "../extensions/opl-simplebench/util/providers.ts";
import { configPath as simplebenchConfigPath, toolSupportCachePath } from "../extensions/opl-simplebench/util/config.ts";
import { configPath as todoConfigPath } from "../extensions/opl-todo/config.ts";
import { configPath as webaccessConfigPath } from "../extensions/opl-webaccess/config.ts";

// Pi's own resolver (0.87.0/dist/config.js:406, unchanged in 1.0.0) is
// PI_CODING_AGENT_DIR else ~/.pi/agent. PI_AGENT_DIR is not a pi variable.
// Every extension must agree, or `install.sh` writes configs the extension never reads.
function withAgentDir(fn) {
	const prev = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "opl-agent-"));
	mkdirSync(join(dir, "configs"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

const CONFIG_PATHS = [
	["opl-browser", browserConfigPath, "opl-browser.json"],
	["opl-footer", footerConfigPath, "opl-footer.json"],
	["opl-guardian", guardianConfigPath, "opl-guardian.json"],
	["opl-input", inputConfigPath, "opl-input.json"],
	["opl-modes", modesConfigPath, "opl-modes.json"],
	["opl-simplebench", simplebenchConfigPath, "opl-simplebench.json"],
	["opl-todo", todoConfigPath, "opl-todo.json"],
	["opl-webaccess", webaccessConfigPath, "opl-webaccess.json"],
];

test("config paths follow PI_CODING_AGENT_DIR", () => {
	withAgentDir((dir) => {
		for (const [name, resolve, file] of CONFIG_PATHS) {
			assert.equal(resolve(), join(dir, "configs", file), `${name} must read from the agent dir`);
		}
	});
});

test("config paths do not fall back to the home directory while PI_CODING_AGENT_DIR is set", () => {
	withAgentDir(() => {
		const home = join(homedir(), ".pi", "agent");
		for (const [name, resolve, file] of CONFIG_PATHS) {
			assert.notEqual(resolve(), join(home, "configs", file), `${name} still resolves under ${home}`);
		}
	});
});

test("opl-guardian reads the file it resolves", () => {
	withAgentDir((dir) => {
		// Absent file: defaults.
		assert.equal(loadGuardianConfig().config.dropMalformedToolCalls, true);
		writeFileSync(join(dir, "configs", "opl-guardian.json"), "{ not json");
		const { config, warnings } = loadGuardianConfig();
		assert.deepEqual(config, loadGuardianConfig().config);
		assert.equal(warnings.length, 1);
		assert.ok(
			warnings[0].includes(join(dir, "configs", "opl-guardian.json")),
			`warning must name the agent-dir path, got: ${warnings[0]}`,
		);
	});
});

test("opl-guardian honours a configured value under PI_CODING_AGENT_DIR", () => {
	withAgentDir((dir) => {
		writeFileSync(join(dir, "configs", "opl-guardian.json"), JSON.stringify({ dropMalformedToolCalls: false }));
		assert.equal(loadGuardianConfig().config.dropMalformedToolCalls, false);
	});
});

test("opl-simplebench resolves models.json, auth.json and its cache under the agent dir", () => {
	withAgentDir((dir) => {
		assert.equal(modelsJsonPath(), join(dir, "models.json"));
		assert.equal(authJsonPath(), join(dir, "auth.json"));
		assert.equal(toolSupportCachePath(), join(dir, "cache", "tool_support.json"));
	});
});

test("paths resolve again per call, so a late PI_CODING_AGENT_DIR is honoured", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/opl-agent-a";
		const a = guardianConfigPath();
		process.env.PI_CODING_AGENT_DIR = "/tmp/opl-agent-b";
		const b = guardianConfigPath();
		assert.equal(a, join("/tmp/opl-agent-a", "configs", "opl-guardian.json"));
		assert.equal(b, join("/tmp/opl-agent-b", "configs", "opl-guardian.json"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});
