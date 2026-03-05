import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../github.js";

test("ensurePromptIssue creates first prompt issue when no issues exist", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const issue = await client.ensurePromptIssue();
  assert.equal(issue.number, -1);
  assert.match(issue.title, /Prompt Evolvo/);
});

test("findOpenPullRequestForIssue returns undefined in dry-run", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const pr = await client.findOpenPullRequestForIssue(1);
  assert.equal(pr, undefined);
});
