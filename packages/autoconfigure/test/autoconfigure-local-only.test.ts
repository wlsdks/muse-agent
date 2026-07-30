import { LocalOnlyViolationError, OllamaProvider, OpenAICompatibleProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { createModelProvider, resolveModelProvider } from "../src/autoconfigure-model-provider.js";

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
    // The local-only fix: without an explicit MUSE_MODEL, a stray
    // GEMINI_API_KEY/OPENAI_API_KEY in the environment must NOT make the
    // default a cloud model (which would then be refused, breaking zero-config).
    // It resolves to the local Ollama model and builds a local provider.
    for (const env of [
      { GEMINI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" },
      { OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" }
    ]) {
      expect(resolveModelProvider(env)?.provider, JSON.stringify(env)).toBeInstanceOf(OllamaProvider);
    }
  });

  it("allows local Ollama under local-only", () => {
    const resolution = resolveModelProvider({ MUSE_MODEL: "ollama/llama3.2", MUSE_LOCAL_ONLY: "true" });
    expect(resolution).toMatchObject({ locality: "local" });
    expect(resolution?.provider).toBeInstanceOf(OllamaProvider);
  });

  it("allows a localhost OpenAI-compatible endpoint under local-only", () => {
    const resolution = resolveModelProvider({
      MUSE_MODEL: "local/qwen3:8b",
      MUSE_MODEL_BASE_URL: "http://localhost:8000/v1",
      MUSE_LOCAL_ONLY: "true"
    });
    expect(resolution).toMatchObject({ locality: "local" });
    expect(resolution?.provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("passes numeric loopback endpoints to the actual Ollama and OpenAI-compatible transports under local-only", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      if (String(input).includes("/api/chat")) {
        return new Response(JSON.stringify({ message: { content: "ok" }, model: "ollama/test" }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], id: "c1", model: "local/test" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const ollama = createModelProvider({
        MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED: "false",
        MUSE_LOCAL_ONLY: "true",
        MUSE_MODEL: "ollama/test"
      });
      await ollama?.generate({ messages: [{ content: "hello", role: "user" }], model: "ollama/test" });
      const compatible = createModelProvider({
        MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED: "false",
        MUSE_LOCAL_ONLY: "true",
        MUSE_MODEL: "local/test",
        MUSE_MODEL_BASE_URL: "http://localhost:18000/v1"
      });
      await compatible?.generate({ messages: [{ content: "hello", role: "user" }], model: "local/test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toEqual([
      "http://127.0.0.1:11434/api/chat",
      "http://127.0.0.1:18000/v1/chat/completions"
    ]);
  });

  it("refuses invalid local-only bases before provider construction or transport fetch, and never invents a generic endpoint", () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("must not fetch", { status: 500 });
    }) as typeof globalThis.fetch;
    try {
      expect(createModelProvider({
        MUSE_LOCAL_ONLY: "true",
        MUSE_MODEL: "lmstudio/test",
        MUSE_MODEL_PROVIDER_ID: "lmstudio"
      })).toBeUndefined();
      for (const baseUrl of [
        "http://0.0.0.0:11434/v1",
        "http://foo.localhost:11434/v1",
        "http://user:pass@localhost:11434/v1",
        "https://localhost:11434/v1",
        "http://192.168.1.50:11434/v1",
        "not a URL"
      ]) {
        expect(() => createModelProvider({
          MUSE_LOCAL_ONLY: "true",
          MUSE_MODEL: "ollama/test",
          OLLAMA_BASE_URL: baseUrl
        }), baseUrl).toThrow(LocalOnlyViolationError);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  it("does not rewrite an explicit localhost base when local-only is off", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], id: "c1", model: "local/test" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const provider = createModelProvider({
        MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED: "false",
        MUSE_LOCAL_ONLY: "false",
        MUSE_MODEL: "local/test",
        MUSE_MODEL_BASE_URL: "http://localhost:18000/v1"
      });
      await provider?.generate({ messages: [{ content: "hello", role: "user" }], model: "local/test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toEqual(["http://localhost:18000/v1/chat/completions"]);
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
