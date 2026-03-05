import { createNoopLogger } from "./logger.js";
import type { LoggerLike } from "./types.js";

const ISSUE_MARKER_PREFIX = "Closes #";

function markerForIssue(issueNumber: number): string {
  return `${ISSUE_MARKER_PREFIX}${issueNumber}`;
}

function parseDryRunPullRequestNumber(nextValue: number): number {
  return nextValue - 1;
}

type IssueLabel = { name: string };

interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  labels?: IssueLabel[];
  pull_request?: unknown;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  merged?: boolean;
  head: { ref: string };
  base: { ref: string };
}

interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  dryRun?: boolean;
  logger?: LoggerLike;
}

interface RequestInitShape {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
}

export function buildIssueMarker(issueNumber: number): string {
  return markerForIssue(issueNumber);
}

export class GitHubClient {
  private readonly options: GitHubClientOptions;
  private readonly logger: LoggerLike;
  private readonly baseUrl: string;
  private nextDryRunIssue: number;
  private nextDryRunPr: number;
  private dryRunIssues: GitHubIssue[];
  private dryRunPullRequests: GitHubPullRequest[];

  constructor(options: GitHubClientOptions) {
    this.options = options;
    this.logger = options.logger ?? createNoopLogger();
    this.baseUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    this.nextDryRunIssue = -1;
    this.nextDryRunPr = -1000;
    this.dryRunIssues = [];
    this.dryRunPullRequests = [];
  }

  async ensurePromptIssue(): Promise<GitHubIssue> {
    const issues = await this.listOpenIssues();
    const firstIssue = issues[0];
    if (firstIssue) {
      this.logger.info("Using existing prompt issue", {
        issueNumber: firstIssue.number
      });
      return firstIssue;
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

  async listOpenIssues(): Promise<GitHubIssue[]> {
    if (this.options.dryRun) {
      this.logger.debug("Listing open issues from dry-run state", {
        count: this.dryRunIssues.length
      });
      return [...this.dryRunIssues];
    }

    const issues = await this.request<GitHubIssue[]>("/issues?state=open&sort=created&direction=asc", { method: "GET" });
    const filtered = issues.filter((issue) => !issue.pull_request);
    this.logger.debug("Fetched open issues", {
      count: filtered.length
    });
    return filtered;
  }

  async findOpenIssueByTitle(title: string): Promise<GitHubIssue | undefined> {
    const issues = await this.listOpenIssues();
    const issue = issues.find((candidate) => candidate.title === title);
    this.logger.debug("Looked up open issue by title", {
      title,
      found: Boolean(issue)
    });
    return issue;
  }

  async createIssue(title: string, body: string, labels: string[] = []): Promise<number> {
    if (this.options.dryRun) {
      const number = this.nextDryRunIssue;
      this.nextDryRunIssue -= 1;
      const issue: GitHubIssue = { number, title, body, labels: labels.map((name) => ({ name })) };
      this.dryRunIssues.push(issue);
      this.logger.info("Dry-run issue created", {
        issueNumber: number,
        title,
        labels
      });
      return number;
    }

    const result = await this.request<GitHubIssue>("/issues", {
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

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (this.options.dryRun) {
      const issue = this.dryRunIssues.find((item) => item.number === issueNumber);
      if (issue) {
        const existing = new Set((issue.labels ?? []).map((label) => label.name));
        for (const label of labels) {
          if (!existing.has(label)) {
            (issue.labels ??= []).push({ name: label });
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

  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (this.options.dryRun) {
      const issue = this.dryRunIssues.find((item) => item.number === issueNumber);
      if (issue) {
        issue.labels = (issue.labels ?? []).filter((label) => !labels.includes(label.name));
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

  async closeIssue(issueNumber: number): Promise<void> {
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

  async commentOnIssue(issueNumber: number, message: string): Promise<void> {
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

  async commentOnPullRequest(prNumber: number, message: string): Promise<void> {
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

  async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
    if (this.options.dryRun) {
      const pullRequests = this.dryRunPullRequests.filter((pullRequest) => pullRequest.state === "open");
      this.logger.debug("Listing open pull requests from dry-run state", {
        count: pullRequests.length
      });
      return pullRequests;
    }

    const pullRequests = await this.request<GitHubPullRequest[]>("/pulls?state=open", { method: "GET" });
    this.logger.debug("Fetched open pull requests", {
      count: pullRequests.length
    });
    return pullRequests;
  }

  async getPullRequest(prNumber: number): Promise<GitHubPullRequest | undefined> {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((candidate) => candidate.number === prNumber);
      this.logger.debug("Fetched dry-run pull request", {
        prNumber,
        found: Boolean(pullRequest)
      });
      return pullRequest;
    }

    const pullRequest = await this.request<GitHubPullRequest>(`/pulls/${prNumber}`, { method: "GET" });
    this.logger.debug("Fetched pull request", {
      prNumber
    });
    return pullRequest;
  }

  async createPullRequest({ title, body, head, base = "main" }: { title: string; body: string; head: string; base?: string }): Promise<GitHubPullRequest> {
    if (this.options.dryRun) {
      const number = this.nextDryRunPr;
      this.nextDryRunPr = parseDryRunPullRequestNumber(number);
      const pullRequest: GitHubPullRequest = {
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

    const pullRequest = await this.request<GitHubPullRequest>("/pulls", {
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

  async updatePullRequest(prNumber: number, update: { title?: string; body?: string }): Promise<GitHubPullRequest> {
    if (this.options.dryRun) {
      const pullRequest = this.dryRunPullRequests.find((item) => item.number === prNumber);
      if (!pullRequest) {
        throw new Error(`Unknown dry-run PR #${prNumber}`);
      }

      if (typeof update.title === "string") {
        pullRequest.title = update.title;
      }
      if (typeof update.body === "string") {
        pullRequest.body = update.body;
      }
      this.logger.info("Dry-run pull request updated", {
        prNumber,
        title: pullRequest.title
      });
      return pullRequest;
    }

    const body: Record<string, unknown> = {};
    if (typeof update.title === "string") {
      body.title = update.title;
    }
    if (typeof update.body === "string") {
      body.body = update.body;
    }

    const pullRequest = await this.request<GitHubPullRequest>(`/pulls/${prNumber}`, {
      method: "PATCH",
      body
    });
    this.logger.info("Updated pull request", {
      prNumber,
      title: pullRequest.title
    });
    return pullRequest;
  }

  async findOpenPullRequestForIssue(issueNumber: number): Promise<GitHubPullRequest | undefined> {
    const pullRequests = await this.listOpenPullRequests();
    const marker = markerForIssue(issueNumber);
    const pullRequest = pullRequests.find((candidate) => (candidate.body ?? "").includes(marker));
    this.logger.debug("Looked up pull request for issue", {
      issueNumber,
      found: Boolean(pullRequest)
    });
    return pullRequest;
  }

  async mergePullRequest(prNumber: number): Promise<boolean> {
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

    const result = await this.request<{ merged?: boolean }>(`/pulls/${prNumber}/merge`, {
      method: "PUT",
      body: { merge_method: "squash" }
    });
    this.logger.info("Merge pull request result", {
      prNumber,
      merged: Boolean(result.merged)
    });
    return Boolean(result.merged);
  }

  private async request<T>(path: string, init: RequestInitShape): Promise<T> {
    this.logger.debug("GitHub API request", {
      method: init.method,
      path
    });

    const requestInit: RequestInit = {
      method: init.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      }
    };

    if (init.body) {
      requestInit.body = JSON.stringify(init.body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, requestInit);

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
      return null as T;
    }

    return (await response.json()) as T;
  }
}
