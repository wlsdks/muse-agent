import { describe, expect, it } from "vitest";

import { resolveDefaultModel } from "@muse/autoconfigure";

import { SETUP_MODEL_PROVIDER_SPECS } from "./setup-model.js";

describe("SETUP_MODEL_PROVIDER_SPECS", () => {
  it("covers the same provider ids autoconfigure recognises", () => {
    const ids = SETUP_MODEL_PROVIDER_SPECS.map((spec) => spec.id).sort();
    expect(ids).toEqual([
      "anthropic",
      "cerebras",
      "deepseek",
      "gemini",
      "groq",
      "mistral",
      "moonshot",
      "ollama",
      "openai",
      "openrouter",
      "together"
    ]);
  });

  it("maps each provider to the exact env key the autoconfigure layer probes", () => {
    const byId: Record<string, string> = {};
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      byId[spec.id] = spec.envKey;
    }
    expect(byId).toEqual({
      anthropic: "ANTHROPIC_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      gemini: "GEMINI_API_KEY",
      groq: "GROQ_API_KEY",
      mistral: "MISTRAL_API_KEY",
      moonshot: "MOONSHOT_API_KEY",
      ollama: "OLLAMA_BASE_URL",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      together: "TOGETHER_API_KEY"
    });
  });

  it("every spec has a non-empty docs URL and suggested model spec", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      expect(spec.docs).toMatch(/^https?:\/\//);
      expect(spec.suggestedModel).toMatch(/\//);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it("placeholderHint is descriptive (not just '...') so wizard prompts guide the user", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      const trimmed = spec.placeholderHint.replace(/\./g, "").trim();
      expect(trimmed.length, `${spec.id} placeholderHint is too uninformative: ${JSON.stringify(spec.placeholderHint)}`).toBeGreaterThan(0);
    }
  });

  it("ollama is the only non-secret entry (env carries a base URL, not a token)", () => {
    const nonSecret = SETUP_MODEL_PROVIDER_SPECS.filter((spec) => !spec.secret).map((spec) => spec.id);
    expect(nonSecret).toEqual(["ollama"]);
  });

  it("every spec.suggestedModel matches what resolveDefaultModel picks when only that provider's env key is set", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      // Cloud-credential inference is gated behind the local-only opt-out;
      // local-first ignores ambient cloud keys by default.
      const env: Record<string, string> = { MUSE_LOCAL_ONLY: "false", [spec.envKey]: "test-token" };
      const inferred = resolveDefaultModel(env);
      expect(inferred, `${spec.id} default-model contract drift`).toBe(spec.suggestedModel);
    }
  });
});
