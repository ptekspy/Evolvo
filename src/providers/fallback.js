import { createNoopLogger } from "../logger.js";

function defaultPolicy() {
  return {
    maxConsecutiveMalformedOutputs: 2,
    maxConsecutiveTimeouts: 2,
    maxConsecutivePrimaryFailures: 3,
    maxConsecutiveIdenticalErrors: 3,
    maxNoProgressEvents: 4,
    maxTotalRetryAttempts: 8
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

function createErrorSignature(error) {
  const category = classifyFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase().replace(/\d+/g, "#").slice(0, 200);
  return `${category}:${normalized}`;
}

function progressSignalFromResponse(response) {
  if (typeof response !== "string") {
    return "unknown";
  }

  if (response.trim().length === 0) {
    return "none";
  }

  return "advanced";
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
      consecutivePrimaryFailures: 0,
      consecutiveIdenticalErrors: 0,
      noProgressEvents: 0,
      totalRetryAttempts: 0,
      lastErrorSignature: null
    };
    this.attemptTelemetry = [];
  }

  shouldEscalate() {
    if (!this.fallback) {
      return false;
    }

    return this.state.consecutiveTimeouts >= this.policy.maxConsecutiveTimeouts
      || this.state.consecutiveMalformedOutputs >= this.policy.maxConsecutiveMalformedOutputs
      || this.state.consecutivePrimaryFailures >= this.policy.maxConsecutivePrimaryFailures
      || this.state.consecutiveIdenticalErrors >= this.policy.maxConsecutiveIdenticalErrors
      || this.state.noProgressEvents >= this.policy.maxNoProgressEvents
      || this.state.totalRetryAttempts >= this.policy.maxTotalRetryAttempts;
  }

  buildEscalationEvidence(lastError) {
    return {
      reason: "stuck-detection-threshold-met",
      thresholds: this.policy,
      counters: this.state,
      lastErrorCategory: classifyFailure(lastError),
      lastErrorMessage: lastError instanceof Error ? lastError.message : String(lastError),
      localAttemptTelemetry: this.attemptTelemetry.slice(-this.policy.maxTotalRetryAttempts)
    };
  }

  resetStuckCounters() {
    this.state.consecutiveTimeouts = 0;
    this.state.consecutiveMalformedOutputs = 0;
    this.state.consecutivePrimaryFailures = 0;
    this.state.consecutiveIdenticalErrors = 0;
    this.state.noProgressEvents = 0;
    this.state.totalRetryAttempts = 0;
    this.state.lastErrorSignature = null;
    this.attemptTelemetry = [];
  }

  applyFailure(error) {
    this.state.consecutivePrimaryFailures += 1;
    this.state.totalRetryAttempts += 1;
    const category = classifyFailure(error);
    const signature = createErrorSignature(error);

    if (signature === this.state.lastErrorSignature) {
      this.state.consecutiveIdenticalErrors += 1;
    } else {
      this.state.consecutiveIdenticalErrors = 1;
      this.state.lastErrorSignature = signature;
    }

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

    this.state.noProgressEvents += 1;
  }

  captureAttemptTelemetry(entry) {
    this.attemptTelemetry.push(entry);
  }

  async complete(prompt) {
    const startedAt = Date.now();
    try {
      this.logger.debug("Sending prompt to primary model", {
        promptLength: prompt.length
      });
      const response = await this.primary.complete(prompt);
      this.captureAttemptTelemetry({
        provider: "primary",
        model: this.primary?.model ?? "unknown",
        ok: true,
        latencyMs: Date.now() - startedAt,
        retryCount: this.state.totalRetryAttempts,
        progressSignal: progressSignalFromResponse(response)
      });
      this.resetStuckCounters();
      this.logger.debug("Primary model completed", {
        durationMs: Date.now() - startedAt,
        outputLength: response.length
      });
      return response;
    } catch (primaryError) {
      this.applyFailure(primaryError);
      this.captureAttemptTelemetry({
        provider: "primary",
        model: this.primary?.model ?? "unknown",
        ok: false,
        latencyMs: Date.now() - startedAt,
        retryCount: this.state.totalRetryAttempts,
        errorClass: classifyFailure(primaryError),
        errorSignature: createErrorSignature(primaryError),
        progressSignal: "none"
      });

      if (!this.fallback) {
        this.logger.error("Primary model failed with no fallback configured", {
          durationMs: Date.now() - startedAt,
          error: primaryError,
          counters: this.state,
          localAttemptTelemetry: this.attemptTelemetry
        });
        throw primaryError;
      }

      if (!this.shouldEscalate()) {
        this.logger.warn("Primary model failed but escalation guardrails are not met", {
          durationMs: Date.now() - startedAt,
          error: primaryError,
          counters: this.state,
          thresholds: this.policy,
          localAttemptTelemetry: this.attemptTelemetry
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
      this.captureAttemptTelemetry({
        provider: "fallback",
        model: this.fallback?.model ?? "unknown",
        ok: true,
        latencyMs: Date.now() - fallbackStartedAt,
        retryCount: this.state.totalRetryAttempts,
        progressSignal: progressSignalFromResponse(response)
      });
      this.resetStuckCounters();
      this.logger.debug("Fallback model completed", {
        durationMs: Date.now() - fallbackStartedAt,
        outputLength: response.length
      });
      return response;
    }
  }
}
