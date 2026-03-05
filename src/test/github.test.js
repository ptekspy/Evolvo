import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../github.js";

test("ensurePromptIssue creates first prompt issue when no issues exist", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const issue = await client.ensurePromptIssue();
  assert.equal(issue.number, -1);
  assert.match(issue.title, /Prompt Evolvo/);
});

test("GitHubClient can create and update dry-run pull requests linked to an issue marker", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const pullRequest = await client.createPullRequest({
    title: "Implement thing",
    body: "Summary\n\nCloses #7",
    head: "evolvo/issue-7-implement-thing",
    base: "main"
  });

  const found = await client.findOpenPullRequestForIssue(7);
  assert.equal(found.number, pullRequest.number);

  const updated = await client.updatePullRequest(pullRequest.number, {
    title: "Implement thing v2",
    body: "Updated\n\nCloses #7"
  });
  assert.equal(updated.title, "Implement thing v2");
});

test("GitHubClient supports label removal and issue title lookup in dry-run mode", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const issueNumber = await client.createIssue("Improve reliability", "Body", ["self-evolution", "in-progress"]);

  const existing = await client.findOpenIssueByTitle("Improve reliability");
  assert.equal(existing.number, issueNumber);

  await client.removeLabels(issueNumber, ["in-progress"]);
  const open = await client.listOpenIssues();
  const labels = open[0].labels.map((label) => label.name);
  assert.deepEqual(labels, ["self-evolution"]);
});

test("GitHubClient dry-run merge and close update local state", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const issueNumber = await client.createIssue("Implement thing", "Body", []);
  const pullRequest = await client.createPullRequest({
    title: "Implement thing",
    body: "Closes #1",
    head: "branch",
    base: "main"
  });

  const merged = await client.mergePullRequest(pullRequest.number);
  await client.closeIssue(issueNumber);

  assert.equal(merged, true);
  assert.equal((await client.listOpenPullRequests()).length, 0);
  assert.equal((await client.listOpenIssues()).length, 0);
});

test("GitHubClient supports pull request comments in dry-run mode", async () => {
  const client = new GitHubClient({ owner: "o", repo: "r", token: "t", dryRun: true });
  const pullRequest = await client.createPullRequest({
    title: "Implement thing",
    body: "Closes #1",
    head: "branch",
    base: "main"
  });

  await client.commentOnPullRequest(pullRequest.number, "Automated self-review");
  assert.equal((await client.getPullRequest(pullRequest.number)).number, pullRequest.number);
});
