import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { PerformanceTracker } from "../performance.js";

const file = ".evolvo/test-performance.json";

test("PerformanceTracker records and returns latest snapshot", () => {
  rmSync(file, { force: true });
  const tracker = new PerformanceTracker(file);

  tracker.record({
    timestamp: new Date().toISOString(),
    successRate: 0.6,
    escapedDefects: 3,
    leadTimeMinutes: 50,
    benchmarkScore: 0.5
  });

  const latest = tracker.latest();
  assert.ok(latest);
  assert.equal(latest.benchmarkScore, 0.5);
});
