import { createNoopLogger } from "../logger.js";
import type { JsonValue, LoggerLike } from "../types.js";

interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  warmupEnabled: boolean;
  warmupTimeoutMs: number;
  retryOnStatuses: number[];
}

interface OllamaProviderOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  retryPolicy?: Partial<RetryPolicy>;
}

type ErrorCategory = "timeout" | "network" | "http" | "other";

interface AttemptTelemetry {
  attempt: number;
  ok: boolean;
  status: number | null;
  retryable?: boolean;
  durationMs: number;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  nextDelayMs?: number;
  outputLength?: number;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface HealthState {
  healthy: boolean;
  status: number | null;
  checkedAt: string;
  durationMs: number;
  error?: string;
}

type ErrorWithTelemetry = Error & { attemptTelemetry?: AttemptTelemetry[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withJitter(ms: number, jitterRatio: number): number {
  if (jitterRatio <= 0) return ms;
  const delta = ms * jitterRatio;
  const offset = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(ms + offset));
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 4000,
    jitterRatio: 0.2,
    warmupEnabled: true,
    warmupTimeoutMs: 1500,
    retryOnStatuses: [408, 409, 425, 429, 500, 502, 503, 504]
  };
}

function classifyError(error: unknown): ErrorCategory {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("fetch") || message.includes("network") || message.includes("econn") || message.includes("socket")) return "network";
  if (message.includes("status=")) return "http";
  return "other";
}

function isRetryableErrorCategory(category: ErrorCategory): boolean {
  return category === "timeout" || category === "network";
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup() {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    }
  };
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

function telemetryToJson(telemetry: AttemptTelemetry[]): JsonValue {
  return telemetry.map((t) => ({
    attempt: t.attempt,
    ok: t.ok,
    status: t.status,
    retryable: t.retryable ?? null,
    durationMs: t.durationMs,
    errorCategory: t.errorCategory ?? null,
    errorMessage: t.errorMessage ?? null,
    nextDelayMs: t.nextDelayMs ?? null,
    outputLength: t.outputLength ?? null
  }));
}

export class OllamaProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly logger: LoggerLike;
  readonly fetchImpl: typeof fetch;
  readonly sleepImpl: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly retryPolicy: RetryPolicy;
  lastHealth: HealthState | null;

  constructor(baseUrl: string, model = "qwen-coder-3:30b", logger: LoggerLike = createNoopLogger(), options: OllamaProviderOptions = {}) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.logger = logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.now = options.now ?? (() => Date.now());
    this.retryPolicy = {
      ...defaultRetryPolicy(),
      ...(options.retryPolicy ?? {})
    };
    this.lastHealth = null;
  }

  async probeHealth(): Promise<HealthState> {
    const startedAt = this.now();
    const timeout = this.retryPolicy.warmupTimeoutMs;
    const { signal, cleanup } = createTimeoutSignal(timeout);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal
      });

      const healthy = response.ok;
      this.lastHealth = {
        healthy,
        status: response.status,
        checkedAt: new Date().toISOString(),
        durationMs: this.now() - startedAt
      };

      if (!healthy) {
        throw new Error(`Ollama health probe failed: status=${response.status}`);
      }

      this.logger.debug("Ollama health probe succeeded", {
        model: this.model,
        status: response.status,
        durationMs: this.lastHealth.durationMs
      });
      return this.lastHealth;
    } catch (error) {
      this.lastHealth = {
        healthy: false,
        status: null,
        checkedAt: new Date().toISOString(),
        durationMs: this.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
      this.logger.warn("Ollama health probe failed", {
        model: this.model,
        durationMs: this.lastHealth.durationMs,
        error: toJsonValue(error)
      });
      throw error;
    } finally {
      cleanup();
    }
  }

  async complete(prompt: string): Promise<string> {
    const startedAt = this.now();
    const attempts = this.retryPolicy.maxAttempts;
    const telemetry: AttemptTelemetry[] = [];

    if (this.retryPolicy.warmupEnabled) {
      await this.probeHealth();
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptStartedAt = this.now();
      const backoff = Math.min(this.retryPolicy.maxDelayMs, this.retryPolicy.baseDelayMs * (2 ** (attempt - 1)));
      const retryDelayMs = withJitter(backoff, this.retryPolicy.jitterRatio);

      try {
        this.logger.debug("Calling Ollama", {
          model: this.model,
          promptLength: prompt.length,
          attempt,
          attempts
        });

        const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, prompt, stream: false })
        });

        if (!response.ok) {
          const body = await response.text();
          const isRetryable = this.retryPolicy.retryOnStatuses.includes(response.status);
          const error: ErrorWithTelemetry = new Error(`Ollama request failed: status=${response.status} body=${body}`);
          telemetry.push({
            attempt,
            ok: false,
            status: response.status,
            retryable: isRetryable,
            durationMs: this.now() - attemptStartedAt,
            errorCategory: "http",
            errorMessage: error.message,
            nextDelayMs: isRetryable && attempt < attempts ? retryDelayMs : 0
          });

          this.logger.warn("Ollama attempt failed", {
            model: this.model,
            attempt,
            attempts,
            status: response.status,
            retryable: isRetryable,
            durationMs: this.now() - attemptStartedAt,
            nextDelayMs: isRetryable && attempt < attempts ? retryDelayMs : 0
          });

          if (!isRetryable || attempt >= attempts) {
            error.attemptTelemetry = telemetry;
            throw error;
          }

          await this.sleepImpl(retryDelayMs);
          continue;
        }

        const json = (await response.json()) as OllamaGenerateResponse;
        const output = json.response ?? "";
        telemetry.push({
          attempt,
          ok: true,
          status: response.status,
          durationMs: this.now() - attemptStartedAt,
          outputLength: output.length
        });

        this.logger.debug("Ollama response received", {
          model: this.model,
          durationMs: this.now() - startedAt,
          outputLength: output.length,
          attemptsUsed: attempt,
          retryTelemetry: telemetryToJson(telemetry)
        });
        return output;
      } catch (error) {
        const alreadyCapturedHttpError = error instanceof Error && /Ollama request failed: status=\d+/.test(error.message);
        if (alreadyCapturedHttpError) {
          const typed = error as ErrorWithTelemetry;
          typed.attemptTelemetry = telemetry;
          throw typed;
        }

        const category = classifyError(error);
        const retryable = attempt < attempts && isRetryableErrorCategory(category);
        telemetry.push({
          attempt,
          ok: false,
          status: null,
          retryable,
          durationMs: this.now() - attemptStartedAt,
          errorCategory: category,
          errorMessage: error instanceof Error ? error.message : String(error),
          nextDelayMs: retryable ? retryDelayMs : 0
        });

        this.logger.warn("Ollama attempt threw error", {
          model: this.model,
          attempt,
          attempts,
          retryable,
          durationMs: this.now() - attemptStartedAt,
          error: toJsonValue(error),
          nextDelayMs: retryable ? retryDelayMs : 0
        });

        if (!retryable) {
          if (error instanceof Error) {
            const typed = error as ErrorWithTelemetry;
            typed.attemptTelemetry = telemetry;
            throw typed;
          }
          throw error;
        }

        await this.sleepImpl(retryDelayMs);
      }
    }

    const exhausted: ErrorWithTelemetry = new Error(`Ollama retries exhausted for model ${this.model}`);
    exhausted.attemptTelemetry = telemetry;
    throw exhausted;
  }
}
