import { createNoopLogger } from "../logger.js";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withJitter(ms, jitterRatio) {
  if (jitterRatio <= 0) {
    return ms;
  }

  const delta = ms * jitterRatio;
  const offset = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(ms + offset));
}

function defaultRetryPolicy() {
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

function classifyError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("fetch") || message.includes("network") || message.includes("econn") || message.includes("socket")) {
    return "network";
  }
  if (message.includes("status=")) {
    return "http";
  }
  return "other";
}

export class OllamaProvider {
  constructor(baseUrl, model = "qwen-coder-3:30b", logger = createNoopLogger(), options = {}) {
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

  async probeHealth() {
    const startedAt = this.now();
    const timeout = this.retryPolicy.warmupTimeoutMs;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(timeout)
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
        error
      });
      throw error;
    }
  }

  async complete(prompt) {
    const startedAt = this.now();
    const attempts = this.retryPolicy.maxAttempts;
    const telemetry = [];

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
          body: JSON.stringify({
            model: this.model,
            prompt,
            stream: false
          })
        });

        if (!response.ok) {
          const body = await response.text();
          const isRetryable = this.retryPolicy.retryOnStatuses.includes(response.status);
          const error = new Error(`Ollama request failed: status=${response.status} body=${body}`);
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

        const json = await response.json();
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
          retryTelemetry: telemetry
        });
        return output;
      } catch (error) {
        const category = classifyError(error);
        const retryable = attempt < attempts;
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
          error,
          nextDelayMs: retryable ? retryDelayMs : 0
        });

        if (!retryable) {
          if (error && typeof error === "object") {
            error.attemptTelemetry = telemetry;
          }
          throw error;
        }

        await this.sleepImpl(retryDelayMs);
      }
    }

    const exhausted = new Error(`Ollama retries exhausted for model ${this.model}`);
    exhausted.attemptTelemetry = telemetry;
    throw exhausted;
  }
}
