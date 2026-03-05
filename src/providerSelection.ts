import { createNoopLogger } from "./logger.js";
import type { AppConfig } from "./config.js";
import type { LoggerLike } from "./types.js";
import { FallbackProvider } from "./providers/fallback.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAiProvider } from "./providers/openai.js";

interface ModelProvider {
  complete(prompt: string): Promise<string>;
}

function fallbackNameFor(primaryProviderName: "ollama" | "openai", hasOpenAiFallback: boolean): "ollama" | "openai" | null {
  if (primaryProviderName === "openai") {
    return "ollama";
  }

  return hasOpenAiFallback ? "openai" : null;
}

interface ProviderDependencies {
  FallbackProvider?: typeof FallbackProvider;
  OllamaProvider?: typeof OllamaProvider;
  OpenAiProvider?: typeof OpenAiProvider;
}

export function createAgentProviders(
  config: AppConfig,
  logger: LoggerLike = createNoopLogger(),
  dependencies: ProviderDependencies = {}
): {
  primaryProviderName: "ollama" | "openai";
  fallbackProviderName: "ollama" | "openai" | null;
  planner: ModelProvider;
  reviewer: ModelProvider;
} {
  const ProviderFallback = dependencies.FallbackProvider ?? FallbackProvider;
  const ProviderOllama = dependencies.OllamaProvider ?? OllamaProvider;
  const ProviderOpenAi = dependencies.OpenAiProvider ?? OpenAiProvider;

  const ollama = new ProviderOllama(config.ollamaBaseUrl, config.ollamaModel, logger.child("provider.ollama"));
  const openAi = config.openAiApiKey
    ? new ProviderOpenAi(config.openAiApiKey, config.openAiModel, logger.child("provider.openai"))
    : null;

  if (config.primaryModelProvider === "openai" && !openAi) {
    throw new Error("PRIMARY_MODEL_PROVIDER=openai requires OPENAI_API_KEY to be set.");
  }

  const primaryProvider = config.primaryModelProvider === "openai" ? openAi : ollama;
  const fallbackProvider = config.primaryModelProvider === "openai" ? ollama : openAi;

  if (!primaryProvider) {
    throw new Error("Primary provider was not initialized.");
  }

  logger.info("Selected model providers", {
    primaryProvider: config.primaryModelProvider,
    fallbackProvider: fallbackNameFor(config.primaryModelProvider, Boolean(openAi))
  });

  return {
    primaryProviderName: config.primaryModelProvider,
    fallbackProviderName: fallbackNameFor(config.primaryModelProvider, Boolean(openAi)),
    planner: new ProviderFallback(primaryProvider, fallbackProvider, logger.child("planner")),
    reviewer: new ProviderFallback(primaryProvider, fallbackProvider, logger.child("reviewer"))
  };
}
