import { LocalOnlyViolationError, OllamaProvider, OpenAICompatibleProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { createModelProvider } from "../src/autoconfigure-model-provider.js";

describe("createModelProvider — MUSE_LOCAL_ONLY fail-close", () => {
  it("blocks an EXPLICIT cloud model loud and clear under local-only", () => {
    for (const env of [
      { MUSE_MODEL: "gemini/gemini-2.0-flash", GEMINI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { MUSE_MODEL: "openai/gpt-4o-mini", OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001", ANTHROPIC_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { MUSE_MODEL: "groq/llama-3.1-70b", MUSE_MODEL_PROVIDER_ID: "groq", GROQ_API_KEY: "k", MUSE_LOCAL_ONLY: "true" }
    ]) {
      expect(() => createModelProvider(env), JSON.stringify(env)).toThrow(LocalOnlyViolationError);
    }
  });

  it("an AMBIENT cloud key never leaks under local-only — the default resolves LOCAL, not cloud", () => {
    // The local-first fix: without an explicit MUSE_MODEL, a stray
    // GEMINI_API_KEY/OPENAI_API_KEY in the environment must NOT make the
    // default a cloud model (which would then be refused, breaking zero-config).
    // It resolves to the local Ollama model and builds a local provider.
    for (const env of [
      { GEMINI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" }
    ]) {
      expect(createModelProvider(env), JSON.stringify(env)).toBeInstanceOf(OllamaProvider);
    }
  });

  it("allows local Ollama under local-only", () => {
    const provider = createModelProvider({ MUSE_MODEL: "ollama/llama3.2", MUSE_LOCAL_ONLY: "true" });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("allows a localhost OpenAI-compatible endpoint under local-only", () => {
    const provider = createModelProvider({
      MUSE_MODEL: "local/qwen3:8b",
      MUSE_MODEL_BASE_URL: "http://localhost:8000/v1",
      MUSE_LOCAL_ONLY: "true"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("blocks a REMOTE Ollama host under local-only (off-box egress)", () => {
    expect(() => createModelProvider({
      MUSE_MODEL: "ollama/llama3.2",
      OLLAMA_BASE_URL: "http://192.168.1.50:11434",
      MUSE_LOCAL_ONLY: "true"
    })).toThrow(LocalOnlyViolationError);
  });

  it("cloud is allowed by DEFAULT — an unset MUSE_LOCAL_ONLY builds a cloud provider", () => {
    // Cloud is the default posture now (local-only is opt-in). A cloud model with
    // its key builds its provider without needing any flag.
    const provider = createModelProvider({ GEMINI_API_KEY: "k", MUSE_MODEL: "gemini/gemini-2.0-flash", MUSE_MODEL_PROVIDER_ID: "gemini" });
    expect(provider?.id).toBe("gemini");
  });

  it("MUSE_LOCAL_ONLY=true is the opt-in guarantee — the same cloud provider is then refused", () => {
    expect(() => createModelProvider({ GEMINI_API_KEY: "k", MUSE_MODEL: "gemini/gemini-2.0-flash", MUSE_MODEL_PROVIDER_ID: "gemini", MUSE_LOCAL_ONLY: "true" }))
      .toThrow(LocalOnlyViolationError);
  });
});
