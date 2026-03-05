import test from "node:test";
import assert from "node:assert/strict";
import { MASTER_PROMPT, composePrompt } from "../masterPrompt.js";

test("MASTER_PROMPT encodes TypeScript-only and perseverance policy", () => {
  assert.match(MASTER_PROMPT, /TypeScript-only/);
  assert.match(MASTER_PROMPT, /Prefer local Ollama first/);
  assert.match(MASTER_PROMPT, /OpenAI only when truly stuck or lost/);
});

test("composePrompt wraps task under master prompt", () => {
  const result = composePrompt("Solve issue #1");
  assert.match(result, /--- TASK ---/);
  assert.match(result, /Solve issue #1/);
});
