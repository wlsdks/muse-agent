import { describe, expect, it } from "vitest";

import { canonicalizeLocalOnlyModelBaseUrl, canonicalizeLocalOnlyRootLoopbackHttpBaseUrl, classifyProviderLocality, isLoopbackUrl, LocalOnlyHttpBaseUrlViolationError, LocalOnlyViolationError } from "./local-only-policy.js";

describe("isLoopbackUrl", () => {
  it("treats localhost / 127.x / ::1 / .localhost as loopback but rejects the wildcard bind address", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:11434/v1",
      "http://127.5.0.1:8000",
      "http://[::1]:1234",
      "http://api.localhost/v1",
      "localhost:11434",
      "127.0.0.1"
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
    expect(isLoopbackUrl("http://0.0.0.0:8080")).toBe(false);
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

describe("canonicalizeLocalOnlyModelBaseUrl", () => {
  it("uses the built-in numeric Ollama endpoint and rewrites only exact http localhost to numeric loopback", () => {
    expect(canonicalizeLocalOnlyModelBaseUrl("ollama", undefined)).toBe("http://127.0.0.1:11434/v1");
    expect(canonicalizeLocalOnlyModelBaseUrl("ollama", "http://localhost:11435/v1")).toBe("http://127.0.0.1:11435/v1");
    expect(canonicalizeLocalOnlyModelBaseUrl("openai-compatible", "http://127.4.5.6:8000/v1")).toBe("http://127.4.5.6:8000/v1");
    expect(canonicalizeLocalOnlyModelBaseUrl("openai-compatible", "http://[::1]:8000/v1")).toBe("http://[::1]:8000/v1");
  });

  it("refuses host aliases, wildcard binds, credentials, TLS localhost, LAN/public addresses, and malformed bases before a transport exists", () => {
    for (const baseUrl of [
      "http://api.localhost:8000/v1",
      "http://0.0.0.0:8000/v1",
      "http://[::]:8000/v1",
      "http://user:pass@localhost:8000/v1",
      "https://localhost:8000/v1",
      "http://192.168.1.10:8000/v1",
      "https://api.example.test/v1",
      "not a URL"
    ]) {
      expect(() => canonicalizeLocalOnlyModelBaseUrl("ollama", baseUrl), baseUrl).toThrow(LocalOnlyViolationError);
    }
  });
});

describe("canonicalizeLocalOnlyRootLoopbackHttpBaseUrl", () => {
  it("canonicalizes only a root loopback HTTP endpoint", () => {
    expect(canonicalizeLocalOnlyRootLoopbackHttpBaseUrl("http://localhost:8123")).toBe("http://127.0.0.1:8123");
    expect(canonicalizeLocalOnlyRootLoopbackHttpBaseUrl("http://127.4.5.6:8123/")).toBe("http://127.4.5.6:8123");
    expect(canonicalizeLocalOnlyRootLoopbackHttpBaseUrl("http://[::1]:8123/")).toBe("http://[::1]:8123");
  });

  it("rejects remote, credential-bearing, query-bearing, and non-root endpoints while model /v1 compatibility remains intact", () => {
    expect(canonicalizeLocalOnlyModelBaseUrl("ollama", "http://localhost:11434/v1")).toBe("http://127.0.0.1:11434/v1");
    for (const baseUrl of [
      "https://localhost:8123",
      "http://user:secret@localhost:8123",
      "http://@localhost:8123",
      "http://localhost:8123/?next=/api",
      "http://localhost:8123/?",
      "http://localhost:8123/#api",
      "http://localhost:8123/#",
      "http://192.168.0.4:8123",
      "http://ha.local:8123",
      "http://127.1:8123",
      "http://2130706433:8123",
      "http://127.00.0.1:8123",
      "http://localhost:8123/api",
      "http://localhost:8123/v1",
      "http://localhost:8123/ha/",
      "http://localhost:8123/./",
      "http://localhost:8123/%2e",
      "http://localhost:8123//",
      "http://localhost:8123/%2f",
      "http://localhost:8123/%252f"
    ]) {
      expect(() => canonicalizeLocalOnlyRootLoopbackHttpBaseUrl(baseUrl), baseUrl).toThrow(LocalOnlyHttpBaseUrlViolationError);
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
    expect(err.message).toContain("local-only model posture");
    expect(err).toBeInstanceOf(Error);
  });
});

// Adversarial / fuzz for the egress boundary (backlog P5 config-fuzz). This is
// the fail-close gate that decides whether traffic may leave the machine under
// local-only, so the load-bearing SECURITY invariant is one-directional: a host
// that is NOT genuinely loopback must NEVER classify as local (a false
// "local" = silent cloud egress the user asked to be protected from). A false
// NEGATIVE (real loopback seen as cloud) is mere over-refusal — fail-closed,
// safe. The classifier keys off URL.hostname, so it must be immune to
// string-appearance tricks (credentials/userinfo/subdomain/path) yet still
// recognise canonicalised loopback (integer/hex IPv4 that resolves to 127.x).
describe("isLoopbackUrl — egress-bypass adversarial corpus", () => {
  // "localhost" / "127.0.0.1" appears in the string but the REAL host is off-box.
  const bypasses = [
    "http://localhost@evil.com",
    "http://127.0.0.1@evil.com",
    "http://localhost:pass@evil.com/v1",
    "http://user@localhost.evil.com",
    "http://evil.com#localhost",
    "http://evil.com/localhost",
    "http://evil.com?h=localhost",
    "http://evil.com:80/127.0.0.1",
    "http://127.0.0.1.evil.com",
    "http://localhost.attacker.net",
    "https://api.openai.com/v1#127.0.0.1",
  ];

  it("never classifies a string-trick non-loopback host as loopback (no silent egress)", () => {
    for (const url of bypasses) {
      expect(isLoopbackUrl(url), url).toBe(false);
      // and the classifier downstream refuses it as cloud
      expect(classifyProviderLocality("openai-compatible", url), url).toBe("cloud");
    }
  });

  it("off-box / LAN / public hosts (incl. integer-IP forms that canonicalise to public) are NOT loopback", () => {
    for (const url of [
      "http://3232235521", // → 192.168.0.1 (LAN — off-box egress per architecture.md)
      "http://0x08080808", // → 8.8.8.8 (public)
      "http://192.168.1.50:11434",
      "http://10.0.0.9:8000",
      "http://172.16.4.4:1234",
      "https://api.groq.com/openai/v1",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });

  it("still RECOGNISES canonicalised loopback (integer/hex/octal IPv4 → 127.x) — not fooled the other way", () => {
    for (const url of ["http://2130706433", "http://0x7f000001", "http://017700000001", "http://2130706434"]) {
      expect(isLoopbackUrl(url), url).toBe(true); // WHATWG URL canonicalises these to 127.0.0.x
    }
  });

  it("never throws on a generated junk/adversarial corpus, and a 'localhost'-substring host placed off-host is never local", () => {
    // Deterministic LCG: weave loopback tokens into NON-host positions.
    let state = 0x6f6f6f;
    const rand = (n: number): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    const tokens = ["localhost", "127.0.0.1", "::1", "evil.com", "@", "/", "#", "?x=", ".", ":8080", "好", "\u0000", " "];
    for (let i = 0; i < 250; i += 1) {
      const url = Array.from({ length: 1 + rand(6) }, () => tokens[rand(tokens.length)]).join("");
      expect(() => isLoopbackUrl(url)).not.toThrow();
      // If it parses to an off-box host, it must not be local — but we can only
      // assert the strong direction for the curated bypasses above; here we just
      // require no-throw + that a clearly-off-host placement isn't local.
      expect(() => classifyProviderLocality("openai-compatible", url)).not.toThrow();
    }
    // Targeted: a loopback token in userinfo/path/fragment with an off-box host is never local.
    for (const url of ["http://localhost@10.0.0.1", "http://10.0.0.1/localhost", "http://10.0.0.1#127.0.0.1"]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });
});
