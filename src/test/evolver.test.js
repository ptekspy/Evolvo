import test from "node:test";
import assert from "node:assert/strict";
import { Evolver } from "../evolver.js";

class StubModel {
  constructor(response) {
    this.response = response;
  }

  async complete() {
    return this.response;
  }
}

class SequenceModel {
  constructor(responses) {
    this.responses = responses;
    this.index = 0;
  }

  async complete() {
    const value = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return value;
  }
}

class StubGitHub {
  constructor() {
    this.comments = [];
    this.labels = [];
    this.closed = [];
    this.created = [];
    this.issue = { number: 11, title: "Implement thing", body: "details", labels: [] };
    this.pr = { number: 44, title: "PR for #11", body: "Closes #11" };
  }

  async ensurePromptIssue() {}
  async listOpenIssues() { return [this.issue]; }
  async addLabels(issueNumber, labels) { this.labels.push({ issueNumber, labels }); }
  async closeIssue(issueNumber) { this.closed.push(issueNumber); }
  async commentOnIssue(issueNumber, message) { this.comments.push({ issueNumber, message }); }
  async findOpenPullRequestForIssue() { return this.pr; }
  async reviewPullRequest() {}
  async mergePullRequest() { return true; }
  async createIssue(title, body) { this.created.push({ title, body }); return 99; }
}

class MultiIssueGitHub extends StubGitHub {
  constructor() {
    super();
    this.issue = { number: 11, title: "Issue 11", body: "a", labels: [] };
    this.secondIssue = { number: 22, title: "Issue 22", body: "b", labels: [] };
    this.pr = { number: 52, title: "PR for #22", body: "Closes #22" };
  }

  async listOpenIssues() {
    return [this.issue, this.secondIssue];
  }

  async findOpenPullRequestForIssue(issueNumber) {
    if (issueNumber === 22) {
      return this.pr;
    }
    return undefined;
  }
}

class StubPerformance { latest() { return undefined; } }

test("Evolver processes one issue and requests restart after merge", async () => {
  const planner = new SequenceModel([
    '{"action":"work","issueNumber":11}',
    '{"status":"done","summary":"implemented"}'
  ]);
  const reviewer = new StubModel('{"decision":"approve","body":"looks good"}');
  const github = new StubGitHub();
  const evolver = new Evolver(planner, reviewer, github, new StubPerformance(), {
    maxIssueAttempts: 1,
    maxPrFixRounds: 1,
    dryRun: true,
    maxLoops: 1,
    loopDelayMs: 0
  });

  const result = await evolver.run();
  assert.equal(result.restartRequested, true);
  assert.equal(github.closed[0], 11);
  assert.ok(github.comments.length > 0);
});

test("Evolver can choose a non-first issue based on autonomous evaluation", async () => {
  const planner = new SequenceModel([
    '{"action":"work","issueNumber":22}',
    '{"status":"done","summary":"implemented issue 22"}'
  ]);
  const reviewer = new StubModel('{"decision":"approve","body":"looks good"}');
  const github = new MultiIssueGitHub();
  const evolver = new Evolver(planner, reviewer, github, new StubPerformance(), {
    maxIssueAttempts: 1,
    maxPrFixRounds: 1,
    dryRun: true,
    maxLoops: 1,
    loopDelayMs: 0
  });

  const result = await evolver.run();
  assert.equal(result.restartRequested, true);
  assert.equal(github.closed[0], 22);
});
