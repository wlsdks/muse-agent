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

// MUSE_MODEL_EXTRA_HEADERS (DS-22): the self-hosted LAN LLM gateway (LiteLLM, a
// reverse proxy, Cloudflare-Access service-token auth) needs a header beyond the
// standard `Authorization: Bearer <apiKey>`. These pin the FULL path from the env
// var down to the actual fetch call for the custom OpenAI-compatible endpoint —
// the real-world local-first scenario this closes.
describe("createModelProvider — MUSE_MODEL_EXTRA_HEADERS (LAN gateway auth header)", () => {
  async function generateAndCaptureHeaders(env: Record<string, string | undefined>): Promise<Record<string, string> | undefined> {
    const originalFetch = globalThis.fetch;
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], id: "c1", model: "m" }));
    }) as typeof fetch;
    try {
      const provider = createModelProvider(env as never);
      await provider?.generate({ messages: [{ content: "hi", role: "user" }], model: "m" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return seenHeaders;
  }

  it("a well-formed MUSE_MODEL_EXTRA_HEADERS reaches the actual fetch call for a custom OpenAI-compatible endpoint", async () => {
    const headers = await generateAndCaptureHeaders({
      MUSE_MODEL: "openai-compatible/local-model",
      MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1",
      MUSE_MODEL_EXTRA_HEADERS: '{"X-Gateway-Token":"secret-token-abc"}'
    });
    expect(headers?.["X-Gateway-Token"]).toBe("secret-token-abc");
  });

  it("flows into every OpenAI-compat-wire provider family, not just the custom-endpoint fallback (openai/Responses API here)", async () => {
    // NOTE: this deliberately does NOT cover OllamaProvider — its generate()/
    // stream() override the OpenAI-compat base to hit Ollama's own native
    // /api/chat endpoint (adapter-ollama.ts), which never merges `this.headers`
    // at all (a separate, pre-existing gap outside this change's file scope).
    const headers = await generateAndCaptureHeaders({
      MUSE_LOCAL_ONLY: "false",
      MUSE_MODEL: "openai/gpt-4o-mini",
      MUSE_MODEL_EXTRA_HEADERS: '{"X-Gateway-Token":"secret-token-abc"}',
      OPENAI_API_KEY: "sk-test"
    });
    expect(headers?.["X-Gateway-Token"]).toBe("secret-token-abc");
  });

  it("a malformed MUSE_MODEL_EXTRA_HEADERS fails SOFT — no throw, provider still built, just no extra header", async () => {
    let threw = false;
    let headers: Record<string, string> | undefined;
    try {
      headers = await generateAndCaptureHeaders({
        MUSE_MODEL: "openai-compatible/local-model",
        MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1",
        MUSE_MODEL_EXTRA_HEADERS: "not valid json"
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(headers?.["content-type"]).toBe("application/json");
    expect(Object.keys(headers ?? {})).not.toContain("X-Gateway-Token");
  });

  it("an absent MUSE_MODEL_EXTRA_HEADERS builds the provider exactly as before (no behavior change)", async () => {
    const headers = await generateAndCaptureHeaders({
      MUSE_MODEL: "openai-compatible/local-model",
      MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1"
    });
    expect(headers).toEqual({ "content-type": "application/json" });
  });
});
