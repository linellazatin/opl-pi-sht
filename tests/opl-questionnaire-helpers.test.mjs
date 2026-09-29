import assert from "node:assert/strict";
import { test } from "bun:test";
import { errorResult, validateQuestions } from "../extensions/opl-questionnaire/index.ts";

function q(id, options = [{ value: "a", label: "A" }], allowOther = true) {
  return { id, label: id, prompt: `Q ${id}?`, options, allowOther };
}

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