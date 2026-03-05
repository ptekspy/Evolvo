import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionSession } from "../executionSession.js";

class SequenceModel {
  constructor(responses) {
    this.responses = responses;
    this.index = 0;
  }

  async complete() {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

class StubWorkspace {
  constructor(validations = [{ passed: true, summary: "ok" }]) {
    this.validations = validations;
    this.validationIndex = 0;
    this.touchedFiles = [];
  }

  getBranchName() {
    return "evolvo/issue-1-test";
  }

  getTouchedFiles() {
    return [...this.touchedFiles];
  }

  listFiles() {
    return "src/index.js";
  }

  searchCode(query) {
    return `src/index.js:1:${query}`;
  }

  readFiles(paths) {
    return paths.join("\n");
  }

  writeFile(path) {
    this.touchedFiles.push(path);
    return `wrote ${path}`;
  }

  deleteFile(path) {
    this.touchedFiles = this.touchedFiles.filter((item) => item !== path);
    return `deleted ${path}`;
  }

  showDiff() {
    return "diff";
  }

  runValidation() {
    const validation = this.validations[Math.min(this.validationIndex, this.validations.length - 1)];
    this.validationIndex += 1;
    return validation;
  }
}

test("ExecutionSession completes a valid action loop", async () => {
  const planner = new SequenceModel([
    '{"action":"write_file","path":"src/feature.ts","content":"export const feature = true;"}',
    '{"action":"run_validation"}',
    '{"action":"finish","summary":"implemented feature","rationale":"added feature","prTitle":"Add feature"}'
  ]);
  const workspace = new StubWorkspace();
  const session = new ExecutionSession(planner, workspace, { maxSteps: 5 });

  const result = await session.run({ number: 1, title: "Implement feature", body: "details" }, { attempt: 1 });

  assert.equal(result.status, "done");
  assert.equal(result.summary, "implemented feature");
  assert.equal(result.validation.passed, true);
});

test("ExecutionSession retries within the same session after validation failure", async () => {
  const planner = new SequenceModel([
    '{"action":"write_file","path":"src/feature.ts","content":"broken"}',
    '{"action":"run_validation"}',
    '{"action":"finish","summary":"done"}',
    '{"action":"write_file","path":"src/feature.ts","content":"fixed"}',
    '{"action":"run_validation"}',
    '{"action":"finish","summary":"done","rationale":"after fixing validation"}'
  ]);
  const workspace = new StubWorkspace([
    { passed: false, summary: "tests failed" },
    { passed: true, summary: "tests passed" }
  ]);
  const session = new ExecutionSession(planner, workspace, { maxSteps: 8 });

  const result = await session.run({ number: 1, title: "Implement feature", body: "details" }, { attempt: 1 });

  assert.equal(result.status, "done");
  assert.equal(result.validation.passed, true);
  assert.equal(workspace.validationIndex, 2);
});

test("ExecutionSession fails after repeated malformed JSON responses", async () => {
  const planner = new SequenceModel([
    "not json",
    "still not json",
    "also not json"
  ]);
  const workspace = new StubWorkspace();
  const session = new ExecutionSession(planner, workspace, {
    maxSteps: 2,
    maxMalformedResponses: 3
  });

  const result = await session.run({ number: 1, title: "Implement feature", body: "details" }, { attempt: 1 });

  assert.equal(result.status, "stuck");
  assert.match(result.summary, /Malformed planner response limit reached/);
});
