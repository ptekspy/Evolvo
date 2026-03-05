import test from "node:test";
import assert from "node:assert/strict";
import { FallbackProvider } from "../providers/fallback.js";

test("FallbackProvider uses fallback when primary fails", async () => {
  const primary = { complete: async () => { throw new Error("down"); } };
  const fallback = { complete: async () => "ok" };
  const provider = new FallbackProvider(primary, fallback);
  const result = await provider.complete("hello");
  assert.equal(result, "ok");
});
