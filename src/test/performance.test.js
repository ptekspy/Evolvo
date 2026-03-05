import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceTracker } from "../performance.js";

test("PerformanceTracker records and returns latest snapshot", () => {
  const folder = mkdtempSync(join(tmpdir(), "evolvo-performance-"));
  const file = join(folder, "performance.json");
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
  rmSync(folder, { recursive: true, force: true });
});
