import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readConfig } from "./config.js";
import { Evolver } from "./evolver.js";
import { GitHubClient } from "./github.js";
import { ConsoleLogger } from "./logger.js";
import { PerformanceTracker } from "./performance.js";
import { createAgentProviders } from "./providerSelection.js";
import { Workspace } from "./workspace.js";
import type { LoggerLike } from "./types.js";

type SpawnFn = typeof spawn;

interface InstallDependenciesOptions {
  spawnImpl: SpawnFn | undefined;
  command: string | undefined;
  args: string[] | undefined;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  logger: LoggerLike | undefined;
}

interface RestartProcessOptions {
  spawnImpl: SpawnFn | undefined;
  execPath: string | undefined;
  args: string[] | undefined;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  logger: LoggerLike | undefined;
}

interface MainDependencies {
  loadEnvFile?: (path: string) => void;
  readConfig?: typeof readConfig;
  logger?: LoggerLike;
  createAgentProviders?: typeof createAgentProviders;
  EvolverClass?: typeof Evolver;
  GitHubClientClass?: typeof GitHubClient;
  PerformanceTrackerClass?: typeof PerformanceTracker;
  WorkspaceClass?: typeof Workspace;
  installDependencies?: (options: InstallDependenciesOptions) => unknown;
  restartProcess?: (options: RestartProcessOptions) => unknown;
  spawnImpl?: SpawnFn;
  installCommand?: string;
  installArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  args?: string[];
}

export function installDependencies(options: InstallDependenciesOptions) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(options.command ?? "pnpm", options.args ?? ["install", "--frozen-lockfile"], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: "inherit"
  });

  if (typeof child?.on === "function") {
    child.on("exit", (code) => {
      if (code !== 0) {
        options.logger?.warn("Dependency installation exited with non-zero code", { code });
      }
    });
  }

  options.logger?.info("Dependency installation started", {
    command: options.command ?? "pnpm",
    args: options.args ?? ["install", "--frozen-lockfile"]
  });

  return child;
}

export function restartProcess(options: RestartProcessOptions) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(options.execPath ?? process.execPath, options.args ?? process.argv.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: true,
    stdio: "inherit"
  });

  child.unref?.();
  options.logger?.info("Spawned replacement process", {
    pid: child.pid ?? null
  });
  return child;
}

export async function main(dependencies: MainDependencies = {}) {
  const loadEnvFile = dependencies.loadEnvFile ?? process.loadEnvFile?.bind(process);
  loadEnvFile?.(".env");
  const config = (dependencies.readConfig ?? readConfig)();
  const logger =
    dependencies.logger ??
    new ConsoleLogger({
      level: config.logLevel,
      scope: "evolvo"
    });

  const { planner, reviewer } = (dependencies.createAgentProviders ?? createAgentProviders)(config, logger.child("models"));

  const evolver = new (dependencies.EvolverClass ?? Evolver)(
    planner,
    reviewer,
    new (dependencies.GitHubClientClass ?? GitHubClient)({
      owner: config.githubOwner,
      repo: config.githubRepo,
      token: config.githubToken,
      dryRun: config.dryRun,
      logger: logger.child("github")
    }),
    new (dependencies.PerformanceTrackerClass ?? PerformanceTracker)(".evolvo/performance.json"),
    {
      maxIssueAttempts: config.maxIssueAttempts,
      maxPrFixRounds: config.maxPrFixRounds,
      maxAgentSteps: config.maxAgentSteps,
      loopDelayMs: config.loopDelayMs,
      dryRun: config.dryRun,
      logger: logger.child("runner"),
      workspaceFactory: () =>
        new (dependencies.WorkspaceClass ?? Workspace)(process.cwd(), {
          githubToken: config.githubToken,
          commandTimeoutMs: config.commandTimeoutMs,
          logger: logger.child("workspace")
        })
    }
  );

  const outcome = await evolver.run();

  if (outcome.restartRequested) {
    if (config.dryRun) {
      return outcome;
    }

    (dependencies.installDependencies ?? installDependencies)({
      logger,
      spawnImpl: dependencies.spawnImpl,
      command: dependencies.installCommand,
      args: dependencies.installArgs,
      cwd: dependencies.cwd,
      env: dependencies.env
    });

    (dependencies.restartProcess ?? restartProcess)({
      logger,
      spawnImpl: dependencies.spawnImpl,
      execPath: dependencies.execPath,
      args: dependencies.args,
      cwd: dependencies.cwd,
      env: dependencies.env
    });
  }

  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
