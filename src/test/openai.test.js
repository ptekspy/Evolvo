import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiProvider, extractOutputText } from "../providers/openai.js";

test("extractOutputText reads structured Responses API content when output_text is absent", () => {
  const output = extractOutputText({
    output_text: null,
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{\"ok\":true}"
          }
        ]
      }
    ]
  });

  assert.equal(output, "{\"ok\":true}");
});

test("OpenAiProvider returns text from structured Responses API output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output_text: null,
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "{\"action\":\"finish\",\"summary\":\"done\"}"
            }
          ]
        }
      ]
    })
  });

  try {
    const provider = new OpenAiProvider("token", "gpt-5.3-codex");
    const result = await provider.complete("prompt");
    assert.equal(result, "{\"action\":\"finish\",\"summary\":\"done\"}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
