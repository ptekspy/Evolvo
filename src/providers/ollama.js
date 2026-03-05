export class OllamaProvider {
  constructor(baseUrl, model = "qwen-coder-3:30b") {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async complete(prompt) {
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
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();
    return json.response ?? "";
  }
}
