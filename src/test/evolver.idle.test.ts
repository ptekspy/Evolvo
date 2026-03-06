import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Evolver } from "../evolver.js";
import { createNoopLogger } from "../logger.js";

class SequenceModel {
  private readonly responses: string[];
  private index: number;

  constructor(responses: string[]) {
    this.responses = responses;
    this.index = 0;
  }

  async complete(): Promise<string> {
    const value = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "{\"issues\":[]}";
    this.index += 1;
    return value;
  }
}

class StubGitHub {
  public readonly created: Array<{ title: string; body: string; labels: string[] }> = [];
  public readonly comments: Array<{ issueNumber: number; message: string }> = [];
  private readonly issues: Array<{ number: number; title: string; body?: string; labels?: Array<{ name: string }> }> = [];

  async ensurePromptIssue(): Promise<void> {}

  async listOpenIssues(): Promise<Array<{ number: number; title: string; body?: string; labels?: Array<{ name: string }> }>> {
    return [...this.issues];
  }

  async findOpenIssueByTitle(title: string): Promise<{ number: number; title: string } | undefined> {
    return this.issues.find((issue) => issue.title === title);
  }

  async createIssue(title: string, body: string, labels: string[] = []): Promise<number> {
    const number = 100 + this.created.length;
    this.created.push({ title, body, labels });
    this.issues.push({
      number,
      title,
      body,
      labels: labels.map((name) => ({ name }))
    });
    return number;
  }

  async commentOnIssue(issueNumber: number, message: string): Promise<void> {
    this.comments.push({ issueNumber, message });
  }
}

class StubPerformance {
  latest(): Record<string, unknown> | undefined {
    return {
      issueNumber: 12,
      merged: true,
      validationPassed: true
    };
  }

  record(snapshot: Record<string, unknown>): Record<string, unknown> {
    return snapshot;
  }
}

test("Evolver creates self-evolution issues during idle loops", async () => {
  const planner = new SequenceModel([
    JSON.stringify({
      issues: [
        {
          title: "Improve idle planning coverage",
          body: "Add stronger automated coverage for idle self-planning behavior."
        }
      ],
      requestChallenge: true
    })
  ]);
  const github = new StubGitHub();
  const evolver = new Evolver(planner, planner, github as never, new StubPerformance() as never, {
    maxLoops: 1,
    loopDelayMs: 0,
    dryRun: true,
    logger: createNoopLogger()
  });

  const result = await evolver.run();

  assert.equal(result.restartRequested, false);
  assert.deepEqual(
    github.created.map((issue) => issue.title),
    [
      "Improve idle planning coverage",
      "Challenge request: evaluate Evolvo capability growth"
    ]
  );
  assert.equal(github.comments.length, 2);
});
