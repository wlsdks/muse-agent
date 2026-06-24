import { describe, expect, it } from "vitest";

import { buildCacheKey, buildScopeFingerprint, normalizeCacheText, type AgentCacheCommand } from "../src/index.js";

describe("normalizeCacheText (PC-4)", () => {
  it("converts CRLF/CR to LF", () => {
    expect(normalizeCacheText("a\r\nb\rc")).toBe("a\nb\nc");
  });
  it("strips per-line trailing whitespace and trims ends", () => {
    expect(normalizeCacheText("  hi  \n  there \t \n\n")).toBe("hi\n  there");
  });
  it("is idempotent and leaves clean text identical", () => {
    const clean = "line one\nline two";
    expect(normalizeCacheText(clean)).toBe(clean);
    expect(normalizeCacheText(normalizeCacheText(clean))).toBe(clean);
  });
});

const cmd = (over: Partial<AgentCacheCommand>): AgentCacheCommand => ({ userPrompt: "hi", ...over });

describe("cache keys are stable across trivial whitespace/line-ending differences (PC-4)", () => {
  it("same userPrompt modulo CRLF/trailing-ws yields the same cache key", () => {
    const a = buildCacheKey(cmd({ userPrompt: "what is up?\nthanks" }), ["a"]);
    const b = buildCacheKey(cmd({ userPrompt: "what is up?  \r\nthanks   " }), ["a"]);
    expect(a).toBe(b);
  });

  it("genuinely different prompts still differ", () => {
    expect(buildCacheKey(cmd({ userPrompt: "alpha" }), ["a"])).not.toBe(buildCacheKey(cmd({ userPrompt: "beta" }), ["a"]));
  });

  it("dedupes tool names in the scope fingerprint", () => {
    expect(buildScopeFingerprint(cmd({}), ["a", "b", "a"])).toBe(buildScopeFingerprint(cmd({}), ["a", "b"]));
  });

  it("normalizes the system prompt in the scope fingerprint", () => {
    expect(buildScopeFingerprint(cmd({ systemPrompt: "sys\r\nprompt" }), ["a"]))
      .toBe(buildScopeFingerprint(cmd({ systemPrompt: "sys\nprompt  " }), ["a"]));
  });
});
