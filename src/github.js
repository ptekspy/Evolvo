const ISSUE_MARKER_PREFIX = "Closes #";

function markerForIssue(issueNumber) {
  return `${ISSUE_MARKER_PREFIX}${issueNumber}`;
}

function parseDryRunPullRequestNumber(nextValue) {
  return nextValue - 1;
}

export class GitHubClient {
  constructor(options) {
    this.options = options;
    this.baseUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    this.nextDryRunIssue = -1;
    this.nextDryRunPr = -1000;
    this.dryRunIssues = [];
    this.dryRunPullRequests = [];
  }

  async ensurePromptIssue() {
    const issues = await this.listOpenIssues();
    if (issues.length > 0) {
      return issues[0];
    }

    const title = "Prompt Evolvo: your first instruction";
    const body = [
      "Describe the next meaningful development outcome you want Evolvo to deliver.",
      "",
      "Example:",
      "Build a production-ready TypeScript feature with tests and open a PR.",
      "",
      "Evolvo will use this issue as the active instruction thread and log progress here."
    ].join("\n");

    const number = await this.createIssue(title, body, ["prompt"]);
    return { number, title, body, labels: [{ name: "prompt" }] };
  }

  async listOpenIssues() {
    if (this.options.dryRun) {
      return [...this.dryRunIssues];
    }

    const issues = await this.request("/issues?state=open&sort=created&direction=asc", { method: "GET" });
    return issues.filter((issue) => !issue.pull_request);
  }

  async findOpenIssueByTitle(title) {
    const issues = await this.listOpenIssues();
    return issues.find((issue) => issue.title === title);
  }

  async createIssue(title, body, labels = []) {
    if (this.options.dryRun) {
      const number = this.nextDryRunIssue;
      this.nextDryRunIssue -= 1;
      const issue = { number, title, body, labels: labels.map((name) => ({ name })) };
      this.dryRunIssues.push(issue);
      console.log(`[dry-run] create issue: ${title} labels=${labels.join(",")}`);
      return number;
    }

    const result = await this.request("/issues", {
      method: "POST",
      body: { title, body, labels }
    });
    return result.number;
  }

  async addLabels(issueNumber, labels) {
    if (this.options.dryRun) {
      const issue = this.dryRunIssues.find((item) => item.number === issueNumber);
      if (issue) {
        const existing = new Set((issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)));
        for (const label of labels) {
          if (!existing.has(label)) {
            issue.labels.push({ name: label });
          }
        }
      }
      console.log(`[dry-run] label issue #${issueNumber}: ${labels.join(",")}`);
      return;
    }

    await this.request(`/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels }
    });
  }

  async removeLabels(issueNumber, labels) {
    if (this.options.dryRun) {
      const issue = this.dryRunIssues.find((item) => item.number === issueNumber);
      if (issue) {
        issue.labels = (issue.labels ?? []).filter((label) => !labels.includes(typeof label === "string" ? label : label.name));
      }
      console.log(`[dry-run] remove labels from issue #${issueNumber}: ${labels.join(",")}`);
      return;
    }

    for (const label of labels) {
      await this.request(`/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE"
      });
    }
  }

  async closeIssue(issueNumber) {
    if (this.options.dryRun) {
      this.dryRunIssues = this.dryRunIssues.filter((item) => item.number !== issueNumber);
      console.log(`[dry-run] close issue #${issueNumber}`);
      return;
    }

    await this.request(`/issues/${issueNumber}`, {
      method: "PATCH",
      body: { state: "closed" }
    });
  }

  async commentOnIssue(issueNumber, message) {
    if (this.options.dryRun) {
      console.log(`[dry-run] issue #${issueNumber} comment: ${message}`);
      return;
    }

    await this.request(`/issues/${issueNumber}/comments`, {
      method: "POST",
      body: { body: message }
    });
  }

  async listOpenPullRequests() {
    if (this.options.dryRun) {
      return this.dryRunPullRequests.filter((pullRequest) => pullRequest.state === "open");
    }

    return this.request("/pulls?state=open", { method: "GET" });
  }

  async getPullRequest(prNumber) {
    if (this.options.dryRun) {
      return this.dryRunPullRequests.find((pullRequest) => pullRequest.number === prNumber);
    }

    return this.request(`/pulls/${prNumber}`, { method: "GET" });
  }

  async createPullRequest({ title, body, head, base = "main" }) {
    if (this.options.dryRun) {
      const number = this.nextDryRunPr;
      this.nextDryRunPr = parseDryRunPullRequestNumber(number);
      const pullRequest = {
        number,
        title,
        body,
        state: "open",
        head: { ref: head },
        base: { ref: base }
      };
      this.dryRunPullRequests.push(pullRequest);
      console.log(`[dry-run] create PR #${number}: ${title}`);
      return pullRequest;
    }

    return this.request("/pulls", {
      method: "POST",
      body: { title, body, head, base }
    });
  }

  async updatePullRequest(prNumber, { title, body }) {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((item) => item.number === prNumber);
      if (!pullRequest) {
        throw new Error(`Unknown dry-run PR #${prNumber}`);
      }

      pullRequest.title = title ?? pullRequest.title;
      pullRequest.body = body ?? pullRequest.body;
      console.log(`[dry-run] update PR #${prNumber}`);
      return pullRequest;
    }

    return this.request(`/pulls/${prNumber}`, {
      method: "PATCH",
      body: { title, body }
    });
  }

  async findOpenPullRequestForIssue(issueNumber) {
    const pullRequests = await this.listOpenPullRequests();
    const marker = markerForIssue(issueNumber);
    return pullRequests.find((pullRequest) => (pullRequest.body ?? "").includes(marker));
  }

  async reviewPullRequest(prNumber, review) {
    if (this.options.dryRun) {
      console.log(`[dry-run] review PR #${prNumber} with ${review.decision}`);
      return;
    }

    await this.request(`/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: {
        event: review.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        body: review.body
      }
    });
  }

  async mergePullRequest(prNumber) {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((item) => item.number === prNumber);
      if (pullRequest) {
        pullRequest.state = "closed";
        pullRequest.merged = true;
      }
      console.log(`[dry-run] merge PR #${prNumber}`);
      return true;
    }

    const result = await this.request(`/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: { merge_method: "squash" }
    });
    return Boolean(result.merged);
  }

  async request(path, init) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: init.body ? JSON.stringify(init.body) : undefined
    });

    if (!response.ok) {
      throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

export function buildIssueMarker(issueNumber) {
  return markerForIssue(issueNumber);
}
