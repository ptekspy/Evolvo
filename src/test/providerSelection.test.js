import test from "node:test";
import assert from "node:assert/strict";
import { createAgentProviders } from "../providerSelection.js";
import { createNoopLogger } from "../logger.js";

class StubProvider {
  constructor(...args) {
    this.args = args;
  }

  async complete() {
    return "ok";
  }
}

class StubFallbackProvider {
  constructor(primary, fallback, logger) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }
}

function createConfig(overrides = {}) {
  return {
    primaryModelProvider: "ollama",
    openAiApiKey: "key",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen3-coder:30b",
    openAiModel: "gpt-5.3-codex",
    ...overrides
  };
}

test("createAgentProviders uses Ollama as primary by default and OpenAI as fallback", () => {
  const providers = createAgentProviders(
    createConfig(),
    createNoopLogger(),
    {
      FallbackProvider: StubFallbackProvider,
      OllamaProvider: StubProvider,
      OpenAiProvider: StubProvider
    }
  );

  assert.equal(providers.primaryProviderName, "ollama");
  assert.equal(providers.fallbackProviderName, "openai");
  assert.equal(providers.planner.primary.args[1], "qwen3-coder:30b");
  assert.equal(providers.planner.fallback.args[1], "gpt-5.3-codex");
});

test("createAgentProviders can use OpenAI as primary and Ollama as fallback", () => {
  const providers = createAgentProviders(
    createConfig({
      primaryModelProvider: "openai"
    }),
    createNoopLogger(),
    {
      FallbackProvider: StubFallbackProvider,
      OllamaProvider: StubProvider,
      OpenAiProvider: StubProvider
    }
  );

  assert.equal(providers.primaryProviderName, "openai");
  assert.equal(providers.fallbackProviderName, "ollama");
  assert.equal(providers.planner.primary.args[1], "gpt-5.3-codex");
  assert.equal(providers.planner.fallback.args[1], "qwen3-coder:30b");
});

test("createAgentProviders requires OPENAI_API_KEY when OpenAI is primary", () => {
  assert.throws(() => createAgentProviders(
    createConfig({
      primaryModelProvider: "openai",
      openAiApiKey: ""
    }),
    createNoopLogger(),
    {
      FallbackProvider: StubFallbackProvider,
      OllamaProvider: StubProvider,
      OpenAiProvider: StubProvider
    }
  ), /PRIMARY_MODEL_PROVIDER=openai requires OPENAI_API_KEY/);
});
