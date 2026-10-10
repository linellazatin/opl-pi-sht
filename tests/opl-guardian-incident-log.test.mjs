import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { buildIncidentRecord } from "../extensions/opl-guardian/guardian.ts";
import { appendIncident, guardMessageEnd } from "../extensions/opl-guardian/index.ts";
import { DEFAULT_CONFIG, incidentLogPath, parseGuardianConfig } from "../extensions/opl-guardian/config.ts";

function toolCall(id, name, arguments_ = {}) {
  return { type: "toolCall", id, name, arguments: arguments_ };
}

function assistantWith(content) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
    responseId: "gen-test",
    timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    stopReason: "toolUse",
  };
}

/** Point pi's agent directory at a fixture, run, then restore. */
async function withAgentDir(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "opl-guardian-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(agentDir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(agentDir, { recursive: true, force: true });
  }
}

const record = (cwd = "/repo") =>
  buildIncidentRecord(assistantWith([]), { sessionId: "session-test", cwd }, [toolCall("call_bad", "")]);

test("incidents land in the agent directory and never in the open repository", async () => {
  await withAgentDir(async (agentDir) => {
    const repo = await mkdtemp(join(tmpdir(), "opl-guardian-repo-"));
    try {
      const incident = record(repo);
      await appendIncident(incident);
      assert.equal(existsSync(join(repo, "err")), false, "the session directory stays clean");
      const log = readFileSync(join(agentDir, "guardian-incidents.jsonl"), "utf8");
      assert.deepEqual(JSON.parse(log.trim()), incident);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("the default path re-resolves per call, and overrides are honoured", async () => {
  await withAgentDir(async (agentDir) => {
    assert.equal(incidentLogPath(DEFAULT_CONFIG.logging), join(agentDir, "guardian-incidents.jsonl"));
    assert.equal(incidentLogPath({ incidentFile: false, maxBytes: 1024 }), null);
    assert.equal(incidentLogPath({ incidentFile: "nested/g.jsonl", maxBytes: 1024 }), join(agentDir, "nested", "g.jsonl"));
    assert.equal(incidentLogPath({ incidentFile: "/var/log/g.jsonl", maxBytes: 1024 }), "/var/log/g.jsonl");
    assert.equal(incidentLogPath({ incidentFile: "~/g.jsonl", maxBytes: 1024 }).endsWith("/g.jsonl"), true);

    const elsewhere = await mkdtemp(join(tmpdir(), "opl-guardian-abs-"));
    try {
      await appendIncident(record(), { incidentFile: join(elsewhere, "custom.jsonl"), maxBytes: 4096 });
      assert.equal(existsSync(join(elsewhere, "custom.jsonl")), true);
      await appendIncident(record(), { incidentFile: "nested/guardian.jsonl", maxBytes: 4096 });
      assert.equal(existsSync(join(agentDir, "nested", "guardian.jsonl")), true);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

test("incidentFile false stops writing entirely", async () => {
  await withAgentDir(async (agentDir) => {
    await appendIncident(record(), { incidentFile: false, maxBytes: 4096 });
    assert.deepEqual(readdirSync(agentDir), [], "nothing is created when logging is off");
    const replacement = await guardMessageEnd(assistantWith([toolCall("call_bad", "")]), {
      cwd: "/repo",
      sessionId: "session-test",
      logging: { incidentFile: false, maxBytes: 4096 },
    });
    assert.match(replacement.message.content[0].text, /incident logging is off/);
    assert.deepEqual(readdirSync(agentDir), []);
  });
});

test("the incident log rotates instead of growing without bound", async () => {
  await withAgentDir(async (agentDir) => {
    const logPath = join(agentDir, "guardian-incidents.jsonl");
    const logging = { incidentFile: null, maxBytes: 400 };
    for (const marker of ["a", "b", "c", "d", "e"]) {
      await appendIncident(
        buildIncidentRecord(assistantWith([]), { sessionId: marker, cwd: "/repo" }, [toolCall(marker, "")]),
        logging,
      );
    }
    assert.equal(existsSync(`${logPath}.1`), true, "one generation of history is kept");
    assert.ok(statSync(logPath).size <= 400, `current log holds ${statSync(logPath).size} bytes over a 400 byte cap`);
    assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1, "rotation starts a fresh file");
  });
});

test("records carry argument names, not argument values", async () => {
  await withAgentDir(async (agentDir) => {
    const secret = "must-not-be-logged";
    const replacement = await guardMessageEnd(
      assistantWith([toolCall("call_bad", "", { path: `/home/lines/${secret}`, command: `echo ${secret}` })]),
      { cwd: "/repo", sessionId: "session-test" },
    );
    assert.ok(replacement);
    const log = readFileSync(join(agentDir, "guardian-incidents.jsonl"), "utf8");
    assert.ok(!log.includes(secret), "no argument value reaches the log");
    const entry = JSON.parse(log.trim());
    assert.deepEqual(entry.removedToolCalls[0].argumentKeys, ["command", "path"]);
    assert.ok(entry.removedToolCalls[0].argumentsBytes > 0);
    assert.equal(entry.removedToolCalls[0].name, "(unnamed)", "a blank tool name is recorded as such");
    assert.match(replacement.message.content[0].text, /guardian-incidents\.jsonl/, "the notice names the real file");
  });
});

test("config parsing defaults, validates and warns about the logging section", () => {
  const { config, warnings } = parseGuardianConfig(undefined);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.logging, { incidentFile: null, maxBytes: 256 * 1024 });

  const tuned = parseGuardianConfig({ logging: { incidentFile: "incidents.jsonl", maxBytes: 4096 } });
  assert.deepEqual(tuned.config.logging, { incidentFile: "incidents.jsonl", maxBytes: 4096 });
  assert.deepEqual(tuned.warnings, []);

  const off = parseGuardianConfig({ logging: { incidentFile: false } });
  assert.equal(off.config.logging.incidentFile, false);

  const junk = parseGuardianConfig({ logging: { incidentFile: 12, maxBytes: 10 } });
  assert.deepEqual(junk.config.logging, { incidentFile: null, maxBytes: 256 * 1024 });
  assert.equal(junk.warnings.length, 2, junk.warnings.join(" / "));

  const malformed = parseGuardianConfig({ logging: "yes" });
  assert.equal(malformed.config.logging.maxBytes, 256 * 1024);
  assert.match(malformed.warnings.join(), /Invalid logging section/);
});

test("the shipped sample documents the logging section", async () => {
  const sample = JSON.parse(
    readFileSync(
      new URL("../configs/opl-guardian.json.sample", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(typeof sample.logging, "object");
  assert.equal(typeof sample.logging.maxBytes, "number");
  assert.ok(JSON.stringify(sample).includes("guardian-incidents.jsonl"), "the comment names the default file");
});
