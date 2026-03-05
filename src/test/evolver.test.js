import test from "node:test";
import assert from "node:assert/strict";
import { Evolver } from "../evolver.js";

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
    this.removedLabels = [];
    this.closed = [];
    this.created = [];
    this.createdPullRequests = [];
    this.updatedPullRequests = [];
    this.pullRequestComments = [];
    this.merged = [];
    this.issue = { number: 11, title: "Implement thing", body: "details", labels: [] };
    this.pr = null;
  }

  async ensurePromptIssue() {}
  async listOpenIssues() { return [this.issue]; }
  async findOpenIssueByTitle() { return undefined; }
  async addLabels(issueNumber, labels) { this.labels.push({ issueNumber, labels }); }
  async removeLabels(issueNumber, labels) { this.removedLabels.push({ issueNumber, labels }); }
  async closeIssue(issueNumber) { this.closed.push(issueNumber); }
  async commentOnIssue(issueNumber, message) { this.comments.push({ issueNumber, message }); }
  async findOpenPullRequestForIssue() { return this.pr; }
  async createPullRequest(data) {
    this.pr = { number: 44, ...data };
    this.createdPullRequests.push(data);
    return this.pr;
  }
  async updatePullRequest(prNumber, data) {
    this.pr = { ...this.pr, number: prNumber, ...data };
    this.updatedPullRequests.push({ prNumber, data });
    return this.pr;
  }
  async commentOnPullRequest(prNumber, message) { this.pullRequestComments.push({ prNumber, message }); }
  async mergePullRequest(prNumber) { this.merged.push(prNumber); return true; }
  async createIssue(title, body) { this.created.push({ title, body }); return 99; }
}

class MultiIssueGitHub extends StubGitHub {
  constructor() {
    super();
    this.issue = { number: 11, title: "Issue 11", body: "a", labels: [] };
    this.secondIssue = { number: 22, title: "Issue 22", body: "b", labels: [] };
  }

  async listOpenIssues() {
    return [this.issue, this.secondIssue];
  }
}

class StubWorkspace {
  constructor(options = {}) {
    this.branchName = options.branchName ?? "evolvo/issue-11-implement-thing";
    this.validationResults = options.validationResults ?? [{ passed: true, summary: "ok" }];
    this.validationIndex = 0;
    this.commitResults = options.commitResults ?? null;
    this.commitIndex = 0;
    this.touchedFiles = [];
    this.cleaned = false;
    this.commitCalls = [];
    this.shouldLeaveDirty = options.shouldLeaveDirty ?? false;
  }

  prepareBranch() {
    return this.branchName;
  }

  getBranchName() {
    return this.branchName;
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
    if (!this.touchedFiles.includes(path)) {
      this.touchedFiles.push(path);
    }
    return `wrote ${path}`;
  }

  deleteFile(path) {
    this.touchedFiles = this.touchedFiles.filter((item) => item !== path);
    return `deleted ${path}`;
  }

  showDiff() {
    return "diff";
  }

  diffAgainstBase() {
    return "diff against base";
  }

  runValidation() {
    const validation = this.validationResults[Math.min(this.validationIndex, this.validationResults.length - 1)];
    this.validationIndex += 1;
    return validation;
  }

  commitAndPush(issue, prTitle) {
    this.commitCalls.push({ issueNumber: issue.number, prTitle, touchedFiles: [...this.touchedFiles] });
    const configured = this.commitResults?.[Math.min(this.commitIndex, this.commitResults.length - 1)];
    this.commitIndex += 1;

    const result = configured ?? {
      changed: this.touchedFiles.length > 0,
      pushed: this.touchedFiles.length > 0,
      branchName: this.branchName,
      commitSha: "abc123"
    };

    if (result.changed) {
      this.touchedFiles = [];
    }

    return {
      branchName: this.branchName,
      commitSha: "abc123",
      ...result
    };
  }

  hasUncommittedChanges() {
    return this.shouldLeaveDirty || this.commitCalls.length === 0 && this.touchedFiles.length > 0;
  }

  cleanup() {
    this.cleaned = true;
  }
}

class StubPerformance {
  constructor() {
    this.snapshots = [];
  }

  latest() {
    return this.snapshots.at(-1);
  }

  record(snapshot) {
    this.snapshots.push(snapshot);
    return snapshot;
  }
}

function createEvolver({ plannerResponses, reviewerResponses, github = new StubGitHub(), workspace, options = {} }) {
  const planner = new SequenceModel(plannerResponses);
  const reviewer = new SequenceModel(reviewerResponses);
  const performance = new StubPerformance();
  const evolver = new Evolver(planner, reviewer, github, performance, {
    maxIssueAttempts: options.maxIssueAttempts ?? 1,
    maxPrFixRounds: options.maxPrFixRounds ?? 2,
    maxAgentSteps: options.maxAgentSteps ?? 6,
    dryRun: true,
    maxLoops: 1,
    loopDelayMs: 0,
    workspaceFactory: () => workspace
  });

  return { evolver, github, performance };
}

test("Evolver opens, reviews, and merges a PR after executing an issue", async () => {
  const workspace = new StubWorkspace();
  const { evolver, github, performance } = createEvolver({
    plannerResponses: [
      '{"action":"work","issueNumber":11}',
      '{"action":"write_file","path":"src/feature.js","content":"export const feature = true;"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"implemented","rationale":"added feature","prTitle":"Implement thing"}'
    ],
    reviewerResponses: [
      '{"decision":"approve","body":"looks good","rationale":"validation passed"}'
    ],
    workspace
  });

  const result = await evolver.run();

  assert.equal(result.restartRequested, true);
  assert.equal(github.createdPullRequests.length, 1);
  assert.equal(github.pullRequestComments.length, 1);
  assert.deepEqual(github.merged, [44]);
  assert.deepEqual(github.closed, [11]);
  assert.equal(performance.snapshots[0].merged, true);
  assert.equal(workspace.cleaned, true);
});

test("Evolver can choose a non-first issue based on autonomous evaluation", async () => {
  const workspace = new StubWorkspace({ branchName: "evolvo/issue-22-issue-22" });
  const github = new MultiIssueGitHub();
  const { evolver } = createEvolver({
    plannerResponses: [
      '{"action":"work","issueNumber":22}',
      '{"action":"write_file","path":"src/feature.js","content":"export const feature = true;"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"implemented issue 22","prTitle":"Issue 22"}'
    ],
    reviewerResponses: [
      '{"decision":"approve","body":"looks good"}'
    ],
    github,
    workspace
  });

  const result = await evolver.run();
  assert.equal(result.restartRequested, true);
  assert.equal(github.closed[0], 22);
});

test("Evolver runs another fix cycle when self-review requests changes", async () => {
  const workspace = new StubWorkspace({
    validationResults: [
      { passed: true, summary: "initial validation ok" },
      { passed: true, summary: "fixed validation ok" }
    ]
  });
  const { evolver, github, performance } = createEvolver({
    plannerResponses: [
      '{"action":"work","issueNumber":11}',
      '{"action":"write_file","path":"src/feature.js","content":"export const feature = true;"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"implemented","prTitle":"Implement thing"}',
      '{"action":"write_file","path":"src/feature.js","content":"export const feature = 2;"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"fixed review feedback","rationale":"addressed comments","prTitle":"Implement thing"}'
    ],
    reviewerResponses: [
      '{"decision":"request_changes","body":"Please adjust the feature","rationale":"needs revision"}',
      '{"decision":"approve","body":"Looks good now","rationale":"fixed"}'
    ],
    workspace
  });

  const result = await evolver.run();

  assert.equal(result.restartRequested, true);
  assert.equal(github.createdPullRequests.length, 1);
  assert.equal(github.updatedPullRequests.length, 1);
  assert.equal(github.pullRequestComments.length, 2);
  assert.equal(performance.snapshots[0].reviewRounds, 2);
});

test("Evolver labels the issue when a review follow-up produces no new diff", async () => {
  const workspace = new StubWorkspace({
    validationResults: [
      { passed: true, summary: "initial validation ok" },
      { passed: true, summary: "follow-up validation ok" }
    ],
    commitResults: [
      { changed: true, pushed: true, branchName: "evolvo/issue-11-implement-thing", commitSha: "abc123" },
      { changed: false, pushed: false, branchName: "evolvo/issue-11-implement-thing", reason: "No touched files were recorded." }
    ]
  });
  const { evolver, github, performance } = createEvolver({
    plannerResponses: [
      '{"action":"work","issueNumber":11}',
      '{"action":"write_file","path":"src/feature.js","content":"export const feature = true;"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"implemented","prTitle":"Implement thing"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"rechecked review feedback","rationale":"no additional safe diff identified","prTitle":"Implement thing"}'
    ],
    reviewerResponses: [
      '{"decision":"request_changes","body":"Please adjust the feature","rationale":"needs revision"}'
    ],
    workspace
  });

  const result = await evolver.run();

  assert.equal(result.restartRequested, false);
  assert.equal(github.createdPullRequests.length, 1);
  assert.equal(github.updatedPullRequests.length, 0);
  assert.ok(github.labels.some((entry) => entry.labels.includes("needs-human-intervention")));
  assert.match(github.comments.at(-1).message, /produced no new diff/i);
  assert.equal(performance.snapshots[0].reviewRounds, 1);
  assert.equal(performance.snapshots[0].merged, false);
  assert.equal(workspace.cleaned, true);
});

test("Evolver labels the issue when validation never reaches a passing finish", async () => {
  const workspace = new StubWorkspace({
    validationResults: [{ passed: false, summary: "tests failed" }],
    shouldLeaveDirty: true
  });
  const { evolver, github } = createEvolver({
    plannerResponses: [
      '{"action":"work","issueNumber":11}',
      '{"action":"write_file","path":"src/feature.js","content":"broken"}',
      '{"action":"run_validation"}',
      '{"action":"finish","summary":"done"}'
    ],
    reviewerResponses: [],
    workspace,
    options: {
      maxAgentSteps: 4
    }
  });

  const result = await evolver.run();

  assert.equal(result.restartRequested, false);
  assert.equal(result.halted, true);
  assert.equal(github.merged.length, 0);
  assert.ok(github.labels.some((entry) => entry.labels.includes("needs-human-intervention")));
});
