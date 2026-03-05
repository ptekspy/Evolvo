import { createNoopLogger } from "./logger.js";
import { FallbackProvider } from "./providers/fallback.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAiProvider } from "./providers/openai.js";

function fallbackNameFor(primaryProviderName, hasOpenAiFallback) {
  if (primaryProviderName === "openai") {
    return "ollama";
  }

  return hasOpenAiFallback ? "openai" : null;
}

export function createAgentProviders(config, logger = createNoopLogger(), dependencies = {}) {
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
  const fallbackProvider = config.primaryModelProvider === "openai"
    ? ollama
    : openAi;

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
