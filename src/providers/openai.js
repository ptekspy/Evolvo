export class OpenAiProvider {
  constructor(apiKey, model = "gpt-5.3-codex") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt) {
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
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();
    return json.output_text ?? "";
  }
}
