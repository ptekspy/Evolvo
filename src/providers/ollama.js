import { createNoopLogger } from "../logger.js";

export class OllamaProvider {
  constructor(baseUrl, model = "qwen-coder-3:30b", logger = createNoopLogger()) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.logger = logger;
  }

  async complete(prompt) {
    const startedAt = Date.now();
    this.logger.debug("Calling Ollama", {
      model: this.model,
      promptLength: prompt.length
    });
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false
      })
    });

    if (!response.ok) {
      this.logger.error("Ollama request failed", {
        model: this.model,
        status: response.status
      });
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();
    const output = json.response ?? "";
    this.logger.debug("Ollama response received", {
      model: this.model,
      durationMs: Date.now() - startedAt,
      outputLength: output.length
    });
    return output;
  }
}
