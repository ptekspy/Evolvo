import { ExecutionSession } from "./executionSession.js";
import { buildIssueMarker } from "./github.js";
import { createNoopLogger } from "./logger.js";
import { composePrompt } from "./masterPrompt.js";
import type { JsonValue, LoggerLike } from "./types.js";

type LabelRef = string | { name?: string };

interface Issue {
  number: number;
  title: string;
  body?: string;
  labels?: LabelRef[];
}

interface ValidationResult {
  passed: boolean;
  summary: string;
}

interface ExecutionResult {
  status: "done" | "stuck";
  summary: string;
  rationale?: string;
  prTitle?: string;
  prBody?: string;
  validation?: ValidationResult | null;
}

interface ReviewDecision {
  decision: "approve" | "request_changes";
  body?: string;
  rationale?: string;
}

interface PullRequest {
  number: number;
  title?: string;
  body?: string;
  state?: string;
}

interface PlannerLike {
  complete(prompt: string): Promise<string>;
}

interface ReviewerLike {
  complete(prompt: string): Promise<string>;
}

interface WorkspaceLike {
  prepareBranch(issue: Issue): string;
  getBranchName(): string | null;
  getTouchedFiles(): string[];
  listFiles(glob?: string): string;
  searchCode(query: string): string;
  readFiles(paths: string[]): string;
  writeFile(path: string, content: string): string;
  deleteFile(path: string): string;
  showDiff(): string;
  runValidation(): ValidationResult;
  hasUncommittedChanges(): boolean;
  cleanup(): void;
  commitAndPush(issue: Issue, prTitle: string): {
    changed: boolean;
    pushed: boolean;
    branchName: string;
    commitSha?: string;
    reason?: string;
  };
  diffAgainstBase?(): string;
}

interface GitHubLike {
  ensurePromptIssue(): Promise<unknown>;
  listOpenIssues(): Promise<Issue[]>;
  findOpenIssueByTitle(title: string): Promise<Issue | undefined>;
  createIssue(title: string, body: string, labels?: string[]): Promise<number>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(issueNumber: number, labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  commentOnIssue(issueNumber: number, message: string): Promise<void>;
  findOpenPullRequestForIssue(issueNumber: number): Promise<PullRequest | null | undefined>;
  createPullRequest(data: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  updatePullRequest(prNumber: number, data: { title?: string; body?: string }): Promise<PullRequest>;
  commentOnPullRequest(prNumber: number, message: string): Promise<void>;
  mergePullRequest(prNumber: number): Promise<boolean>;
}

interface PerformanceLike {
  record(snapshot: Record<string, JsonValue>): Record<string, JsonValue>;
}

interface EvolverOptions {
  maxIssueAttempts?: number;
  maxPrFixRounds?: number;
  maxAgentSteps?: number;
  dryRun?: boolean;
  loopDelayMs?: number;
  maxLoops?: number;
  workspaceFactory?: () => WorkspaceLike;
  logger?: LoggerLike;
}

interface ResolvedEvolverOptions {
  maxIssueAttempts: number;
  maxPrFixRounds: number;
  maxAgentSteps: number;
  dryRun: boolean;
  loopDelayMs: number;
  maxLoops: number;
  workspaceFactory?: () => WorkspaceLike;
}

const IN_PROGRESS_LABEL = "in-progress";
const NEEDS_HUMAN_LABEL = "needs-human-intervention";

function ensureIssueMarker(body: string, issueNumber: number): string {
  const marker = buildIssueMarker(issueNumber);
  if ((body ?? "").includes(marker)) {
    return body;
  }

  return [body.trim(), "", marker].filter(Boolean).join("\n");
}

function buildPullRequestBody(issue: Issue, execution: ExecutionResult): string {
  const sections: string[] = [];
  if (execution.prBody?.trim()) {
    sections.push(execution.prBody.trim());
  } else {
    sections.push(execution.summary);
    if (execution.rationale) {
      sections.push(`Rationale: ${execution.rationale}`);
    }
  }

  if (execution.validation?.summary) {
    sections.push("Validation", "```text", execution.validation.summary, "```");
  }

  return ensureIssueMarker(sections.join("\n\n"), issue.number);
}

function formatReviewComment(review: ReviewDecision, round: number, maxRounds: number): string {
  return [
    `Automated self-review round ${round}/${maxRounds}`,
    `Decision: ${review.decision}`,
    "",
    review.body ?? "No review body provided.",
    "",
    `Rationale: ${review.rationale ?? "n/a"}`
  ].join("\n");
}

function labelsOf(issue: Issue): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
}

export class Evolver {
  private readonly planner: PlannerLike;
  private readonly reviewer: ReviewerLike;
  private readonly github: GitHubLike;
  private readonly performance: PerformanceLike;
  private readonly logger: LoggerLike;
  private readonly options: ResolvedEvolverOptions;
  private idleLoopCount: number;

  constructor(planner: PlannerLike, reviewer: ReviewerLike, github: GitHubLike, performance: PerformanceLike, options: EvolverOptions = {}) {
    this.planner = planner;
    this.reviewer = reviewer;
    this.github = github;
    this.performance = performance;
    this.logger = options.logger ?? createNoopLogger();
    this.options = {
      maxIssueAttempts: options.maxIssueAttempts ?? 3,
      maxPrFixRounds: options.maxPrFixRounds ?? 3,
      maxAgentSteps: options.maxAgentSteps ?? 40,
      dryRun: options.dryRun ?? true,
      loopDelayMs: options.loopDelayMs ?? 2000,
      maxLoops: options.maxLoops ?? Number.POSITIVE_INFINITY
    };
    if (options.workspaceFactory) {
      this.options.workspaceFactory = options.workspaceFactory;
    }
    this.idleLoopCount = 0;
  }

  async run(): Promise<{ restartRequested: boolean; halted?: boolean }> {
    this.logger.info("Ensuring prompt issue exists");
    await this.github.ensurePromptIssue();

    let loopCount = 0;
    while (loopCount < this.options.maxLoops) {
      loopCount += 1;
      this.logger.info("Starting loop iteration", { loopCount });
      const issue = await this.chooseNextActionableIssue();

      if (!issue) {
        this.idleLoopCount += 1;
        this.logger.info("No actionable issues found", { idleLoopCount: this.idleLoopCount });
        await this.sleep(this.options.loopDelayMs);
        continue;
      }

      this.idleLoopCount = 0;
      this.logger.info("Selected issue for execution", { issueNumber: issue.number, title: issue.title });
      await this.log(issue.number, `🚀 Starting autonomous work on issue #${issue.number}: ${issue.title}`);
      const outcome = await this.processIssue(issue);

      if (outcome.restartRequested) {
        return { restartRequested: true };
      }

      if (outcome.halted) {
        return { restartRequested: false, halted: true };
      }

      await this.sleep(this.options.loopDelayMs);
    }

    return { restartRequested: false };
  }

  private async chooseNextActionableIssue(): Promise<Issue | null> {
    const issues = await this.github.listOpenIssues();
    const actionable = issues.filter((issue) => !labelsOf(issue).includes(NEEDS_HUMAN_LABEL));

    if (actionable.length === 0) {
      return null;
    }

    const decision = await this.rankIssueChoices(actionable);
    if (decision.action === "work" && Number.isInteger(decision.issueNumber)) {
      const picked = actionable.find((issue) => issue.number === decision.issueNumber);
      if (picked) {
        return picked;
      }
    }

    return actionable[0] ?? null;
  }

  private async rankIssueChoices(actionable: Issue[]): Promise<{ action: string; issueNumber?: number }> {
    const summarized = actionable.map((issue) => ({ number: issue.number, title: issue.title, labels: labelsOf(issue) }));
    const prompt = composePrompt([
      "You are autonomously choosing the next issue to work on.",
      `Open issues: ${JSON.stringify(summarized)}`,
      "Return JSON only:",
      '{"action":"work","issueNumber":123}'
    ].join("\n"));

    try {
      const parsed = JSON.parse(await this.planner.complete(prompt)) as { action: string; issueNumber?: number };
      return parsed;
    } catch {
      const fallback: { action: string; issueNumber?: number } = { action: "work" };
      if (actionable[0]) {
        fallback.issueNumber = actionable[0].number;
      }
      return fallback;
    }
  }

  private createWorkspace(): WorkspaceLike {
    if (!this.options.workspaceFactory) {
      throw new Error("workspaceFactory is required.");
    }
    return this.options.workspaceFactory();
  }

  private async processIssue(issue: Issue): Promise<{ restartRequested: boolean; halted?: boolean; reviewRounds?: number; validationPassed?: boolean }> {
    const workspace = this.createWorkspace();
    await this.github.addLabels(issue.number, [IN_PROGRESS_LABEL]);

    try {
      workspace.prepareBranch(issue);
      const execution = await this.executeIssueAttempt(issue, workspace, { attempt: 1 });
      if (execution.status !== "done") {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        return { restartRequested: false, halted: workspace.hasUncommittedChanges() };
      }

      const publication = await this.publishExecution(issue, workspace, execution);
      const review = await this.reviewMergeAndRestart(issue, publication.pr, workspace, execution.validation ?? null);
      return review;
    } finally {
      workspace.cleanup();
      await this.github.removeLabels(issue.number, [IN_PROGRESS_LABEL]);
    }
  }

  private async executeIssueAttempt(issue: Issue, workspace: WorkspaceLike, options: { attempt: number }): Promise<ExecutionResult> {
    const session = new ExecutionSession(this.planner, workspace, {
      maxSteps: this.options.maxAgentSteps,
      logger: this.logger.child("session", { issueNumber: issue.number, attempt: options.attempt })
    });
    return session.run(issue, options) as Promise<ExecutionResult>;
  }

  private async publishExecution(issue: Issue, workspace: WorkspaceLike, execution: ExecutionResult, existingPr: PullRequest | null = null): Promise<{ pr: PullRequest }> {
    const prTitle = execution.prTitle?.trim() || issue.title;
    const prBody = buildPullRequestBody(issue, execution);
    const result = workspace.commitAndPush(issue, prTitle);
    if (!result.changed || !result.pushed) {
      throw new Error(`Unable to publish execution: ${result.reason ?? "commit or push failed."}`);
    }

    let pr = existingPr ?? await this.github.findOpenPullRequestForIssue(issue.number);
    if (pr) {
      pr = await this.github.updatePullRequest(pr.number, { title: prTitle, body: prBody });
      return { pr };
    }

    pr = await this.github.createPullRequest({ title: prTitle, body: prBody, head: result.branchName, base: "main" });
    return { pr };
  }

  private async reviewMergeAndRestart(issue: Issue, pr: PullRequest, workspace: WorkspaceLike, validation: ValidationResult | null): Promise<{ restartRequested: boolean; halted?: boolean; reviewRounds: number; validationPassed: boolean }> {
    const prompt = composePrompt(`Review PR #${pr.number} for issue #${issue.number}.`);
    const parsed = JSON.parse(await this.reviewer.complete(prompt)) as ReviewDecision;
    await this.github.commentOnPullRequest(pr.number, formatReviewComment(parsed, 1, this.options.maxPrFixRounds));

    if (parsed.decision === "approve") {
      const merged = await this.github.mergePullRequest(pr.number);
      if (merged) {
        await this.github.closeIssue(issue.number);
        this.performance.record({ issueNumber: issue.number, merged: true, validationPassed: Boolean(validation?.passed) });
        return { restartRequested: true, reviewRounds: 1, validationPassed: Boolean(validation?.passed) };
      }
    }

    await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
    this.performance.record({ issueNumber: issue.number, merged: false, validationPassed: Boolean(validation?.passed) });
    return { restartRequested: false, halted: workspace.hasUncommittedChanges(), reviewRounds: 1, validationPassed: Boolean(validation?.passed) };
  }

  private async log(issueNumber: number, message: string): Promise<void> {
    await this.github.commentOnIssue(issueNumber, message);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
