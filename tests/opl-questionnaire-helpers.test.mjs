import assert from "node:assert/strict";
import { test } from "bun:test";
import questionnaire, { errorResult, validateQuestions } from "../extensions/opl-questionnaire/index.ts";

function q(id, options = [{ value: "a", label: "A" }], allowOther = true) {
  return { id, label: id, prompt: `Q ${id}?`, options, allowOther };
}

for (const cancelled of [false, true]) {
  test(`questionnaire passes blocked metadata and preserves ${cancelled ? "cancellation" : "answers"}`, async () => {
    let tool;
    questionnaire({ registerTool: (definition) => { tool = definition; } });
    const params = { questions: [q("scope")] };
    const snapshot = structuredClone(params);
    const dialogResult = { questions: params.questions, cancelled, answers: cancelled ? [] : [
      { id: "scope", value: "a", label: "A", wasCustom: false, index: 1 },
    ] };
    let capturedOptions;
    const result = await tool.execute("fixture", params, undefined, undefined, {
      mode: "tui", ui: { custom: async (factory, options) => {
        assert.equal(typeof factory, "function");
        capturedOptions = options;
        return dialogResult;
      } },
    });
    assert.deepEqual(capturedOptions, { overlay: false, blocked: { kind: "question", message: "Answer the questionnaire" } });
    assert.deepEqual(result.details, dialogResult);
    assert.equal(result.content[0].text, cancelled ? "User cancelled the questionnaire" : "scope: user selected: 1. A");
    assert.deepEqual(params, snapshot);
  });
}

test("questionnaire errors do not open a custom dialog", async () => {
  let tool;
  questionnaire({ registerTool: (definition) => { tool = definition; } });
  const ui = { custom: () => { throw new Error("must not open a dialog"); } };
  for (const [mode, questions] of [["print", [q("scope")]], ["tui", []], ["tui", [q("")]]]) {
    const result = await tool.execute("fixture", { questions }, undefined, undefined, { mode, ui });
    assert.equal(result.isError, true);
    assert.equal(result.details.cancelled, false);
  }
});

test("errorResult is marked as an error, never a cancellation", () => {
  const result = errorResult("Error: No questions provided");
  assert.equal(result.isError, true);
  assert.equal(result.details.cancelled, false);
  assert.deepEqual(result.details.answers, []);
  assert.equal(result.content[0].text, "Error: No questions provided");
});

test("validateQuestions rejects a blank id", () => {
  assert.equal(validateQuestions([q("")]), "Error: Question id must be a non-empty string");
  assert.equal(validateQuestions([q("   ")]), "Error: Question id must be a non-empty string");
});

test("validateQuestions rejects duplicate ids", () => {
  assert.equal(
    validateQuestions([q("scope"), q("scope")]),
    'Error: Duplicate question id "scope" — question ids must be unique',
  );
});

test("validateQuestions rejects unselectable questions", () => {
  assert.equal(
    validateQuestions([q("scope", [], false)]),
    'Error: Question "scope" has no options and allowOther is false — nothing is selectable',
  );
});

test("validateQuestions accepts well-formed questions", () => {
  assert.equal(
    validateQuestions([q("scope"), q("priority", [{ value: "hi", label: "High" }], false)]),
    null,
  );
});