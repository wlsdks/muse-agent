import { describe, expect, it } from "vitest";

import { classifyProviderLocality, isLoopbackUrl, LocalOnlyViolationError } from "../src/local-only-policy.js";

describe("isLoopbackUrl — the no-egress host check (a false 'loopback' would leak traffic off-box under local-only)", () => {
  const LOOPBACK: readonly (string | undefined)[] = [
    "localhost",
    "localhost:11434",
    "http://localhost:11434",
    "https://localhost",
    "127.0.0.1",
    "127.0.0.1:11434",
    "http://127.0.0.1",
    "127.5.6.7",
    "127.255.255.255",
    "http://[::1]:11434",
    "0.0.0.0",
    "foo.localhost",
    "http://foo.localhost:3000",
    "LOCALHOST",
    "HTTP://LOCALHOST"
  ];
  it.each(LOOPBACK)("treats %j as loopback (local)", (value) => {
    expect(isLoopbackUrl(value)).toBe(true);
  });

  const REMOTE: readonly (string | undefined)[] = [
    undefined,
    "",
    "   ",
    "example.com",
    "http://example.com",
    "https://api.openai.com",
    "192.168.1.1",
    "10.0.0.1",
    "8.8.8.8",
    "126.0.0.1",
    "128.0.0.1",
    // Adversarial: a hostname that merely CONTAINS a loopback token but is a
    // real off-box domain must NOT be classified loopback.
    "localhost.evil.com",
    "127.0.0.1.evil.com",
    "notlocalhost",
    // Unparseable / no host → fail closed (treated as remote).
    "http://",
    "ht!tp://[",
    "not a url at all with spaces"
  ];
  it.each(REMOTE)("treats %j as remote (off-box)", (value) => {
    expect(isLoopbackUrl(value)).toBe(false);
  });

  it("recognises bracketed IPv6 loopback but NOT a bare ::1 (URL parsing needs the brackets) — fail-closed either way", () => {
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
    expect(isLoopbackUrl("::1")).toBe(false);
  });
});

describe("classifyProviderLocality — cloud vs local routing decision", () => {
  it("classifies cloud-id providers as cloud REGARDLESS of base URL (even a loopback one)", () => {
    for (const id of ["openai", "anthropic", "gemini", "openrouter"]) {
      expect(classifyProviderLocality(id, "http://localhost:11434")).toBe("cloud");
      expect(classifyProviderLocality(id, undefined)).toBe("cloud");
    }
  });

  it("normalises the provider id (trim + lowercase) before matching", () => {
    expect(classifyProviderLocality("OpenAI", undefined)).toBe("cloud");
    expect(classifyProviderLocality("  openai  ", undefined)).toBe("cloud");
  });

  describe("local-inference ids (ollama / lmstudio / diagnostic)", () => {
    for (const id of ["ollama", "lmstudio", "diagnostic"]) {
      it(`${id}: local when base URL is undefined (built-in localhost default)`, () => {
        expect(classifyProviderLocality(id, undefined)).toBe("local");
      });
      it(`${id}: local when pointed at a loopback host`, () => {
        expect(classifyProviderLocality(id, "http://localhost:11434")).toBe("local");
      });
      it(`${id}: CLOUD when pointed at a remote host (a remote local-inference server is still egress)`, () => {
        expect(classifyProviderLocality(id, "http://192.168.1.5:11434")).toBe("cloud");
      });
    }
  });

  describe("unknown / openai-compatible ids", () => {
    it("is local only when the base URL is a loopback host", () => {
      expect(classifyProviderLocality("openai-compatible", "http://localhost:1234")).toBe("local");
      expect(classifyProviderLocality("custom-unknown", "http://127.0.0.1:8080")).toBe("local");
    });
    it("is cloud when pointed at a remote host", () => {
      expect(classifyProviderLocality("openai-compatible", "https://remote.example.com")).toBe("cloud");
    });
    it("is cloud when the base URL is undefined (no localhost default to assume)", () => {
      expect(classifyProviderLocality("openai-compatible", undefined)).toBe("cloud");
    });
  });
});

describe("LocalOnlyViolationError — the loud fail-close thrown when local-only would reach the cloud", () => {
  it("carries a stable code, name, and the offending provider/baseUrl", () => {
    const err = new LocalOnlyViolationError("openai", "https://api.openai.com");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("LOCAL_ONLY_VIOLATION");
    expect(err.name).toBe("LocalOnlyViolationError");
    expect(err.providerId).toBe("openai");
    expect(err.baseUrl).toBe("https://api.openai.com");
  });

  it("names the provider and the base URL (in parens) in the message", () => {
    const err = new LocalOnlyViolationError("openai", "https://api.openai.com");
    expect(err.message).toContain("'openai'");
    expect(err.message).toContain("(https://api.openai.com)");
    expect(err.message).toContain("MUSE_LOCAL_ONLY");
  });

  it("omits the base-URL parenthetical when no base URL is supplied", () => {
    const err = new LocalOnlyViolationError("anthropic");
    expect(err.baseUrl).toBeUndefined();
    expect(err.message).toContain("'anthropic'.");
    expect(err.message).not.toMatch(/'anthropic' \(/u);
  });
});
