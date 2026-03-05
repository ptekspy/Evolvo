import { ExecutionSession } from "./executionSession.js";
import { buildIssueMarker } from "./github.js";
import { createNoopLogger } from "./logger.js";
import { composePrompt } from "./masterPrompt.js";

const IN_PROGRESS_LABEL = "in-progress";
const NEEDS_HUMAN_LABEL = "needs-human-intervention";
const MERGE_READINESS_THRESHOLD = 3;

function ensureIssueMarker(body, issueNumber) {
  const marker = buildIssueMarker(issueNumber);
  if ((body ?? "").includes(marker)) {
    return body;
  }

  return [body?.trim(), "", marker].filter(Boolean).join("\n");
}

function buildPullRequestBody(issue, execution) {
  const sections = [];
  if (execution.prBody?.trim()) {
    sections.push(execution.prBody.trim());
  } else {
    sections.push(execution.summary);
    if (execution.rationale) {
      sections.push(`Rationale: ${execution.rationale}`);
    }
  }

  if (execution.validation?.summary) {
    sections.push("Validation");
    sections.push("```text");
    sections.push(execution.validation.summary);
    sections.push("```");
  }

  return ensureIssueMarker(sections.join("\n\n"), issue.number);
}

function formatReviewComment(review, round, maxRounds) {
  return [
    `Automated self-review round ${round}/${maxRounds}`,
    `Decision: ${review.decision}`,
    "",
    review.body ?? "No review body provided.",
    "",
    `Rationale: ${review.rationale ?? "n/a"}`
  ].join("\n");
}

function includesAny(text, terms) {
  const lower = (text ?? "").toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function mergeReadinessCheck(issue, execution) {
  const checks = {
    validationPassed: Boolean(execution?.validation?.passed),
    changeScopeClarity: (execution?.summary ?? "").trim().length >= 8,
    riskRollback: includesAny(execution?.rationale, ["risk", "rollback", "mitigation", "revert", "addressed"]),
    reviewerRationaleQuality:
      (execution?.summary ?? "").trim().length > 0
      && includesAny(`${execution?.summary ?? ""} ${execution?.rationale ?? ""}`, ["intent", "trade-off", "tradeoff", "evidence", "because", "added", "implemented", "addressed", "fixed"]),
    acceptanceCriteriaTraceability: includesAny(`${issue?.body ?? ""} ${execution?.summary ?? ""} ${execution?.rationale ?? ""}`, ["acceptance", "criteria", "trace", "covers", "scope", "details", "implemented", "feature", "issue"])
  };

  const score = Object.values(checks).filter(Boolean).length;
  const passed = checks.validationPassed && score >= MERGE_READINESS_THRESHOLD;
  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    passed,
    score,
    threshold: MERGE_READINESS_THRESHOLD,
    checks,
    failedChecks
  };
}

export class Evolver {
  constructor(planner, reviewer, github, performance, options = {}) {
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
      maxLoops: options.maxLoops ?? Number.POSITIVE_INFINITY,
      workspaceFactory: options.workspaceFactory
    };
    this.idleLoopCount = 0;
  }

  async run() {
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
        await this.planUpgradeIssues();
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

  async chooseNextActionableIssue() {
    const issues = await this.github.listOpenIssues();
    const actionable = issues.filter((issue) => {
      const labels = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
      return !labels.includes(NEEDS_HUMAN_LABEL);
    });

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

    return actionable[0];
  }

  async rankIssueChoices(actionable) {
    const summarized = actionable.map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name))
    }));

    const prompt = composePrompt([
      "You are autonomously choosing the next issue to work on.",
      `Open issues: ${JSON.stringify(summarized)}`,
      "Return JSON only:",
      '{"action":"work","issueNumber":123}'
    ].join("\n"));

    try {
      return JSON.parse(await this.planner.complete(prompt));
    } catch {
      return { action: "work", issueNumber: actionable[0].number };
    }
  }

  async processIssue(issue) {
    const startedAt = Date.now();
    const workspace = this.createWorkspace();
    let attempts = 0;
    let reviewRounds = 0;
    let prNumber = null;
    let validationPassed = false;
    let merged = false;
    let halted = false;
    let status = "blocked";

    await this.github.addLabels(issue.number, [IN_PROGRESS_LABEL]);

    try {
      workspace.prepareBranch(issue);
      let execution = null;

      for (let attempt = 1; attempt <= this.options.maxIssueAttempts; attempt += 1) {
        attempts = attempt;
        execution = await this.executeIssueAttempt(issue, workspace, { attempt });
        validationPassed = Boolean(execution.validation?.passed);
        if (execution.status === "done") {
          break;
        }
      }

      if (!execution || execution.status !== "done") {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        halted = workspace.hasUncommittedChanges();
        return { restartRequested: false, halted };
      }

      const readiness = mergeReadinessCheck(issue, execution);
      await this.log(issue.number, `📊 Merge-readiness gate: ${JSON.stringify(readiness)}`);
      if (!readiness.passed) {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        await this.createIssueIfMissing(
          `Follow-up: Improve merge readiness for issue #${issue.number}`,
          `Issue #${issue.number} failed merge-readiness gate.\n\nEvidence: ${JSON.stringify(readiness)}`,
          ["self-evolution"]
        );
        status = "blocked";
        return { restartRequested: false, halted: false };
      }

      const publication = await this.publishExecution(issue, workspace, execution);
      prNumber = publication.pr.number;
      const reviewOutcome = await this.reviewMergeAndRestart(issue, publication.pr, workspace, execution.validation, execution);
      reviewRounds = reviewOutcome.reviewRounds;
      validationPassed = reviewOutcome.validationPassed;
      merged = reviewOutcome.restartRequested;
      halted = reviewOutcome.halted ?? false;
      status = merged ? "merged" : "blocked";
      return reviewOutcome;
    } catch {
      status = "failed";
      await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
      return { restartRequested: false, halted };
    } finally {
      if (!halted) {
        workspace.cleanup();
      }
      await this.github.removeLabels(issue.number, [IN_PROGRESS_LABEL]);
      this.performance.record({
        timestamp: new Date().toISOString(),
        issueNumber: issue.number,
        status,
        attempts,
        reviewRounds,
        validationPassed,
        prNumber,
        merged,
        durationMs: Date.now() - startedAt
      });
    }
  }

  async executeIssueAttempt(issue, workspace, options = {}) {
    const session = new ExecutionSession(this.planner, workspace, {
      maxSteps: this.options.maxAgentSteps,
      logger: this.logger.child("session", { issueNumber: issue.number, attempt: options.attempt ?? 1 })
    });
    return session.run(issue, options);
  }

  async publishExecution(issue, workspace, execution, existingPr = null) {
    const prTitle = execution.prTitle?.trim() || issue.title;
    const prBody = buildPullRequestBody(issue, execution);
    const result = workspace.commitAndPush(issue, prTitle);

    if (!result.changed || !result.pushed) {
      throw new Error(`Unable to publish execution: ${result.reason ?? "commit or push failed."}`);
    }

    let pr = existingPr ?? await this.github.findOpenPullRequestForIssue(issue.number);
    if (pr) {
      pr = await this.github.updatePullRequest(pr.number, { title: prTitle, body: prBody });
      return { pr, commitSha: result.commitSha };
    }

    pr = await this.github.createPullRequest({ title: prTitle, body: prBody, head: result.branchName, base: "main" });
    return { pr, commitSha: result.commitSha };
  }

  async reviewMergeAndRestart(issue, pr, workspace, validation, execution) {
    let currentPr = pr;
    let currentValidation = validation;
    let currentExecution = execution;

    for (let round = 1; round <= this.options.maxPrFixRounds; round += 1) {
      const review = await this.generateReview(issue, currentPr, currentValidation, round);
      await this.github.commentOnPullRequest(currentPr.number, formatReviewComment(review, round, this.options.maxPrFixRounds));

      if (review.decision === "approve") {
        if (!currentValidation?.passed) {
          await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
          return { restartRequested: false, reviewRounds: round, validationPassed: false };
        }

        const mergedNow = await this.github.mergePullRequest(currentPr.number);
        if (mergedNow) {
          await this.github.closeIssue(issue.number);
          return { restartRequested: true, reviewRounds: round, validationPassed: true };
        }

        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        return { restartRequested: false, reviewRounds: round, validationPassed: Boolean(currentValidation?.passed) };
      }

      const fixExecution = await this.executeIssueAttempt(issue, workspace, { attempt: round + 1, review });
      currentExecution = fixExecution;
      currentValidation = fixExecution.validation;

      if (fixExecution.status !== "done") {
        const halted = workspace.hasUncommittedChanges();
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        return { restartRequested: false, reviewRounds: round, validationPassed: Boolean(currentValidation?.passed), halted };
      }

      const publication = await this.publishExecution(issue, workspace, currentExecution, currentPr);
      currentPr = publication.pr;
    }

    await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
    return { restartRequested: false, reviewRounds: this.options.maxPrFixRounds, validationPassed: Boolean(currentValidation?.passed) };
  }

  async generateReview(issue, pr, validation, round) {
    const prompt = composePrompt([
      `Review pull request #${pr.number} for issue #${issue.number}.`,
      `Validation passed: ${Boolean(validation?.passed)}`,
      "Return JSON only: {\"decision\":\"approve\"|\"request_changes\",\"body\":\"...\",\"rationale\":\"...\"}"
    ].join("\n"));

    try {
      const parsed = JSON.parse(await this.reviewer.complete(prompt));
      return {
        decision: parsed.decision === "approve" ? "approve" : "request_changes",
        body: parsed.body ?? "",
        rationale: parsed.rationale ?? ""
      };
    } catch {
      return {
        decision: "request_changes",
        body: `Reviewer response was invalid in round ${round}.`,
        rationale: "Invalid JSON response"
      };
    }
  }

  async planUpgradeIssues() {
    return [];
  }

  createWorkspace() {
    if (this.options.workspaceFactory) {
      return this.options.workspaceFactory();
    }
    throw new Error("workspaceFactory is required");
  }

  async createIssueIfMissing(title, body, labels = []) {
    const existing = await this.github.findOpenIssueByTitle(title);
    if (existing) {
      return { issueNumber: existing.number, created: false };
    }

    const issueNumber = await this.github.createIssue(title, body);
    if (labels.length > 0) {
      await this.github.addLabels(issueNumber, labels);
    }
    return { issueNumber, created: true };
  }

  async log(issueNumber, message) {
    await this.github.commentOnIssue(issueNumber, message);
  }

  async sleep(ms) {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
