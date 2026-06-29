import { describe, expect, it } from "vitest";

import { createModelProvider } from "./autoconfigure-model-provider.js";

// Gate the BYO-cloud path (muse setup cloud): once MUSE_LOCAL_ONLY=false + a key is set, the
// router MUST build the matching cloud provider; with local-only on (the default), a cloud
// model MUST fail-close. This keeps the cloud capability + the privacy floor from silently rotting.
describe("createModelProvider — cloud BYO-key routing + local-only fail-close", () => {
  it("MUSE_LOCAL_ONLY=false + ANTHROPIC_API_KEY → an anthropic provider", () => {
    const p = createModelProvider({ ANTHROPIC_API_KEY: "k", MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001" } as never);
    expect(p?.id).toBe("anthropic");
  });
  it("MUSE_LOCAL_ONLY=false + GEMINI_API_KEY → a gemini provider", () => {
    const p = createModelProvider({ GEMINI_API_KEY: "k", MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "gemini/gemini-2.0-flash" } as never);
    expect(p?.id).toBe("gemini");
  });
  it("local-only ON (the default) + a cloud model → throws LocalOnlyViolationError (fail-close)", () => {
    expect(() => createModelProvider({ ANTHROPIC_API_KEY: "k", MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001" } as never))
      .toThrowError(/LocalOnly|local-only|local only/i);
  });
  it("a local Ollama model needs no key and no opt-out", () => {
    const p = createModelProvider({ MUSE_MODEL: "ollama/gemma4:12b" } as never);
    expect(p?.id).toBe("ollama");
  });
});
