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
      { OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { GEMINI_API_KEY: "k" } // local-only defaults ON
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

  it("local-only is the DEFAULT — an unset MUSE_LOCAL_ONLY still blocks a cloud provider", () => {
    // Muse is local-by-construction: the zero-egress guarantee is the default,
    // not a setting you must find. A cloud provider is refused unless opted out.
    expect(() => createModelProvider({ GEMINI_API_KEY: "k", MUSE_MODEL: "gemini/gemini-2.0-flash", MUSE_MODEL_PROVIDER_ID: "gemini" }))
      .toThrow(LocalOnlyViolationError);
  });

  it("MUSE_LOCAL_ONLY=false is the explicit opt-out — cloud then builds (forfeiting the guarantee)", () => {
    const provider = createModelProvider({ GEMINI_API_KEY: "k", MUSE_MODEL: "gemini/gemini-2.0-flash", MUSE_MODEL_PROVIDER_ID: "gemini", MUSE_LOCAL_ONLY: "false" });
    expect(provider?.id).toBe("gemini");
  });
});
