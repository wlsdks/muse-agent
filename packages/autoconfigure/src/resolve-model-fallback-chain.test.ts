import { describe, expect, it } from "vitest";

import { classifyProviderLocality } from "@muse/model";

import { resolveModelFallbackChain } from "./autoconfigure-model-provider.js";

describe("classifyProviderLocality — sanity for the fallback-chain gate", () => {
  it("classifies ollama as local and gemini as cloud", () => {
    expect(classifyProviderLocality("ollama", undefined)).toBe("local");
    expect(classifyProviderLocality("gemini", undefined)).toBe("cloud");
  });
});

describe("resolveModelFallbackChain — unset is byte-identical to no-fallback", () => {
  it("returns an empty chain when MUSE_MODEL_FALLBACKS is absent", () => {
    const result = resolveModelFallbackChain({ env: {} as never });
    expect(result).toEqual({ chain: [], dropped: [] });
  });

  it("returns an empty chain for an empty string", () => {
    const result = resolveModelFallbackChain({ env: { MUSE_MODEL_FALLBACKS: "" } as never });
    expect(result).toEqual({ chain: [], dropped: [] });
  });

  it("returns an empty chain for a whitespace-only string", () => {
    const result = resolveModelFallbackChain({ env: { MUSE_MODEL_FALLBACKS: "   " } as never });
    expect(result).toEqual({ chain: [], dropped: [] });
  });
});

describe("resolveModelFallbackChain — chain walk, order preserved", () => {
  it("splits a comma-separated list of local models in order", () => {
    const result = resolveModelFallbackChain({
      env: { MUSE_MODEL_FALLBACKS: "ollama/a,ollama/b,ollama/c" } as never
    });
    expect(result.chain).toEqual(["ollama/a", "ollama/b", "ollama/c"]);
    expect(result.dropped).toEqual([]);
  });

  it("trims whitespace and drops empty entries (stray/trailing commas)", () => {
    const result = resolveModelFallbackChain({
      env: { MUSE_MODEL_FALLBACKS: "ollama/a , , ollama/b," } as never
    });
    expect(result.chain).toEqual(["ollama/a", "ollama/b"]);
    expect(result.dropped).toEqual([]);
  });
});

describe("resolveModelFallbackChain — MUSE_LOCAL_ONLY gate", () => {
  it("drops a cloud fallback and keeps local ones when MUSE_LOCAL_ONLY is set", () => {
    const result = resolveModelFallbackChain({
      env: {
        MUSE_LOCAL_ONLY: "true",
        MUSE_MODEL_FALLBACKS: "ollama/local,gemini/gemini-2.0-flash"
      } as never
    });
    expect(result.chain).toEqual(["ollama/local"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.model).toBe("gemini/gemini-2.0-flash");
    expect(result.dropped[0]?.reason).toMatch(/LOCAL_ONLY/);
  });
});

describe("resolveModelFallbackChain — personal-context privacy gate", () => {
  it("drops a cloud fallback when the caller marks the request personal-context", () => {
    const result = resolveModelFallbackChain({
      env: { MUSE_MODEL_FALLBACKS: "ollama/local,gemini/gemini-2.0-flash" } as never,
      isPersonalContext: true
    });
    expect(result.chain).toEqual(["ollama/local"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.model).toBe("gemini/gemini-2.0-flash");
    expect(result.dropped[0]?.reason).toMatch(/personal/);
  });

  it("keeps a cloud fallback in the chain when neither gate applies", () => {
    const result = resolveModelFallbackChain({
      env: { MUSE_MODEL_FALLBACKS: "ollama/local,gemini/gemini-2.0-flash" } as never,
      isPersonalContext: false
    });
    expect(result.chain).toEqual(["ollama/local", "gemini/gemini-2.0-flash"]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps a cloud fallback in the chain when isPersonalContext is omitted", () => {
    const result = resolveModelFallbackChain({
      env: { MUSE_MODEL_FALLBACKS: "ollama/local,gemini/gemini-2.0-flash" } as never
    });
    expect(result.chain).toEqual(["ollama/local", "gemini/gemini-2.0-flash"]);
    expect(result.dropped).toEqual([]);
  });
});
