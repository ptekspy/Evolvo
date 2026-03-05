import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "./types.js";

export type PerformanceSnapshot = Record<string, JsonValue>;

export class PerformanceTracker {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const folder = dirname(filePath);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
  }

  readAll(): PerformanceSnapshot[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const content = readFileSync(this.filePath, "utf8");
    return JSON.parse(content) as PerformanceSnapshot[];
  }

  record(snapshot: PerformanceSnapshot): PerformanceSnapshot {
    const snapshots = this.readAll();
    snapshots.push(snapshot);
    writeFileSync(this.filePath, JSON.stringify(snapshots, null, 2));
    return snapshot;
  }

  latest(): PerformanceSnapshot | undefined {
    return this.readAll().at(-1);
  }
}
