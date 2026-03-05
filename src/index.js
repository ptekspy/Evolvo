import { readConfig } from "./config.js";
import { Evolver } from "./evolver.js";
import { GitHubClient } from "./github.js";
import { ConsoleLogger } from "./logger.js";
import { PerformanceTracker } from "./performance.js";
import { createAgentProviders } from "./providerSelection.js";
import { Workspace } from "./workspace.js";

async function main() {
  process.loadEnvFile?.(".env");
  const config = readConfig();
  const logger = new ConsoleLogger({
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

  const { planner, reviewer } = createAgentProviders(config, logger.child("models"));

  const evolver = new Evolver(
    planner,
    reviewer,
    new GitHubClient({
      owner: config.githubOwner,
      repo: config.githubRepo,
      token: config.githubToken,
      dryRun: config.dryRun,
      logger: logger.child("github")
    }),
    new PerformanceTracker(".evolvo/performance.json"),
    {
      maxIssueAttempts: config.maxIssueAttempts,
      maxPrFixRounds: config.maxPrFixRounds,
      maxAgentSteps: config.maxAgentSteps,
      loopDelayMs: config.loopDelayMs,
      dryRun: config.dryRun,
      logger: logger.child("runner"),
      workspaceFactory: () => new Workspace(process.cwd(), {
        githubToken: config.githubToken,
        commandTimeoutMs: config.commandTimeoutMs,
        logger: logger.child("workspace")
      })
    }
  );

  logger.info("Starting run loop");
  await evolver.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
