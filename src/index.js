import { readConfig } from "./config.js";
import { Evolver } from "./evolver.js";
import { GitHubClient } from "./github.js";
import { PerformanceTracker } from "./performance.js";
import { FallbackProvider } from "./providers/fallback.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAiProvider } from "./providers/openai.js";

async function main() {
  const config = readConfig();

  const ollama = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
  const openAiFallback = config.openAiApiKey
    ? new OpenAiProvider(config.openAiApiKey, config.openAiModel)
    : null;

  const planner = new FallbackProvider(ollama, openAiFallback);
  const reviewer = new FallbackProvider(ollama, openAiFallback);

  const evolver = new Evolver(
    planner,
    reviewer,
    new GitHubClient({
      owner: config.githubOwner,
      repo: config.githubRepo,
      token: config.githubToken,
      dryRun: config.dryRun
    }),
    new PerformanceTracker(".evolvo/performance.json"),
    {
      maxIssueAttempts: config.maxIssueAttempts,
      maxPrFixRounds: config.maxPrFixRounds,
      loopDelayMs: config.loopDelayMs,
      dryRun: config.dryRun
    }
  );

  await evolver.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
