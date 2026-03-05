import { createNoopLogger } from "../logger.js";

export class OpenAiProvider {
  constructor(apiKey, model = "gpt-5.3-codex", logger = createNoopLogger()) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async complete(prompt) {
    const startedAt = Date.now();
    this.logger.debug("Calling OpenAI Responses API", {
      model: this.model,
      promptLength: prompt.length
    });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: prompt
      })
    });

    if (!response.ok) {
      this.logger.error("OpenAI request failed", {
        model: this.model,
        status: response.status
      });
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();
    const output = json.output_text ?? "";
    this.logger.debug("OpenAI response received", {
      model: this.model,
      durationMs: Date.now() - startedAt,
      outputLength: output.length
    });
    return output;
  }
}
