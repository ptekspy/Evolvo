import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_WEIGHTS = {
  validationPassed: 1,
  merged: 1,
  reviewRounds: -0.2,
  attempts: -0.2,
  durationMs: -0.000001
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function toSignals(snapshot = {}) {
  return {
    validationPassed: snapshot.validationPassed ? 1 : 0,
    merged: snapshot.merged ? 1 : 0,
    reviewRounds: Number.isFinite(snapshot.reviewRounds) ? snapshot.reviewRounds : 0,
    attempts: Number.isFinite(snapshot.attempts) ? snapshot.attempts : 0,
    durationMs: Number.isFinite(snapshot.durationMs) ? snapshot.durationMs : 0
  };
}

export class OutcomeWeightedIssueScorer {
  constructor(options = {}) {
    this.statePath = options.statePath ?? ".evolvo/issue-scorer-state.json";
    this.epsilon = options.epsilon ?? 0.2;
    this.learningRate = options.learningRate ?? 0.05;
    this.defaultWeights = { ...DEFAULT_WEIGHTS, ...(options.defaultWeights ?? {}) };
    this.state = this.loadState();
  }

  loadState() {
    if (!existsSync(this.statePath)) {
      return {
        version: 1,
        epsilon: this.epsilon,
        learningRate: this.learningRate,
        weights: { ...this.defaultWeights }
      };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      return {
        version: 1,
        epsilon: Number.isFinite(parsed?.epsilon) ? parsed.epsilon : this.epsilon,
        learningRate: Number.isFinite(parsed?.learningRate) ? parsed.learningRate : this.learningRate,
        weights: { ...this.defaultWeights, ...(parsed?.weights ?? {}) }
      };
    } catch {
      return {
        version: 1,
        epsilon: this.epsilon,
        learningRate: this.learningRate,
        weights: { ...this.defaultWeights }
      };
    }
  }

  saveState() {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  updateFromSnapshot(snapshot) {
    const signals = toSignals(snapshot);
    const reward = clamp(
      (signals.validationPassed * 0.3)
        + (signals.merged * 0.7)
        - (signals.reviewRounds * 0.05)
        - (signals.attempts * 0.05)
        - (signals.durationMs * 0.00000005),
      0,
      1
    );

    for (const key of Object.keys(this.state.weights)) {
      const feature = signals[key] ?? 0;
      this.state.weights[key] += this.state.learningRate * reward * feature;
    }

    this.saveState();
    return { reward, weights: { ...this.state.weights } };
  }

  scoreIssue(issue, history = []) {
    const issueHistory = history.filter((entry) => entry.issueNumber === issue.number);
    const latest = issueHistory.at(-1) ?? {};
    const signals = toSignals(latest);

    let score = 0;
    for (const [key, weight] of Object.entries(this.state.weights)) {
      score += weight * (signals[key] ?? 0);
    }

    return sigmoid(score);
  }

  chooseIssue(issues, history = []) {
    if (issues.length === 0) {
      return null;
    }

    const exploring = Math.random() < this.state.epsilon;
    if (exploring) {
      const randomIndex = Math.floor(Math.random() * issues.length);
      return {
        issue: issues[randomIndex],
        strategy: "explore",
        scores: issues.map((issue) => ({ issueNumber: issue.number, score: this.scoreIssue(issue, history) }))
      };
    }

    const scored = issues.map((issue) => ({ issue, score: this.scoreIssue(issue, history) }));
    scored.sort((a, b) => b.score - a.score);
    return {
      issue: scored[0].issue,
      strategy: "exploit",
      scores: scored.map((entry) => ({ issueNumber: entry.issue.number, score: entry.score }))
    };
  }
}
