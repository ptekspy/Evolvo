import { createNoopLogger } from "../logger.js";
import type { LoggerLike } from "../types.js";

interface OpenAiOutputContentItem {
  type?: string;
  text?: string;
}

interface OpenAiOutputItem {
  content?: OpenAiOutputContentItem[];
}

interface OpenAiResponsePayload {
  output_text?: string;
  output?: OpenAiOutputItem[];
}

export function extractOutputText(payload: OpenAiResponsePayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string" && content.text.length > 0) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

export class OpenAiProvider {
  readonly apiKey: string;
  readonly model: string;
  readonly logger: LoggerLike;

  constructor(apiKey: string, model = "gpt-5.3-codex", logger: LoggerLike = createNoopLogger()) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async complete(prompt: string): Promise<string> {
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

    const json = (await response.json()) as OpenAiResponsePayload;
    const output = extractOutputText(json);
    if (!output) {
      this.logger.error("OpenAI response did not contain text output", {
        model: this.model,
        outputItems: Array.isArray(json.output) ? json.output.length : 0
      });
      throw new Error("OpenAI response did not contain any text output.");
    }

    this.logger.debug("OpenAI response received", {
      model: this.model,
      durationMs: Date.now() - startedAt,
      outputLength: output.length
    });
    return output;
  }
}
