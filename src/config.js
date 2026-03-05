function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readConfig() {
  return {
    githubOwner: requireEnv("GITHUB_OWNER"),
    githubRepo: requireEnv("GITHUB_REPO"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    openAiApiKey: process.env.OPENAI_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen-coder-3:30b",
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-5.3-codex",
    maxIssueAttempts: Number(process.env.MAX_ISSUE_ATTEMPTS ?? "3"),
    maxPrFixRounds: Number(process.env.MAX_PR_FIX_ROUNDS ?? "3"),
    loopDelayMs: Number(process.env.LOOP_DELAY_MS ?? "2000"),
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true"
  };
}
