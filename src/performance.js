import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class PerformanceTracker {
  constructor(filePath) {
    this.filePath = filePath;
    const folder = dirname(filePath);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
  }

  readAll() {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const content = readFileSync(this.filePath, "utf8");
    return JSON.parse(content);
  }

  record(snapshot) {
    const snapshots = this.readAll();
    snapshots.push(snapshot);
    writeFileSync(this.filePath, JSON.stringify(snapshots, null, 2));
    return snapshot;
  }

  latest() {
    return this.readAll().at(-1);
  }
}
