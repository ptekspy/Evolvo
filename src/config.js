function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPrimaryModelProvider() {
  const value = (process.env.PRIMARY_MODEL_PROVIDER ?? "ollama").toLowerCase();
  if (value !== "ollama" && value !== "openai") {
    throw new Error(`Invalid PRIMARY_MODEL_PROVIDER: ${value}. Expected "ollama" or "openai".`);
  }

  return value;
}

export function readConfig() {
  return {
    githubOwner: requireEnv("GITHUB_OWNER"),
    githubRepo: requireEnv("GITHUB_REPO"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    primaryModelProvider: readPrimaryModelProvider(),
    openAiApiKey: process.env.OPENAI_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen-coder-3:30b",
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-5.3-codex",
    maxIssueAttempts: Number(process.env.MAX_ISSUE_ATTEMPTS ?? "3"),
    maxPrFixRounds: Number(process.env.MAX_PR_FIX_ROUNDS ?? "3"),
    maxAgentSteps: Number(process.env.MAX_AGENT_STEPS ?? "40"),
    commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? "120000"),
    logLevel: process.env.LOG_LEVEL ?? "info",
    loopDelayMs: Number(process.env.LOOP_DELAY_MS ?? "2000"),
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true"
  };
}
