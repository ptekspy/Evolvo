import { createNoopLogger } from "../logger.js";
import type { JsonValue, LoggerLike } from "../types.js";

interface CompletionProvider {
  model?: string;
  complete(prompt: string): Promise<string>;
}

type FailureCategory = "timeout" | "malformed" | "other";
type ProgressSignal = "unknown" | "none" | "advanced";

interface EscalationPolicy {
  maxConsecutiveMalformedOutputs: number;
  maxConsecutiveTimeouts: number;
  maxConsecutivePrimaryFailures: number;
  maxConsecutiveIdenticalErrors: number;
  maxNoProgressEvents: number;
  maxTotalRetryAttempts: number;
}

interface FallbackState {
  consecutiveTimeouts: number;
  consecutiveMalformedOutputs: number;
  consecutivePrimaryFailures: number;
  consecutiveIdenticalErrors: number;
  noProgressEvents: number;
  totalRetryAttempts: number;
  lastErrorSignature: string | null;
}

interface AttemptTelemetry {
  provider: "primary" | "fallback";
  model: string;
  ok: boolean;
  latencyMs: number;
  retryCount: number;
  progressSignal: ProgressSignal;
  errorClass?: FailureCategory;
  errorSignature?: string;
}

interface EscalationEvidence {
  reason: string;
  thresholds: EscalationPolicy;
  counters: FallbackState;
  lastErrorCategory: FailureCategory;
  lastErrorMessage: string;
  localAttemptTelemetry: AttemptTelemetry[];
}

interface FallbackProviderOptions {
  escalationPolicy?: Partial<EscalationPolicy>;
}

function defaultPolicy(): EscalationPolicy {
  return {
    maxConsecutiveMalformedOutputs: 2,
    maxConsecutiveTimeouts: 2,
    maxConsecutivePrimaryFailures: 3,
    maxConsecutiveIdenticalErrors: 3,
    maxNoProgressEvents: 4,
    maxTotalRetryAttempts: 8
  };
}

function classifyFailure(error: unknown): FailureCategory {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("malformed") || message.includes("invalid") || message.includes("parse")) return "malformed";
  return "other";
}

function createErrorSignature(error: unknown): string {
  const category = classifyFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase().replace(/\d+/g, "#").slice(0, 200);
  return `${category}:${normalized}`;
}

function progressSignalFromResponse(response: unknown): ProgressSignal {
  if (typeof response !== "string") return "unknown";
  if (response.trim().length === 0) return "none";
  return "advanced";
}

function toJsonValue(error: unknown): JsonValue {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean" || error === null) {
    return error;
  }
  return String(error);
}

function stateToJson(state: FallbackState): JsonValue {
  return {
    consecutiveTimeouts: state.consecutiveTimeouts,
    consecutiveMalformedOutputs: state.consecutiveMalformedOutputs,
    consecutivePrimaryFailures: state.consecutivePrimaryFailures,
    consecutiveIdenticalErrors: state.consecutiveIdenticalErrors,
    noProgressEvents: state.noProgressEvents,
    totalRetryAttempts: state.totalRetryAttempts,
    lastErrorSignature: state.lastErrorSignature
  };
}

function policyToJson(policy: EscalationPolicy): JsonValue {
  return {
    maxConsecutiveMalformedOutputs: policy.maxConsecutiveMalformedOutputs,
    maxConsecutiveTimeouts: policy.maxConsecutiveTimeouts,
    maxConsecutivePrimaryFailures: policy.maxConsecutivePrimaryFailures,
    maxConsecutiveIdenticalErrors: policy.maxConsecutiveIdenticalErrors,
    maxNoProgressEvents: policy.maxNoProgressEvents,
    maxTotalRetryAttempts: policy.maxTotalRetryAttempts
  };
}

function telemetryToJson(telemetry: AttemptTelemetry[]): JsonValue {
  return telemetry.map((t) => ({
    provider: t.provider,
    model: t.model,
    ok: t.ok,
    latencyMs: t.latencyMs,
    retryCount: t.retryCount,
    progressSignal: t.progressSignal,
    errorClass: t.errorClass ?? null,
    errorSignature: t.errorSignature ?? null
  }));
}

function evidenceToJson(evidence: EscalationEvidence): JsonValue {
  return {
    reason: evidence.reason,
    thresholds: policyToJson(evidence.thresholds),
    counters: stateToJson(evidence.counters),
    lastErrorCategory: evidence.lastErrorCategory,
    lastErrorMessage: evidence.lastErrorMessage,
    localAttemptTelemetry: telemetryToJson(evidence.localAttemptTelemetry)
  };
}

export class FallbackProvider {
  readonly primary: CompletionProvider;
  readonly fallback: CompletionProvider | null;
  readonly logger: LoggerLike;
  readonly policy: EscalationPolicy;
  state: FallbackState;
  attemptTelemetry: AttemptTelemetry[];

  constructor(primary: CompletionProvider, fallback: CompletionProvider | null, logger: LoggerLike = createNoopLogger(), options: FallbackProviderOptions = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
    this.policy = { ...defaultPolicy(), ...(options.escalationPolicy ?? {}) };
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

  shouldEscalate(): boolean {
    if (!this.fallback) return false;
    return this.state.consecutiveTimeouts >= this.policy.maxConsecutiveTimeouts
      || this.state.consecutiveMalformedOutputs >= this.policy.maxConsecutiveMalformedOutputs
      || this.state.consecutivePrimaryFailures >= this.policy.maxConsecutivePrimaryFailures
      || this.state.consecutiveIdenticalErrors >= this.policy.maxConsecutiveIdenticalErrors
      || this.state.noProgressEvents >= this.policy.maxNoProgressEvents
      || this.state.totalRetryAttempts >= this.policy.maxTotalRetryAttempts;
  }

  buildEscalationEvidence(lastError: unknown): EscalationEvidence {
    return {
      reason: "stuck-detection-threshold-met",
      thresholds: this.policy,
      counters: this.state,
      lastErrorCategory: classifyFailure(lastError),
      lastErrorMessage: lastError instanceof Error ? lastError.message : String(lastError),
      localAttemptTelemetry: this.attemptTelemetry.slice(-this.policy.maxTotalRetryAttempts)
    };
  }

  resetStuckCounters(): void {
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

  applyFailure(error: unknown): void {
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

    this.state.consecutiveTimeouts = category === "timeout" ? this.state.consecutiveTimeouts + 1 : 0;
    this.state.consecutiveMalformedOutputs = category === "malformed" ? this.state.consecutiveMalformedOutputs + 1 : 0;
    this.state.noProgressEvents += 1;
  }

  captureAttemptTelemetry(entry: AttemptTelemetry): void {
    this.attemptTelemetry.push(entry);
  }

  async complete(prompt: string): Promise<string> {
    const startedAt = Date.now();
    try {
      this.logger.debug("Sending prompt to primary model", { promptLength: prompt.length });
      const response = await this.primary.complete(prompt);
      this.captureAttemptTelemetry({
        provider: "primary",
        model: this.primary.model ?? "unknown",
        ok: true,
        latencyMs: Date.now() - startedAt,
        retryCount: this.state.totalRetryAttempts,
        progressSignal: progressSignalFromResponse(response)
      });
      this.resetStuckCounters();
      this.logger.debug("Primary model completed", { durationMs: Date.now() - startedAt, outputLength: response.length });
      return response;
    } catch (primaryError) {
      this.applyFailure(primaryError);
      this.captureAttemptTelemetry({
        provider: "primary",
        model: this.primary.model ?? "unknown",
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
          error: toJsonValue(primaryError),
          counters: stateToJson(this.state),
          localAttemptTelemetry: telemetryToJson(this.attemptTelemetry)
        });
        throw primaryError;
      }

      if (!this.shouldEscalate()) {
        this.logger.warn("Primary model failed but escalation guardrails are not met", {
          durationMs: Date.now() - startedAt,
          error: toJsonValue(primaryError),
          counters: stateToJson(this.state),
          thresholds: policyToJson(this.policy),
          localAttemptTelemetry: telemetryToJson(this.attemptTelemetry)
        });
        throw primaryError;
      }

      const evidence = this.buildEscalationEvidence(primaryError);
      this.logger.warn("Primary model failed, escalating to fallback model", {
        durationMs: Date.now() - startedAt,
        error: toJsonValue(primaryError),
        escalationEvidence: evidenceToJson(evidence)
      });

      const fallbackStartedAt = Date.now();
      const response = await this.fallback.complete(prompt);
      this.captureAttemptTelemetry({
        provider: "fallback",
        model: this.fallback.model ?? "unknown",
        ok: true,
        latencyMs: Date.now() - fallbackStartedAt,
        retryCount: this.state.totalRetryAttempts,
        progressSignal: progressSignalFromResponse(response)
      });
      this.resetStuckCounters();
      this.logger.debug("Fallback model completed", { durationMs: Date.now() - fallbackStartedAt, outputLength: response.length });
      return response;
    }
  }
}
