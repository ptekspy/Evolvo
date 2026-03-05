import test from "node:test";
import assert from "node:assert/strict";
import { FallbackProvider } from "../providers/fallback.js";

test("FallbackProvider does not escalate before threshold", async () => {
  const primary = { complete: async () => { throw new Error("down"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutivePrimaryFailures: 3,
      maxConsecutiveIdenticalErrors: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 99
    }
  });

  await assert.rejects(() => provider.complete("hello"), /down/);
});

test("FallbackProvider escalates to fallback after threshold", async () => {
  const primary = { complete: async () => { throw new Error("down"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutivePrimaryFailures: 1,
      maxConsecutiveIdenticalErrors: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 99
    }
  });

  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});

test("FallbackProvider tracks timeout threshold for escalation", async () => {
  const primary = { complete: async () => { throw new Error("request timeout"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutiveTimeouts: 2,
      maxConsecutivePrimaryFailures: 5,
      maxConsecutiveIdenticalErrors: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 99
    }
  });

  await assert.rejects(() => provider.complete("hello"), /timeout/);
  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});

test("FallbackProvider resets stuck counters after successful primary completion", async () => {
  let phase = "timeout";
  const primary = {
    complete: async () => {
      if (phase === "timeout") {
        phase = "success";
        throw new Error("request timeout");
      }

      if (phase === "success") {
        phase = "timeout-again";
        return "primary-ok";
      }

      throw new Error("request timeout");
    }
  };
  const fallback = { complete: async () => "fallback-ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutiveTimeouts: 2,
      maxConsecutivePrimaryFailures: 5,
      maxConsecutiveIdenticalErrors: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 99
    }
  });

  await assert.rejects(() => provider.complete("hello"), /timeout/);
  const success = await provider.complete("hello");
  assert.equal(success, "primary-ok");
  await assert.rejects(() => provider.complete("hello"), /timeout/);
});

test("FallbackProvider escalates on repeated identical error signatures", async () => {
  const primary = { complete: async () => { throw new Error("socket reset on attempt 1"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutivePrimaryFailures: 10,
      maxConsecutiveTimeouts: 10,
      maxConsecutiveMalformedOutputs: 10,
      maxConsecutiveIdenticalErrors: 2,
      maxNoProgressEvents: 10,
      maxTotalRetryAttempts: 10
    }
  });

  await assert.rejects(() => provider.complete("hello"), /socket reset/);
  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});

test("FallbackProvider escalates on no-progress ceiling", async () => {
  const primary = { complete: async () => { throw new Error("temporary down"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutivePrimaryFailures: 10,
      maxConsecutiveTimeouts: 10,
      maxConsecutiveMalformedOutputs: 10,
      maxConsecutiveIdenticalErrors: 10,
      maxNoProgressEvents: 2,
      maxTotalRetryAttempts: 10
    }
  });

  await assert.rejects(() => provider.complete("hello"), /temporary down/);
  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});

test("FallbackProvider escalates when maxTotalRetryAttempts is reached", async () => {
  const primary = { complete: async () => { throw new Error("flaky upstream"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutivePrimaryFailures: 99,
      maxConsecutiveTimeouts: 99,
      maxConsecutiveMalformedOutputs: 99,
      maxConsecutiveIdenticalErrors: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 2
    }
  });

  await assert.rejects(() => provider.complete("hello"), /flaky upstream/);
  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});

test("FallbackProvider preserves primary attempt telemetry when fallback throws", async () => {
  const primary = { complete: async () => { throw new Error("request timeout"); } };
  const fallback = { complete: async () => { throw new Error("fallback down"); } };
  const provider = new FallbackProvider(primary, fallback, undefined, {
    escalationPolicy: {
      maxConsecutiveTimeouts: 1,
      maxConsecutivePrimaryFailures: 99,
      maxConsecutiveIdenticalErrors: 99,
      maxConsecutiveMalformedOutputs: 99,
      maxNoProgressEvents: 99,
      maxTotalRetryAttempts: 99
    }
  });

  await assert.rejects(() => provider.complete("hello"), /fallback down/);
  assert.equal(provider.attemptTelemetry.length, 1);
  assert.equal(provider.attemptTelemetry[0].provider, "primary");
  assert.equal(provider.attemptTelemetry[0].ok, false);
  assert.equal(provider.attemptTelemetry[0].errorClass, "timeout");
});
