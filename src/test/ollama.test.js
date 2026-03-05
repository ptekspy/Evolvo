import test from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../providers/ollama.js";
import { createNoopLogger } from "../logger.js";

test("OllamaProvider records one telemetry entry for a single non-retryable HTTP failure", async () => {
  const provider = new OllamaProvider("http://localhost:11434", "test-model", createNoopLogger(), {
    retryPolicy: {
      warmupEnabled: false,
      maxAttempts: 3,
      retryOnStatuses: [503]
    },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async text() {
        return "bad request";
      }
    })
  });

  await assert.rejects(async () => {
    await provider.complete("hello");
  }, (error) => {
    assert.equal(Array.isArray(error.attemptTelemetry), true);
    assert.equal(error.attemptTelemetry.length, 1);
    assert.equal(error.attemptTelemetry[0].status, 400);
    return true;
  });
});

test("OllamaProvider does not retry non-retryable thrown errors", async () => {
  let calls = 0;
  const provider = new OllamaProvider("http://localhost:11434", "test-model", createNoopLogger(), {
    retryPolicy: {
      warmupEnabled: false,
      maxAttempts: 3
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("schema invalid response shape");
    }
  });

  await assert.rejects(() => provider.complete("hello"));
  assert.equal(calls, 1);
});

test("OllamaProvider retries retryable HTTP status and succeeds", async () => {
  let calls = 0;
  const provider = new OllamaProvider("http://localhost:11434", "test-model", createNoopLogger(), {
    retryPolicy: {
      warmupEnabled: false,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
      retryOnStatuses: [503]
    },
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          async text() {
            return "temporary unavailable";
          }
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return { response: "ok" };
        }
      };
    }
  });

  const output = await provider.complete("hello");
  assert.equal(output, "ok");
  assert.equal(calls, 2);
});

test("OllamaProvider warmup probe timeout path sets unhealthy lastHealth", async () => {
  const provider = new OllamaProvider("http://localhost:11434", "test-model", createNoopLogger(), {
    retryPolicy: {
      warmupEnabled: true,
      warmupTimeoutMs: 5
    },
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          reject(options.signal.reason ?? new Error("aborted"));
        });
      }
      setTimeout(() => {
        resolve({ ok: true, status: 200, json: async () => ({ response: "late" }) });
      }, 50);
    })
  });

  await assert.rejects(() => provider.complete("hello"));
  assert.equal(provider.lastHealth?.healthy, false);
});
