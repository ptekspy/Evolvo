import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createAgentProviders } from "../providerSelection.js";
import { createNoopLogger } from "../logger.js";
import type { AppConfig } from "../config.js";

class StubProvider {
  public readonly args: unknown[];

  constructor(...args: unknown[]) {
    this.args = args;
  }

  async complete(): Promise<string> {
    return "ok";
  }
}

class StubFallbackProvider {
  public readonly primary: StubProvider;
  public readonly fallback: StubProvider | null;
  public readonly logger: unknown;

  constructor(primary: StubProvider, fallback: StubProvider | null, logger: unknown) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    githubOwner: "owner",
    githubRepo: "repo",
    githubToken: "token",
    primaryModelProvider: "ollama",
    openAiApiKey: "key",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen3-coder:30b",
    openAiModel: "gpt-5.3-codex",
    maxIssueAttempts: 3,
    maxPrFixRounds: 3,
    maxAgentSteps: 40,
    commandTimeoutMs: 120000,
    logLevel: "info",
    loopDelayMs: 2000,
    dryRun: true,
    ...overrides
  };
}

test("createAgentProviders uses Ollama as primary by default and OpenAI as fallback", () => {
  const providers = createAgentProviders(createConfig(), createNoopLogger(), {
    FallbackProvider: StubFallbackProvider as never,
    OllamaProvider: StubProvider as never,
    OpenAiProvider: StubProvider as never
  });

  assert.equal(providers.primaryProviderName, "ollama");
  assert.equal(providers.fallbackProviderName, "openai");
  assert.equal((providers.planner as unknown as StubFallbackProvider).primary.args[1], "qwen3-coder:30b");
  assert.equal((providers.planner as unknown as StubFallbackProvider).fallback?.args[1], "gpt-5.3-codex");
});

test("createAgentProviders can use OpenAI as primary and Ollama as fallback", () => {
  const providers = createAgentProviders(
    createConfig({
      primaryModelProvider: "openai"
    }),
    createNoopLogger(),
    {
      FallbackProvider: StubFallbackProvider as never,
      OllamaProvider: StubProvider as never,
      OpenAiProvider: StubProvider as never
    }
  );

  assert.equal(providers.primaryProviderName, "openai");
  assert.equal(providers.fallbackProviderName, "ollama");
  assert.equal((providers.planner as unknown as StubFallbackProvider).primary.args[1], "gpt-5.3-codex");
  assert.equal((providers.planner as unknown as StubFallbackProvider).fallback?.args[1], "qwen3-coder:30b");
});

test("createAgentProviders requires OPENAI_API_KEY when OpenAI is primary", () => {
  assert.throws(
    () =>
      createAgentProviders(
        createConfig({
          primaryModelProvider: "openai",
          openAiApiKey: undefined
        }),
        createNoopLogger(),
        {
          FallbackProvider: StubFallbackProvider as never,
          OllamaProvider: StubProvider as never,
          OpenAiProvider: StubProvider as never
        }
      ),
    /PRIMARY_MODEL_PROVIDER=openai requires OPENAI_API_KEY/
  );
});
