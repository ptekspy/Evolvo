import { createNoopLogger } from "./logger.js";

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
    this.logger = options.logger ?? createNoopLogger();
    this.baseUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    this.nextDryRunIssue = -1;
    this.nextDryRunPr = -1000;
    this.dryRunIssues = [];
    this.dryRunPullRequests = [];
  }

  async ensurePromptIssue() {
    const issues = await this.listOpenIssues();
    if (issues.length > 0) {
      this.logger.info("Using existing prompt issue", {
        issueNumber: issues[0].number
      });
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
    this.logger.info("Created prompt issue", {
      issueNumber: number
    });
    return { number, title, body, labels: [{ name: "prompt" }] };
  }

  async listOpenIssues() {
    if (this.options.dryRun) {
      this.logger.debug("Listing open issues from dry-run state", {
        count: this.dryRunIssues.length
      });
      return [...this.dryRunIssues];
    }

    const issues = await this.request("/issues?state=open&sort=created&direction=asc", { method: "GET" });
    const filtered = issues.filter((issue) => !issue.pull_request);
    this.logger.debug("Fetched open issues", {
      count: filtered.length
    });
    return filtered;
  }

  async findOpenIssueByTitle(title) {
    const issues = await this.listOpenIssues();
    const issue = issues.find((issue) => issue.title === title);
    this.logger.debug("Looked up open issue by title", {
      title,
      found: Boolean(issue)
    });
    return issue;
  }

  async createIssue(title, body, labels = []) {
    if (this.options.dryRun) {
      const number = this.nextDryRunIssue;
      this.nextDryRunIssue -= 1;
      const issue = { number, title, body, labels: labels.map((name) => ({ name })) };
      this.dryRunIssues.push(issue);
      this.logger.info("Dry-run issue created", {
        issueNumber: number,
        title,
        labels
      });
      return number;
    }

    const result = await this.request("/issues", {
      method: "POST",
      body: { title, body, labels }
    });
    this.logger.info("Created issue", {
      issueNumber: result.number,
      title,
      labels
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
      this.logger.info("Dry-run labels added to issue", {
        issueNumber,
        labels
      });
      return;
    }

    await this.request(`/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels }
    });
    this.logger.info("Added labels to issue", {
      issueNumber,
      labels
    });
  }

  async removeLabels(issueNumber, labels) {
    if (this.options.dryRun) {
      const issue = this.dryRunIssues.find((item) => item.number === issueNumber);
      if (issue) {
        issue.labels = (issue.labels ?? []).filter((label) => !labels.includes(typeof label === "string" ? label : label.name));
      }
      this.logger.info("Dry-run labels removed from issue", {
        issueNumber,
        labels
      });
      return;
    }

    for (const label of labels) {
      await this.request(`/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE"
      });
    }
    this.logger.info("Removed labels from issue", {
      issueNumber,
      labels
    });
  }

  async closeIssue(issueNumber) {
    if (this.options.dryRun) {
      this.dryRunIssues = this.dryRunIssues.filter((item) => item.number !== issueNumber);
      this.logger.info("Dry-run issue closed", {
        issueNumber
      });
      return;
    }

    await this.request(`/issues/${issueNumber}`, {
      method: "PATCH",
      body: { state: "closed" }
    });
    this.logger.info("Closed issue", {
      issueNumber
    });
  }

  async commentOnIssue(issueNumber, message) {
    if (this.options.dryRun) {
      this.logger.info("Dry-run issue comment", {
        issueNumber,
        message
      });
      return;
    }

    await this.request(`/issues/${issueNumber}/comments`, {
      method: "POST",
      body: { body: message }
    });
    this.logger.debug("Posted issue comment", {
      issueNumber
    });
  }

  async commentOnPullRequest(prNumber, message) {
    if (this.options.dryRun) {
      this.logger.info("Dry-run pull request comment", {
        prNumber,
        message
      });
      return;
    }

    await this.request(`/issues/${prNumber}/comments`, {
      method: "POST",
      body: { body: message }
    });
    this.logger.debug("Posted pull request comment", {
      prNumber
    });
  }

  async listOpenPullRequests() {
    if (this.options.dryRun) {
      const pullRequests = this.dryRunPullRequests.filter((pullRequest) => pullRequest.state === "open");
      this.logger.debug("Listing open pull requests from dry-run state", {
        count: pullRequests.length
      });
      return pullRequests;
    }

    const pullRequests = await this.request("/pulls?state=open", { method: "GET" });
    this.logger.debug("Fetched open pull requests", {
      count: pullRequests.length
    });
    return pullRequests;
  }

  async getPullRequest(prNumber) {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((pullRequest) => pullRequest.number === prNumber);
      this.logger.debug("Fetched dry-run pull request", {
        prNumber,
        found: Boolean(pullRequest)
      });
      return pullRequest;
    }

    const pullRequest = await this.request(`/pulls/${prNumber}`, { method: "GET" });
    this.logger.debug("Fetched pull request", {
      prNumber
    });
    return pullRequest;
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
      this.logger.info("Dry-run pull request created", {
        prNumber: number,
        title,
        head,
        base
      });
      return pullRequest;
    }

    const pullRequest = await this.request("/pulls", {
      method: "POST",
      body: { title, body, head, base }
    });
    this.logger.info("Created pull request", {
      prNumber: pullRequest.number,
      title,
      head,
      base
    });
    return pullRequest;
  }

  async updatePullRequest(prNumber, { title, body }) {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((item) => item.number === prNumber);
      if (!pullRequest) {
        throw new Error(`Unknown dry-run PR #${prNumber}`);
      }

      pullRequest.title = title ?? pullRequest.title;
      pullRequest.body = body ?? pullRequest.body;
      this.logger.info("Dry-run pull request updated", {
        prNumber,
        title: pullRequest.title
      });
      return pullRequest;
    }

    const pullRequest = await this.request(`/pulls/${prNumber}`, {
      method: "PATCH",
      body: { title, body }
    });
    this.logger.info("Updated pull request", {
      prNumber,
      title: pullRequest.title
    });
    return pullRequest;
  }

  async findOpenPullRequestForIssue(issueNumber) {
    const pullRequests = await this.listOpenPullRequests();
    const marker = markerForIssue(issueNumber);
    const pullRequest = pullRequests.find((pullRequest) => (pullRequest.body ?? "").includes(marker));
    this.logger.debug("Looked up pull request for issue", {
      issueNumber,
      found: Boolean(pullRequest)
    });
    return pullRequest;
  }

  async mergePullRequest(prNumber) {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((item) => item.number === prNumber);
      if (pullRequest) {
        pullRequest.state = "closed";
        pullRequest.merged = true;
      }
      this.logger.info("Dry-run pull request merged", {
        prNumber
      });
      return true;
    }

    const result = await this.request(`/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: { merge_method: "squash" }
    });
    this.logger.info("Merge pull request result", {
      prNumber,
      merged: Boolean(result.merged)
    });
    return Boolean(result.merged);
  }

  async request(path, init) {
    this.logger.debug("GitHub API request", {
      method: init.method,
      path
    });
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
      this.logger.error("GitHub API request failed", {
        method: init.method,
        path,
        status: response.status
      });
      throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
    }

    this.logger.debug("GitHub API request completed", {
      method: init.method,
      path,
      status: response.status
    });

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
