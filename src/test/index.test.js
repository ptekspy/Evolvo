import test from "node:test";
import assert from "node:assert/strict";
import { main, restartProcess } from "../index.js";

class StubLogger {
  constructor(scope = "evolvo", entries = []) {
    this.scope = scope;
    this.entries = entries;
  }

  child(scope) {
    return new StubLogger(`${this.scope}.${scope}`, this.entries);
  }

  info(message, metadata) {
    this.entries.push({ level: "info", scope: this.scope, message, metadata });
  }

  warn(message, metadata) {
    this.entries.push({ level: "warn", scope: this.scope, message, metadata });
  }

  error(message, metadata) {
    this.entries.push({ level: "error", scope: this.scope, message, metadata });
  }
}

class StubEvolver {
  async run() {
    return { restartRequested: true };
  }
}

function createConfig(overrides = {}) {
  return {
    githubOwner: "owner",
    githubRepo: "repo",
    githubToken: "token",
    dryRun: false,
    primaryModelProvider: "ollama",
    ollamaModel: "qwen",
    openAiModel: "gpt",
    openAiApiKey: "",
    maxIssueAttempts: 1,
    maxPrFixRounds: 1,
    maxAgentSteps: 1,
    loopDelayMs: 0,
    commandTimeoutMs: 1000,
    logLevel: "info",
    ...overrides
  };
}

test("restartProcess spawns a detached replacement process", () => {
  let spawned = null;
  let unrefCalled = false;
  const child = {
    pid: 321,
    unref() {
      unrefCalled = true;
    }
  };

  const result = restartProcess({
    execPath: "/usr/bin/node",
    args: ["src/index.js"],
    cwd: "/tmp/evolvo",
    env: { TEST_ENV: "1" },
    logger: new StubLogger(),
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      return child;
    }
  });

  assert.equal(result, child);
  assert.deepEqual(spawned, {
    command: "/usr/bin/node",
    args: ["src/index.js"],
    options: {
      cwd: "/tmp/evolvo",
      env: { TEST_ENV: "1" },
      detached: true,
      stdio: "inherit"
    }
  });
  assert.equal(unrefCalled, true);
});

test("main relaunches the process when a live run requests restart", async () => {
  let restartCall = null;
  const logger = new StubLogger();

  const result = await main({
    loadEnvFile() {},
    readConfig: () => createConfig(),
    logger,
    createAgentProviders: () => ({ planner: {}, reviewer: {} }),
    EvolverClass: StubEvolver,
    GitHubClientClass: class {},
    PerformanceTrackerClass: class {},
    WorkspaceClass: class {},
    restartProcess(options) {
      restartCall = options;
      return { pid: 123, unref() {} };
    },
    execPath: "/usr/bin/node",
    args: ["src/index.js"],
    cwd: "/tmp/evolvo",
    env: { TEST_ENV: "1" }
  });

  assert.equal(result.restartRequested, true);
  assert.equal(Boolean(restartCall), true);
  assert.equal(restartCall.execPath, "/usr/bin/node");
  assert.deepEqual(restartCall.args, ["src/index.js"]);
});

test("main skips relaunching when dry-run mode requests restart", async () => {
  let restartInvoked = false;

  const result = await main({
    loadEnvFile() {},
    readConfig: () => createConfig({ dryRun: true }),
    logger: new StubLogger(),
    createAgentProviders: () => ({ planner: {}, reviewer: {} }),
    EvolverClass: StubEvolver,
    GitHubClientClass: class {},
    PerformanceTrackerClass: class {},
    WorkspaceClass: class {},
    restartProcess() {
      restartInvoked = true;
      return { pid: 123, unref() {} };
    }
  });

  assert.equal(result.restartRequested, true);
  assert.equal(restartInvoked, false);
});
