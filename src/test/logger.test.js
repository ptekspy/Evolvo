import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleLogger } from "../logger.js";

function createSink() {
  const lines = [];
  return {
    lines,
    log(value) {
      lines.push(value);
    },
    info(value) {
      lines.push(value);
    },
    warn(value) {
      lines.push(value);
    },
    error(value) {
      lines.push(value);
    },
    debug(value) {
      lines.push(value);
    }
  };
}

test("ConsoleLogger formats child scopes and redacts sensitive fields", () => {
  const sink = createSink();
  const logger = new ConsoleLogger({
    level: "debug",
    scope: "evolvo",
    sink,
    clock: () => new Date("2026-03-05T12:00:00.000Z")
  });

  logger.child("workspace", { issueNumber: 7 }).info("Prepared branch", {
    branchName: "evolvo/issue-7-start-evolving",
    githubToken: "secret-token"
  });

  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0], /\[2026-03-05T12:00:00.000Z\] \| INFO \| evolvo\.workspace \| Prepared branch/);
  assert.match(sink.lines[0], /issueNumber=7/);
  assert.match(sink.lines[0], /githubToken=\[redacted\]/);
});
