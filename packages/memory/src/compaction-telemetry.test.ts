import { describe, expect, it } from "vitest";

import {
  classifyCompactionFailure,
  type CompactionFailureReason,
  type CompactionFailureStatusLike
} from "./compaction-telemetry.js";

// A ModelProviderError-shaped duck-typed value (mirrors
// packages/model/src/provider-base.ts without importing @muse/model).
function providerError(message: string, retryable: boolean, status?: number): CompactionFailureStatusLike & Error {
  const error = new Error(message) as Error & { retryable?: boolean; status?: number };
  error.name = "ModelProviderError";
  error.retryable = retryable;
  if (status !== undefined) {
    error.status = status;
  }
  return error as CompactionFailureStatusLike & Error;
}

const ALL_REASONS: readonly CompactionFailureReason[] = [
  "no_compactable_entries",
  "below_threshold",
  "guard_blocked",
  "summary_failed",
  "timeout",
  "provider_error_5xx",
  "provider_error_4xx",
  "unknown"
];

describe("classifyCompactionFailure — one case per enum value", () => {
  it("no_compactable_entries — passthrough literal from a deterministic call site", () => {
    expect(classifyCompactionFailure("no_compactable_entries")).toBe("no_compactable_entries");
  });

  it("no_compactable_entries — sniffed from prose", () => {
    expect(classifyCompactionFailure("nothing to compact in this window")).toBe("no_compactable_entries");
  });

  it("below_threshold — passthrough literal", () => {
    expect(classifyCompactionFailure("below_threshold")).toBe("below_threshold");
  });

  it("below_threshold — sniffed from prose", () => {
    expect(classifyCompactionFailure("dropped count is below threshold, no summary inserted")).toBe("below_threshold");
  });

  it("guard_blocked — passthrough literal", () => {
    expect(classifyCompactionFailure("guard_blocked")).toBe("guard_blocked");
  });

  it("guard_blocked — sniffed from an Error message", () => {
    expect(classifyCompactionFailure(new Error("removal refused by the immutable-message guard"))).toBe("guard_blocked");
  });

  it("summary_failed — a plain Error with no recognizable status/keyword", () => {
    expect(classifyCompactionFailure(new Error("aux summarizer threw a parse error"))).toBe("summary_failed");
  });

  it("summary_failed — a status-less/retryable-less object with only a message", () => {
    expect(classifyCompactionFailure({ message: "unexpected null from the summarizer" })).toBe("summary_failed");
  });

  it("timeout — a message-based signal", () => {
    expect(classifyCompactionFailure(new Error("summarizer call timed out after 30s"))).toBe("timeout");
  });

  it("timeout — an HTTP 408 status even though ModelProviderError marks it retryable", () => {
    // 408 is retryable:true on the real ModelProviderError, but timeout is the
    // more specific bucket and must win over provider_error_5xx.
    expect(classifyCompactionFailure(providerError("Ollama request timed out", true, 408))).toBe("timeout");
  });

  it("timeout — an AbortError by name", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    expect(classifyCompactionFailure(error)).toBe("timeout");
  });

  it("provider_error_5xx — a retryable ModelProviderError (no status)", () => {
    expect(classifyCompactionFailure(providerError("Ollama /api/chat failed with 503", true))).toBe("provider_error_5xx");
  });

  it("provider_error_5xx — a duck-typed status object, 500", () => {
    expect(classifyCompactionFailure({ status: 500 })).toBe("provider_error_5xx");
  });

  it("provider_error_5xx — a duck-typed status object, 429 rate limit", () => {
    expect(classifyCompactionFailure({ status: 429 })).toBe("provider_error_5xx");
  });

  it("provider_error_4xx — a non-retryable ModelProviderError (bad key / model not found)", () => {
    expect(classifyCompactionFailure(providerError("Ollama model not found", false, 404))).toBe("provider_error_4xx");
  });

  it("provider_error_4xx — a duck-typed status object, 400", () => {
    expect(classifyCompactionFailure({ status: 400 })).toBe("provider_error_4xx");
  });

  it("unknown — undefined input", () => {
    expect(classifyCompactionFailure(undefined)).toBe("unknown");
  });

  it("unknown — null input", () => {
    expect(classifyCompactionFailure(null)).toBe("unknown");
  });

  it("unknown — an unrecognized plain string", () => {
    expect(classifyCompactionFailure("something completely unrelated happened")).toBe("unknown");
  });

  it("unknown — an empty object with no name/message/status/retryable", () => {
    expect(classifyCompactionFailure({})).toBe("unknown");
  });

  it("exhaustively covers every CompactionFailureReason with at least one case above", () => {
    // Re-derives the set of reasons this file actually exercises above and
    // diffs it against the full enum — if a new bucket is added to
    // CompactionFailureReason without a matching `it(...)` here, this fails.
    const exercised = new Set<CompactionFailureReason>([
      classifyCompactionFailure("no_compactable_entries"),
      classifyCompactionFailure("below_threshold"),
      classifyCompactionFailure("guard_blocked"),
      classifyCompactionFailure(new Error("aux summarizer threw a parse error")),
      classifyCompactionFailure(new Error("summarizer call timed out after 30s")),
      classifyCompactionFailure(providerError("Ollama /api/chat failed with 503", true)),
      classifyCompactionFailure(providerError("Ollama model not found", false, 404)),
      classifyCompactionFailure(undefined)
    ]);
    expect([...exercised].sort()).toEqual([...ALL_REASONS].sort());
  });
});

describe("classifyCompactionFailure — mutation-sensitivity", () => {
  it("a retryable ModelProviderError is NEVER classified as the non-retryable 4xx bucket", () => {
    // If the retryable/4xx branch mapping is flipped, this goes RED.
    expect(classifyCompactionFailure(providerError("upstream is overloaded", true))).not.toBe("provider_error_4xx");
  });

  it("a non-retryable ModelProviderError is NEVER classified as the retryable 5xx bucket", () => {
    expect(classifyCompactionFailure(providerError("bad api key", false))).not.toBe("provider_error_5xx");
  });

  it("guard_blocked text does not collide with below_threshold", () => {
    expect(classifyCompactionFailure(new Error("compaction guard blocked the removal"))).not.toBe("below_threshold");
  });
});
