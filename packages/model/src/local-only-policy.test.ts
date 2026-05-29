import { describe, expect, it } from "vitest";

import { classifyProviderLocality, isLoopbackUrl, LocalOnlyViolationError } from "./local-only-policy.js";

describe("isLoopbackUrl", () => {
  it("treats localhost / 127.x / ::1 / 0.0.0.0 / .localhost as loopback", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:11434/v1",
      "http://127.5.0.1:8000",
      "http://[::1]:1234",
      "http://0.0.0.0:8080",
      "http://api.localhost/v1",
      "localhost:11434",
      "127.0.0.1"
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
  });

  it("treats off-box hosts and junk as NOT loopback", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "http://192.168.1.10:11434",
      "http://10.0.0.5:8000",
      "https://generativelanguage.googleapis.com",
      "http://localhost.evil.com",
      undefined,
      "",
      "   "
    ]) {
      expect(isLoopbackUrl(url), String(url)).toBe(false);
    }
  });
});

describe("classifyProviderLocality", () => {
  it("cloud-id providers are cloud regardless of base URL", () => {
    for (const id of ["openai", "anthropic", "gemini", "openrouter", "OpenAI"]) {
      expect(classifyProviderLocality(id, undefined), id).toBe("cloud");
      expect(classifyProviderLocality(id, "http://localhost:1234"), id).toBe("cloud");
    }
  });

  it("ollama/lmstudio/diagnostic are local by default and with a loopback host", () => {
    expect(classifyProviderLocality("ollama", undefined)).toBe("local");
    expect(classifyProviderLocality("ollama", "http://127.0.0.1:11434/v1")).toBe("local");
    expect(classifyProviderLocality("lmstudio", "http://localhost:1234/v1")).toBe("local");
    expect(classifyProviderLocality("diagnostic", undefined)).toBe("local");
  });

  it("a REMOTE ollama/lmstudio host is off-box egress ⇒ cloud", () => {
    expect(classifyProviderLocality("ollama", "http://192.168.1.5:11434/v1")).toBe("cloud");
    expect(classifyProviderLocality("lmstudio", "https://my-gpu-box.example.com/v1")).toBe("cloud");
  });

  it("openai-compatible / unknown is local only when pointed at loopback", () => {
    expect(classifyProviderLocality("openai-compatible", "http://localhost:8000/v1")).toBe("local");
    expect(classifyProviderLocality("openai-compatible", "https://api.groq.com/openai/v1")).toBe("cloud");
    expect(classifyProviderLocality("groq", "https://api.groq.com/openai/v1")).toBe("cloud");
    expect(classifyProviderLocality("openai-compatible", undefined)).toBe("cloud");
  });
});

describe("LocalOnlyViolationError", () => {
  it("carries a stable code + the offending provider and a fix hint", () => {
    const err = new LocalOnlyViolationError("gemini", "https://generativelanguage.googleapis.com");
    expect(err.code).toBe("LOCAL_ONLY_VIOLATION");
    expect(err.providerId).toBe("gemini");
    expect(err.baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(err.message).toContain("MUSE_LOCAL_ONLY");
    expect(err.message).toContain("gemini");
    expect(err.message).toContain("ollama/qwen3:8b");
    expect(err.message).toContain("local-only by default");
    expect(err).toBeInstanceOf(Error);
  });
});
