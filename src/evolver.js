import { execSync } from "node:child_process";
import { composePrompt } from "./masterPrompt.js";

const NEEDS_HUMAN_LABEL = "needs-human-intervention";

export class Evolver {
  constructor(planner, reviewer, github, performance, options = {}) {
    this.planner = planner;
    this.reviewer = reviewer;
    this.github = github;
    this.performance = performance;
    this.options = {
      maxIssueAttempts: options.maxIssueAttempts ?? 3,
      maxPrFixRounds: options.maxPrFixRounds ?? 3,
      dryRun: options.dryRun ?? true,
      loopDelayMs: options.loopDelayMs ?? 2000,
      maxLoops: options.maxLoops ?? Number.POSITIVE_INFINITY
    };
    this.idleLoopCount = 0;
  }

  async run() {
    await this.github.ensurePromptIssue();

    let loopCount = 0;
    while (loopCount < this.options.maxLoops) {
      loopCount += 1;
      const issue = await this.chooseNextActionableIssue();

      if (!issue) {
        this.idleLoopCount += 1;
        await this.planUpgradeIssues();
        await this.sleep(this.options.loopDelayMs);
        continue;
      }

      this.idleLoopCount = 0;
      await this.log(issue.number, `🚀 Starting autonomous work on issue #${issue.number}: ${issue.title}`);
      const finished = await this.processIssue(issue);
      if (finished.restartRequested) {
        return { restartRequested: true };
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
    if (decision.action === "create" && Array.isArray(decision.issues) && decision.issues.length > 0) {
      const first = decision.issues[0];
      const issueNumber = await this.github.createIssue(first.title, first.body, ["self-evolution"]);
      return { number: issueNumber, title: first.title, body: first.body, labels: [{ name: "self-evolution" }] };
    }

    if (decision.action === "work" && Number.isInteger(decision.issueNumber)) {
      const picked = actionable.find((issue) => issue.number === decision.issueNumber);
      if (picked) {
        return picked;
      }
    }

    return actionable[Math.floor(Math.random() * actionable.length)];
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
      return JSON.parse(await this.planner.complete(prompt));
    } catch {
      return { action: "work", issueNumber: actionable[0].number };
    }
  }

  async processIssue(issue) {
    let execution = { status: "stuck", summary: "No attempts executed.", rationale: "" };
    for (let attempt = 1; attempt <= this.options.maxIssueAttempts; attempt += 1) {
      await this.log(issue.number, `🛠️ Attempt ${attempt}/${this.options.maxIssueAttempts} to implement issue.`);
      execution = await this.executeIssueAttempt(issue, attempt);
      await this.log(issue.number, `🧾 Attempt result: ${execution.summary}${execution.rationale ? ` | rationale: ${execution.rationale}` : ""}`);
      if (execution.status === "done") {
        break;
      }
    }

    if (execution.status !== "done") {
      await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
      await this.log(issue.number, `⛔ Unable to complete issue autonomously. Added label: ${NEEDS_HUMAN_LABEL}.`);
      return { restartRequested: false };
    }

    return this.reviewMergeAndRestart(issue);
  }

  async executeIssueAttempt(issue, attempt) {
    const prompt = composePrompt([
      "You are implementing the GitHub issue below in a TypeScript engineering repo.",
      `Issue #${issue.number}: ${issue.title}`,
      `Issue body: ${issue.body ?? ""}`,
      `Attempt ${attempt}`,
      "Return JSON with status(done|stuck), summary, rationale, nextStep."
    ].join("\n"));

    try {
      const response = await this.planner.complete(prompt);
      const parsed = JSON.parse(response);
      if (parsed.status === "done") {
        return { status: "done", summary: parsed.summary ?? "Implementation finished.", rationale: parsed.rationale ?? "" };
      }
      return { status: "stuck", summary: parsed.summary ?? "Implementation stalled.", rationale: parsed.rationale ?? parsed.nextStep ?? "" };
    } catch (error) {
      return { status: "stuck", summary: `Planner execution failed: ${error}`, rationale: "Model parsing or provider failure." };
    }
  }

  async reviewMergeAndRestart(issue) {
    const pr = await this.github.findOpenPullRequestForIssue(issue.number);
    if (!pr) {
      await this.log(issue.number, "⚠️ No open PR found linked to this issue. Awaiting PR creation.");
      return { restartRequested: false };
    }

    for (let round = 1; round <= this.options.maxPrFixRounds; round += 1) {
      const review = await this.generateReview(pr, round);
      await this.github.reviewPullRequest(pr.number, review);
      await this.log(issue.number, `🔍 Review round ${round}/${this.options.maxPrFixRounds}: ${review.decision}. rationale: ${review.rationale ?? "n/a"}`);

      if (review.decision === "approve") {
        const merged = await this.github.mergePullRequest(pr.number);
        if (merged) {
          await this.log(issue.number, `✅ PR #${pr.number} merged. Syncing with main and restarting Evolvo.`);
          await this.github.closeIssue(issue.number);
          this.syncMainAndRestart();
          return { restartRequested: true };
        }
        await this.log(issue.number, `⚠️ Merge failed for PR #${pr.number}.`);
        break;
      }

      await this.log(issue.number, `🧰 Applying fixes from review round ${round}.`);
    }

    await this.github.addLabels(issue.number, [NEEDS_HUMAN_LABEL]);
    await this.log(issue.number, `⛔ PR loop exhausted. Added label: ${NEEDS_HUMAN_LABEL}.`);
    return { restartRequested: false };
  }

  async generateReview(pr, round) {
    const prompt = composePrompt([
      "You are reviewing your own PR before merge.",
      `PR #${pr.number}: ${pr.title}`,
      `PR body: ${pr.body ?? ""}`,
      `Round ${round}`,
      "Respond as JSON: {\"decision\":\"approve\"|\"request_changes\",\"body\":\"...\",\"rationale\":\"...\"}."
    ].join("\n"));

    try {
      const response = await this.reviewer.complete(prompt);
      const parsed = JSON.parse(response);
      return {
        decision: parsed.decision === "request_changes" ? "request_changes" : "approve",
        body: parsed.body ?? "Automated self-review completed.",
        rationale: parsed.rationale ?? "Reviewed against autonomous quality policy."
      };
    } catch {
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
      "Return JSON object: {\"issues\":[{\"title\":\"...\",\"body\":\"...\"}],\"requestChallenge\":true|false}."
    ].join("\n"));

    let planned = [];
    let requestChallenge = this.idleLoopCount > 2;
    try {
      const parsed = JSON.parse(await this.planner.complete(prompt));
      planned = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      requestChallenge = Boolean(parsed.requestChallenge) || requestChallenge;
    } catch {
      planned = [
        {
          title: "Improve Evolvo issue execution reliability",
          body: "Increase success rate for autonomous issue completion and reduce stuck loops."
        }
      ];
    }

    for (const item of planned) {
      const issueNumber = await this.github.createIssue(item.title, item.body, ["self-evolution"]);
      await this.log(issueNumber, "🧭 Created by autonomous self-planning cycle with rationale-driven prioritization.");
    }

    if (requestChallenge) {
      const challengeIssue = await this.github.createIssue(
        "Challenge request: evaluate Evolvo capability growth",
        "I request a new human-defined challenge to verify my current capability and guide the next evolution step.",
        ["challenge-request", "self-evolution"]
      );
      await this.log(challengeIssue, "🧪 Challenge request opened to benchmark progress.");
      this.idleLoopCount = 0;
    }
  }

  syncMainAndRestart() {
    if (this.options.dryRun) {
      console.log("[dry-run] would run: git pull --rebase origin main && restart process");
      return;
    }

    execSync("git pull --rebase origin main", { stdio: "inherit" });
    process.exit(75);
  }

  async log(issueNumber, message) {
    const timestamp = new Date().toISOString();
    await this.github.commentOnIssue(issueNumber, `[${timestamp}] ${message}`);
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
