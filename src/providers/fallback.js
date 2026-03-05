import { createNoopLogger } from "../logger.js";

function defaultPolicy() {
  return {
    maxConsecutiveMalformedOutputs: 2,
    maxConsecutiveTimeouts: 2,
    maxConsecutivePrimaryFailures: 3
  };
}

function classifyFailure(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("timeout")) {
    return "timeout";
  }

  if (message.includes("malformed") || message.includes("invalid") || message.includes("parse")) {
    return "malformed";
  }

  return "other";
}

export class FallbackProvider {
  constructor(primary, fallback, logger = createNoopLogger(), options = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
    this.policy = {
      ...defaultPolicy(),
      ...(options?.escalationPolicy ?? {})
    };
    this.state = {
      consecutiveTimeouts: 0,
      consecutiveMalformedOutputs: 0,
      consecutivePrimaryFailures: 0
    };
  }

  shouldEscalate() {
    if (!this.fallback) {
      return false;
    }

    return this.state.consecutiveTimeouts >= this.policy.maxConsecutiveTimeouts
      || this.state.consecutiveMalformedOutputs >= this.policy.maxConsecutiveMalformedOutputs
      || this.state.consecutivePrimaryFailures >= this.policy.maxConsecutivePrimaryFailures;
  }

  buildEscalationEvidence(lastError) {
    return {
      reason: "stuck-detection-threshold-met",
      thresholds: this.policy,
      counters: this.state,
      lastErrorCategory: classifyFailure(lastError),
      lastErrorMessage: lastError instanceof Error ? lastError.message : String(lastError)
    };
  }

  resetStuckCounters() {
    this.state.consecutiveTimeouts = 0;
    this.state.consecutiveMalformedOutputs = 0;
    this.state.consecutivePrimaryFailures = 0;
  }

  applyFailure(error) {
    this.state.consecutivePrimaryFailures += 1;
    const category = classifyFailure(error);

    if (category === "timeout") {
      this.state.consecutiveTimeouts += 1;
    } else {
      this.state.consecutiveTimeouts = 0;
    }

    if (category === "malformed") {
      this.state.consecutiveMalformedOutputs += 1;
    } else {
      this.state.consecutiveMalformedOutputs = 0;
    }
  }

  async complete(prompt) {
    const startedAt = Date.now();
    try {
      this.logger.debug("Sending prompt to primary model", {
        promptLength: prompt.length
      });
      const response = await this.primary.complete(prompt);
      this.resetStuckCounters();
      this.logger.debug("Primary model completed", {
        durationMs: Date.now() - startedAt,
        outputLength: response.length
      });
      return response;
    } catch (primaryError) {
      this.applyFailure(primaryError);

      if (!this.fallback) {
        this.logger.error("Primary model failed with no fallback configured", {
          durationMs: Date.now() - startedAt,
          error: primaryError,
          counters: this.state
        });
        throw primaryError;
      }

      if (!this.shouldEscalate()) {
        this.logger.warn("Primary model failed but escalation guardrails are not met", {
          durationMs: Date.now() - startedAt,
          error: primaryError,
          counters: this.state,
          thresholds: this.policy
        });
        throw primaryError;
      }

      const evidence = this.buildEscalationEvidence(primaryError);
      this.logger.warn("Primary model failed, escalating to fallback model", {
        durationMs: Date.now() - startedAt,
        error: primaryError,
        escalationEvidence: evidence
      });

      const fallbackStartedAt = Date.now();
      const response = await this.fallback.complete(prompt);
      this.resetStuckCounters();
      this.logger.debug("Fallback model completed", {
        durationMs: Date.now() - fallbackStartedAt,
        outputLength: response.length
      });
      return response;
    }
  }
}
