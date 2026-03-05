import { ExecutionSession } from "./executionSession.js";
import { buildIssueMarker } from "./github.js";
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

    this.logger.debug("Evaluating actionable issues", {
      issueNumbers: actionable.map((issue) => issue.number)
    });
    const decision = await this.rankIssueChoices(actionable);
    if (decision.action === "create" && Array.isArray(decision.issues) && decision.issues.length > 0) {
      const first = decision.issues[0];
      const created = await this.createIssueIfMissing(first.title, first.body, ["self-evolution"]);
      const existing = actionable.find((issue) => issue.number === created.issueNumber);
      this.logger.info("Planner requested creation before work", {
        issueNumber: created.issueNumber,
        created: created.created,
        title: first.title
      });
      return existing ?? { number: created.issueNumber, title: first.title, body: first.body, labels: [{ name: "self-evolution" }] };
    }

    if (decision.action === "work" && Number.isInteger(decision.issueNumber)) {
      const picked = actionable.find((issue) => issue.number === decision.issueNumber);
      if (picked) {
        this.logger.info("Planner selected issue", {
          issueNumber: picked.number
        });
        return picked;
      }
    }

    this.logger.warn("Planner selection was invalid; defaulting to first actionable issue", {
      issueNumber: actionable[0].number
    });
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
      "You may either pick one open issue or decide to create a new self-evolution issue first.",
      `Open issues: ${JSON.stringify(summarized)}`,
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
      this.logger.warn("Issue ranking response was invalid; using fallback issue selection");
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
    this.logger.info("Processing issue", {
      issueNumber: issue.number,
      title: issue.title
    });

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
        if (halted) {
          await this.log(issue.number, `🧷 Preserving local branch ${workspace.getBranchName()} with uncommitted work for inspection.`);
        }
        status = "blocked";
        return { restartRequested: false, halted };
      }

      const publication = await this.publishExecution(issue, workspace, execution);
      prNumber = publication.pr.number;
      this.logger.info("Execution published to pull request", {
        issueNumber: issue.number,
        prNumber
      });
      const reviewOutcome = await this.reviewMergeAndRestart(issue, publication.pr, workspace, execution.validation, execution);
      reviewRounds = reviewOutcome.reviewRounds;
      validationPassed = reviewOutcome.validationPassed;
      merged = reviewOutcome.restartRequested;
      halted = reviewOutcome.halted ?? false;
      status = merged ? "merged" : "blocked";
      return reviewOutcome;
    } catch (error) {
      status = "failed";
      this.logger.error("Issue processing failed", {
        issueNumber: issue.number,
        error
      });
      await this.log(issue.number, `💥 Execution failed: ${error.message}`);
      await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
      try {
        halted = workspace.hasUncommittedChanges();
      } catch {
        halted = false;
      }

      if (halted) {
        await this.log(issue.number, `🧷 Preserving local branch ${workspace.getBranchName()} with uncommitted work for inspection.`);
      }

      return { restartRequested: false, halted };
    } finally {
      try {
        if (!halted) {
          workspace.cleanup();
        }
      } catch (cleanupError) {
        await this.log(issue.number, `⚠️ Cleanup failed: ${cleanupError.message}`);
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
      this.logger.info("Recorded performance snapshot", snapshot);
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

    this.logger.info("Starting execution session", {
      issueNumber: issue.number,
      attempt: options.attempt ?? 1
    });
    return session.run(issue, options);
  }

  async publishExecution(issue, workspace, execution, existingPr = null) {
    const prTitle = execution.prTitle?.trim() || issue.title;
    const prBody = buildPullRequestBody(issue, execution);
    const result = workspace.commitAndPush(issue, prTitle);

    if (!result.changed || !result.pushed) {
      if (existingPr && !result.changed) {
        this.logger.warn("Execution follow-up produced no publishable diff", {
          issueNumber: issue.number,
          prNumber: existingPr.number,
          reason: result.reason ?? "unknown"
        });
        return {
          pr: existingPr,
          commitSha: null,
          changed: false,
          reason: result.reason ?? "No new diff was produced."
        };
      }

      this.logger.error("Execution could not be published", {
        issueNumber: issue.number,
        reason: result.reason ?? "unknown"
      });
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
    let currentPr = pr;
    let currentValidation = validation;
    let currentExecution = execution;

    for (let round = 1; round <= this.options.maxPrFixRounds; round += 1) {
      this.logger.info("Starting review round", {
        issueNumber: issue.number,
        prNumber: currentPr.number,
        round
      });
      const review = await this.generateReview(issue, currentPr, round, workspace, currentValidation);
      await this.github.commentOnPullRequest(
        currentPr.number,
        formatReviewComment(review, round, this.options.maxPrFixRounds)
      );
      await this.log(issue.number, `🔍 Review round ${round}/${this.options.maxPrFixRounds}: ${review.decision}. rationale: ${review.rationale ?? "n/a"}`);

      if (review.decision === "approve") {
        if (!currentValidation?.passed) {
          await this.log(issue.number, "⚠️ Review approved but latest validation did not pass. Blocking merge.");
          break;
        }

        const merged = await this.github.mergePullRequest(currentPr.number);
        if (merged) {
          this.logger.info("Pull request merged", {
            issueNumber: issue.number,
            prNumber: currentPr.number
          });
          await this.log(issue.number, `✅ PR #${currentPr.number} merged. Syncing with ${workspace.branchBase}.`);
          await this.github.closeIssue(issue.number);
          if (this.options.dryRun) {
            console.log("[dry-run] would restart process after merge");
          }
          return {
            restartRequested: true,
            halted: false,
            reviewRounds: round,
            validationPassed: true
          };
        }

        await this.log(issue.number, `⚠️ Merge failed for PR #${currentPr.number}.`);
        break;
      }

      if (round >= this.options.maxPrFixRounds) {
        break;
      }

      await this.log(issue.number, `🧰 Applying fixes from review round ${round}.`);
      currentExecution = await this.executeIssueAttempt(issue, workspace, {
        attempt: round,
        previousValidation: currentValidation,
        reviewFeedback: `${review.body}\n\nRationale: ${review.rationale ?? ""}`.trim()
      });
      currentValidation = currentExecution.validation;
      await this.log(issue.number, `🧾 Fix result: ${currentExecution.summary}${currentExecution.rationale ? ` | rationale: ${currentExecution.rationale}` : ""}`);

      if (currentExecution.status !== "done") {
        const halted = workspace.hasUncommittedChanges();
        if (halted) {
          await this.log(issue.number, `🧷 Preserving local branch ${workspace.getBranchName()} with uncommitted work for inspection.`);
        }
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        return {
          restartRequested: false,
          halted,
          reviewRounds: round,
          validationPassed: Boolean(currentValidation?.passed)
        };
      }

      const publication = await this.publishExecution(issue, workspace, currentExecution, currentPr);
      if (!publication.changed) {
        this.logger.warn("Review fix round produced no new diff", {
          issueNumber: issue.number,
          prNumber: currentPr.number,
          round,
          reason: publication.reason ?? "unknown"
        });
        await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
        await this.log(
          issue.number,
          `⛔ Review-requested fix round produced no new diff. Existing PR #${currentPr.number} was left unchanged. Added label: ${NEEDS_HUMAN_LABEL}.${publication.reason ? ` reason: ${publication.reason}` : ""}`
        );
        return {
          restartRequested: false,
          halted: false,
          reviewRounds: round,
          validationPassed: Boolean(currentValidation?.passed)
        };
      }
      currentPr = publication.pr;
    }

    this.logger.warn("Review loop exhausted without approval", {
      issueNumber: issue.number,
      prNumber: currentPr.number
    });
    await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
    await this.log(issue.number, `⛔ PR loop exhausted. Added label: ${NEEDS_HUMAN_LABEL}.`);
    return {
      restartRequested: false,
      halted: false,
      reviewRounds: this.options.maxPrFixRounds,
      validationPassed: Boolean(currentValidation?.passed)
    };
  }

  async generateReview(issue, pr, round, workspace, validation) {
    const prompt = composePrompt([
      "You are reviewing your own PR before merge.",
      `Issue #${issue.number}: ${issue.title}`,
      `PR #${pr.number}: ${pr.title}`,
      `PR body: ${pr.body ?? ""}`,
      `Round ${round}`,
      "Validation summary:",
      validation?.summary ?? "No validation results available.",
      "Diff against base:",
      workspace.diffAgainstBase(),
      'Respond as JSON: {"decision":"approve"|"request_changes","body":"...","rationale":"..."}'
    ].join("\n"));

    try {
      const response = await this.reviewer.complete(prompt);
      const parsed = JSON.parse(response);
      this.logger.debug("Parsed review response", {
        issueNumber: issue.number,
        prNumber: pr.number,
        round,
        decision: parsed.decision ?? null
      });
      return {
        decision: parsed.decision === "request_changes" ? "request_changes" : "approve",
        body: parsed.body ?? "Automated self-review completed.",
        rationale: parsed.rationale ?? "Reviewed against autonomous quality policy."
      };
    } catch {
      this.logger.warn("Reviewer response was invalid; defaulting to request_changes", {
        issueNumber: issue.number,
        prNumber: pr.number,
        round
      });
      return {
        decision: "request_changes",
        body: "Automated reviewer could not validate this PR; requesting another fix cycle.",
        rationale: "Review model unavailable or malformed output."
      };
    }
  }

  async planUpgradeIssues() {
    const baseline = this.performance.latest();
    const prompt = composePrompt([
      "No open actionable issues remain. Plan autonomous upgrades.",
      `Current performance: ${baseline ? JSON.stringify(baseline) : "no history yet"}`,
      'Return JSON object: {"issues":[{"title":"...","body":"..."}],"requestChallenge":true|false}.'
    ].join("\n"));

    let planned = [];
    let requestChallenge = this.idleLoopCount > 2;
    try {
      const parsed = JSON.parse(await this.planner.complete(prompt));
      planned = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      requestChallenge = Boolean(parsed.requestChallenge) || requestChallenge;
      this.logger.info("Planned idle upgrade issues", {
        plannedCount: planned.length,
        requestChallenge
      });
    } catch {
      this.logger.warn("Idle planning response was invalid; using fallback upgrade issue");
      planned = [
        {
          title: "Improve Evolvo issue execution reliability",
          body: "Increase success rate for autonomous issue completion and reduce stuck loops."
        }
      ];
    }

    for (const item of planned) {
      const created = await this.createIssueIfMissing(item.title, item.body, ["self-evolution"]);
      if (created.created) {
        this.logger.info("Created self-evolution issue", {
          issueNumber: created.issueNumber,
          title: item.title
        });
        await this.log(created.issueNumber, "🧭 Created by autonomous self-planning cycle with rationale-driven prioritization.");
      }
    }

    if (requestChallenge) {
      const challengeIssue = await this.createIssueIfMissing(
        "Challenge request: evaluate Evolvo capability growth",
        "I request a new human-defined challenge to verify my current capability and guide the next evolution step.",
        ["challenge-request", "self-evolution"]
      );
      if (challengeIssue.created) {
        this.logger.info("Created challenge request issue", {
          issueNumber: challengeIssue.issueNumber
        });
        await this.log(challengeIssue.issueNumber, "🧪 Challenge request opened to benchmark progress.");
      }
      this.idleLoopCount = 0;
    }
  }

  async createIssueIfMissing(title, body, labels) {
    const existing = await this.github.findOpenIssueByTitle(title);
    if (existing) {
      this.logger.info("Reusing existing issue instead of creating duplicate", {
        issueNumber: existing.number,
        title
      });
      return {
        issueNumber: existing.number,
        created: false
      };
    }

    this.logger.info("Creating new issue", {
      title,
      labels
    });
    return {
      issueNumber: await this.github.createIssue(title, body, labels),
      created: true
    };
  }

  createWorkspace() {
    if (!this.options.workspaceFactory) {
      throw new Error("workspaceFactory is required to execute issues.");
    }

    return this.options.workspaceFactory();
  }

  async log(issueNumber, message) {
    const timestamp = new Date().toISOString();
    this.logger.info("Issue event", {
      issueNumber,
      message
    });
    await this.github.commentOnIssue(issueNumber, `[${timestamp}] ${message}`);
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
