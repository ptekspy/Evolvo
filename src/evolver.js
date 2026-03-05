import { ExecutionSession } from "./executionSession.js";
import { buildIssueMarker } from "./github.js";
import { OutcomeWeightedIssueScorer } from "./issueScoring.js";
import { createNoopLogger } from "./logger.js";
import { composePrompt } from "./masterPrompt.js";

const IN_PROGRESS_LABEL = "in-progress";
const NEEDS_HUMAN_LABEL = "needs-human-intervention";

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

export class Evolver {
  constructor(planner, reviewer, github, performance, options = {}) {
    this.planner = planner;
    this.reviewer = reviewer;
    this.github = github;
    this.performance = performance;
    this.logger = options.logger ?? createNoopLogger();
    this.issueScorer = options.issueScorer ?? new OutcomeWeightedIssueScorer({
      statePath: options.issueScorerStatePath
    });
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
      this.logger.info("Starting loop iteration", {
        loopCount
      });
      const issue = await this.chooseNextActionableIssue();

      if (!issue) {
        this.idleLoopCount += 1;
        this.logger.info("No actionable issues found", {
          idleLoopCount: this.idleLoopCount
        });
        await this.planUpgradeIssues();
        await this.sleep(this.options.loopDelayMs);
        continue;
      }

      this.idleLoopCount = 0;
      this.logger.info("Selected issue for execution", {
        issueNumber: issue.number,
        title: issue.title
      });
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

    const history = this.performance.readAll?.() ?? [];
    const scoredDecision = this.issueScorer.chooseIssue(actionable, history);
    this.logger.debug("Outcome-weighted issue scoring completed", {
      strategy: scoredDecision?.strategy ?? "fallback",
      scores: scoredDecision?.scores ?? []
    });

    const ranked = (scoredDecision?.scores ?? [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((entry) => ({
        ...entry,
        title: actionable.find((issue) => issue.number === entry.issueNumber)?.title ?? ""
      }));

    const plannerDecision = await this.rankIssueChoices(actionable, ranked);
    if (plannerDecision.action === "create" && Array.isArray(plannerDecision.issues) && plannerDecision.issues.length > 0) {
      const first = plannerDecision.issues[0];
      const created = await this.createIssueIfMissing(first.title, first.body, ["self-evolution"]);
      const existing = actionable.find((issue) => issue.number === created.issueNumber);
      this.logger.info("Planner requested creation before work", {
        issueNumber: created.issueNumber,
        created: created.created,
        title: first.title
      });
      return existing ?? { number: created.issueNumber, title: first.title, body: first.body, labels: [{ name: "self-evolution" }] };
    }

    if (plannerDecision.action === "work" && Number.isInteger(plannerDecision.issueNumber)) {
      const picked = actionable.find((issue) => issue.number === plannerDecision.issueNumber);
      if (picked) {
        this.logger.info("Planner selected scored issue", {
          issueNumber: picked.number
        });
        return picked;
      }
    }

    if (scoredDecision?.issue) {
      this.logger.info("Using scorer-selected issue after planner fallback", {
        issueNumber: scoredDecision.issue.number,
        strategy: scoredDecision.strategy
      });
      return scoredDecision.issue;
    }

    this.logger.warn("Issue selection invalid; defaulting to first actionable issue", {
      issueNumber: actionable[0].number
    });
    return actionable[0];
  }

  async rankIssueChoices(actionable, rankedScores = []) {
    const summarized = actionable.map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name))
    }));

    const prompt = composePrompt([
      "You are autonomously choosing the next issue to work on.",
      "Primary signal is the outcome-weighted ranking; only deviate when there is a clear strategic reason.",
      `Open issues: ${JSON.stringify(summarized)}`,
      `Outcome-weighted ranking (desc): ${JSON.stringify(rankedScores)}`,
      "You may either pick one open issue or decide to create a new self-evolution issue first.",
      "Return JSON only:",
      '{"action":"work","issueNumber":123}',
      "or",
      '{"action":"create","issues":[{"title":"...","body":"..."}]}'
    ].join("\n"));

    try {
      const parsed = JSON.parse(await this.planner.complete(prompt));
      this.logger.debug("Issue ranking response parsed", {
        action: parsed.action ?? null
      });
      return parsed;
    } catch {
      this.logger.warn("Issue ranking response was invalid; using score-based fallback");
      return { action: "work", issueNumber: rankedScores[0]?.issueNumber ?? actionable[0].number };
    }
  }

  createWorkspace() {
    if (typeof this.options.workspaceFactory !== "function") {
      throw new Error("workspaceFactory option is required");
    }

    return this.options.workspaceFactory();
  }

  async planUpgradeIssues() {
    return [];
  }

  async createIssueIfMissing(title, body, labels = []) {
    const existing = await this.github.findOpenIssueByTitle?.(title);
    if (existing) {
      return { created: false, issueNumber: existing.number };
    }

    const issueNumber = await this.github.createIssue(title, body, labels);
    return { created: true, issueNumber };
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
      const branchName = workspace.prepareBranch(issue);
      await this.log(issue.number, `🌿 Prepared branch ${branchName}.`);

      let execution = null;
      for (let attempt = 1; attempt <= this.options.maxIssueAttempts; attempt += 1) {
        attempts = attempt;
        await this.log(issue.number, `🛠️ Attempt ${attempt}/${this.options.maxIssueAttempts} to implement issue.`);
        execution = await this.executeIssueAttempt(issue, workspace, { attempt });
        validationPassed = Boolean(execution.validation?.passed);
        await this.log(issue.number, `🧾 Attempt result: ${execution.summary}${execution.rationale ? ` | rationale: ${execution.rationale}` : ""}`);
        if (execution.status === "done") {
          break;
        }
      }

      if (!execution || execution.status !== "done") {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        await this.log(issue.number, `⛔ Unable to complete issue autonomously. Added label: ${NEEDS_HUMAN_LABEL}.`);
        halted = workspace.hasUncommittedChanges();
        status = "blocked";
        return { restartRequested: false, halted };
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
    } catch (error) {
      status = "failed";
      await this.log(issue.number, `💥 Execution failed: ${error.message}`);
      await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
      try {
        halted = workspace.hasUncommittedChanges();
      } catch {
        halted = false;
      }
      return { restartRequested: false, halted };
    } finally {
      try {
        if (!halted) {
          workspace.cleanup();
        }
      } catch {
      }

      await this.github.removeLabels(issue.number, [IN_PROGRESS_LABEL]);
      const snapshot = this.performance.record({
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
      this.issueScorer.updateFromSnapshot(snapshot);
    }
  }

  async executeIssueAttempt(issue, workspace, options = {}) {
    const session = new ExecutionSession(this.planner, workspace, {
      maxSteps: this.options.maxAgentSteps,
      logger: this.logger.child("session", {
        issueNumber: issue.number,
        attempt: options.attempt ?? 1
      })
    });

    return session.run(issue, options);
  }

  async publishExecution(issue, workspace, execution, existingPr = null) {
    const prTitle = execution.prTitle?.trim() || issue.title;
    const prBody = buildPullRequestBody(issue, execution);
    const result = workspace.commitAndPush(issue, prTitle);

    if (!result.changed || !result.pushed) {
      if (existingPr && !result.changed) {
        return {
          pr: existingPr,
          commitSha: null,
          changed: false,
          reason: result.reason ?? "No new diff was produced."
        };
      }
      throw new Error(`Unable to publish execution: ${result.reason ?? "commit or push failed."}`);
    }

    let pr = existingPr ?? await this.github.findOpenPullRequestForIssue(issue.number);
    if (pr) {
      pr = await this.github.updatePullRequest(pr.number, {
        title: prTitle,
        body: prBody
      });
      await this.log(issue.number, `🔄 Updated PR #${pr.number} from branch ${result.branchName}.`);
      return { pr, commitSha: result.commitSha, changed: true };
    }

    pr = await this.github.createPullRequest({
      title: prTitle,
      body: prBody,
      head: result.branchName,
      base: "main"
    });
    await this.log(issue.number, `📬 Opened PR #${pr.number} from branch ${result.branchName}.`);
    return { pr, commitSha: result.commitSha, changed: true };
  }

  async reviewMergeAndRestart(issue, pr, workspace, validation, execution) {
    let latestPr = pr;
    let latestValidation = validation;

    for (let round = 1; round <= this.options.maxPrFixRounds; round += 1) {
      const review = await this.reviewPullRequest(issue, latestPr, latestValidation, execution, round);
      await this.log(issue.number, `🔍 Review round ${round}/${this.options.maxPrFixRounds}: ${review.decision} | rationale: ${review.rationale}`);

      if (review.decision === "approve") {
        await this.github.mergePullRequest(latestPr.number);
        await this.github.closeIssue(issue.number);
        await this.log(issue.number, `✅ Merged PR #${latestPr.number} and closed issue.`);
        return { restartRequested: true, reviewRounds: round, validationPassed: Boolean(latestValidation?.passed), halted: false };
      }

      if (round >= this.options.maxPrFixRounds) {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        await this.log(issue.number, `⛔ Review requested further changes after ${round} rounds. Added ${NEEDS_HUMAN_LABEL}.`);
        return { restartRequested: false, reviewRounds: round, validationPassed: Boolean(latestValidation?.passed), halted: false };
      }

      await this.log(issue.number, `🔁 Applying review feedback round ${round + 1}/${this.options.maxPrFixRounds}.`);
      const followup = await this.executeIssueAttempt(issue, workspace, { attempt: round + 1, reviewRound: round + 1 });
      latestValidation = followup.validation;
      const publication = await this.publishExecution(issue, workspace, followup, latestPr);

      if (publication.changed === false) {
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        await this.log(issue.number, `⛔ Review follow-up produced no new diff. Added label: ${NEEDS_HUMAN_LABEL}.`);
        return { restartRequested: false, reviewRounds: round, validationPassed: Boolean(latestValidation?.passed), halted: false };
      }

      latestPr = publication.pr;
      execution = followup;
    }

    return { restartRequested: false, reviewRounds: this.options.maxPrFixRounds, validationPassed: Boolean(latestValidation?.passed), halted: false };
  }

  async reviewPullRequest(issue, pr, validation, execution, round) {
    const prompt = composePrompt([
      `Issue #${issue.number}: ${issue.title}`,
      `PR #${pr.number}: ${pr.title ?? ""}`,
      `Validation passed: ${Boolean(validation?.passed)}`,
      `Validation summary: ${validation?.summary ?? "n/a"}`,
      `Execution summary: ${execution?.summary ?? "n/a"}`,
      "Return JSON only: {\"decision\":\"approve\"|\"request_changes\",\"body\":\"...\",\"rationale\":\"Intent: ... | Trade-offs: ... | Evidence: ... | Next step: ...\"}"
    ].join("\n"));

    let parsed;
    try {
      parsed = JSON.parse(await this.reviewer.complete(prompt));
    } catch {
      parsed = { decision: "request_changes", body: "Reviewer response invalid JSON.", rationale: "Intent: preserve quality gate | Trade-offs: block merge on invalid review output | Evidence: parsing failed | Next step: rerun review" };
    }

    const review = {
      decision: parsed.decision === "approve" ? "approve" : "request_changes",
      body: parsed.body ?? "No review body provided.",
      rationale: parsed.rationale ?? "Intent: ensure safe merge | Trade-offs: conservative review | Evidence: incomplete review output | Next step: request clarification"
    };

    await this.github.commentOnPullRequest(pr.number, formatReviewComment(review, round, this.options.maxPrFixRounds));
    return review;
  }

  async log(issueNumber, message) {
    await this.github.commentOnIssue(issueNumber, message);
  }

  async sleep(ms) {
    if (!ms || ms <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
