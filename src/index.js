import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readConfig } from "./config.js";
import { Evolver } from "./evolver.js";
import { GitHubClient } from "./github.js";
import { ConsoleLogger } from "./logger.js";
import { PerformanceTracker } from "./performance.js";
import { createAgentProviders } from "./providerSelection.js";
import { Workspace } from "./workspace.js";

export function restartProcess(options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    options.execPath ?? process.execPath,
    options.args ?? process.argv.slice(1),
    {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      detached: true,
      stdio: "inherit"
    }
  );

  child.unref?.();
  options.logger?.info?.("Spawned replacement process", {
    pid: child.pid ?? null
  });
  return child;
}

export async function main(dependencies = {}) {
  const loadEnvFile = dependencies.loadEnvFile ?? process.loadEnvFile?.bind(process);
  loadEnvFile?.(".env");
  const config = (dependencies.readConfig ?? readConfig)();
  const logger = dependencies.logger ?? new ConsoleLogger({
    level: config.logLevel,
    scope: "evolvo"
  });

  logger.info("Loaded configuration", {
    repo: `${config.githubOwner}/${config.githubRepo}`,
    dryRun: config.dryRun,
    primaryModelProvider: config.primaryModelProvider,
    ollamaModel: config.ollamaModel,
    openAiModel: config.openAiModel,
    openAiFallback: Boolean(config.openAiApiKey),
    maxIssueAttempts: config.maxIssueAttempts,
    maxPrFixRounds: config.maxPrFixRounds,
    maxAgentSteps: config.maxAgentSteps,
    loopDelayMs: config.loopDelayMs,
    commandTimeoutMs: config.commandTimeoutMs,
    logLevel: config.logLevel
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
      workspaceFactory: () => new (dependencies.WorkspaceClass ?? Workspace)(process.cwd(), {
        githubToken: config.githubToken,
        commandTimeoutMs: config.commandTimeoutMs,
        logger: logger.child("workspace")
      })
    }
  );

  logger.info("Starting run loop");
  const outcome = await evolver.run();

  if (outcome.restartRequested) {
    if (config.dryRun) {
      logger.info("Restart requested after merge, but dry-run mode will not relaunch the process.");
      return outcome;
    }

    logger.info("Restart requested after merge; launching replacement process.");
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
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
