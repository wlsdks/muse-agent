import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIDENT_AT,
  classifyRetrievalConfidence,
  resolveRecallConfidentAt,
  verifyGrounding,
  type KnowledgeMatch
} from "./index.js";

// A top match whose cosine sits BETWEEN the conformal-calibrated stricter bar
// (0.62) and the hardcoded default (0.55). The runner-up is far below so the
// margin guard never fires — the only lever flipping the verdict is the
// `confidentAt` threshold itself.
const TOP_COSINE = 0.57;
const CALIBRATED = 0.62;

const matches: readonly KnowledgeMatch[] = [
  {
    source: "vpn_notes",
    text: "the office VPN MTU is 1380 bytes for the seoul office tunnel",
    score: TOP_COSINE,
    cosine: TOP_COSINE
  },
  {
    source: "unrelated_note",
    text: "grocery list milk eggs bread",
    score: 0.3,
    cosine: 0.3
  }
];

const answer = "[from vpn_notes] The office VPN MTU is 1380 bytes.";
const query = "what is the office VPN MTU";

describe("RGV recall honors the conformal-calibrated MUSE_GROUNDING_MIN_COSINE override", () => {
  it("verdict FLIPS grounded→weak when the calibrated stricter threshold is threaded through", () => {
    const atDefault = verifyGrounding(answer, matches, query, { confidentAt: DEFAULT_CONFIDENT_AT });
    expect(atDefault.verdict).toBe("grounded");

    const atCalibrated = verifyGrounding(answer, matches, query, { confidentAt: CALIBRATED });
    expect(atCalibrated.verdict).toBe("weak");
  });

  it("classifyRetrievalConfidence demotes confident→ambiguous at the stricter bar", () => {
    expect(classifyRetrievalConfidence(matches, { confidentAt: DEFAULT_CONFIDENT_AT })).toBe("confident");
    expect(classifyRetrievalConfidence(matches, { confidentAt: CALIBRATED })).toBe("ambiguous");
  });
});

describe("resolveRecallConfidentAt — opt-in, fail-safe (mirrors the chat gate parse)", () => {
  it("a valid in-range env value is used", () => {
    expect(resolveRecallConfidentAt({ MUSE_GROUNDING_MIN_COSINE: "0.62" })).toBeCloseTo(0.62, 6);
  });

  it("a missing env var falls back to DEFAULT_CONFIDENT_AT", () => {
    expect(resolveRecallConfidentAt({})).toBe(DEFAULT_CONFIDENT_AT);
  });

  it("garbage / out-of-range values fall back to DEFAULT_CONFIDENT_AT", () => {
    for (const bad of ["abc", "0", "-0.3", "1.4", "", "NaN", "Infinity"]) {
      expect(resolveRecallConfidentAt({ MUSE_GROUNDING_MIN_COSINE: bad })).toBe(DEFAULT_CONFIDENT_AT);
    }
  });

  it("the resolved value threads through verifyGrounding to flip the verdict", () => {
    const calibrated = resolveRecallConfidentAt({ MUSE_GROUNDING_MIN_COSINE: String(CALIBRATED) });
    expect(verifyGrounding(answer, matches, query, { confidentAt: calibrated }).verdict).toBe("weak");

    const noOverride = resolveRecallConfidentAt({});
    expect(verifyGrounding(answer, matches, query, { confidentAt: noOverride }).verdict).toBe("grounded");
  });
});

describe("resolveRecallConfidentAt — embedder-aware calibrated bar (conformal, 24/12 edge corpus)", () => {
  it("returns the v2-moe-calibrated 0.45 for the compressed-scale default embedder", () => {
    expect(resolveRecallConfidentAt({}, "nomic-embed-text-v2-moe")).toBeCloseTo(0.45, 6);
  });

  it("keeps nomic-embed-text at the conservative 0.55 (its 0.44–0.51 distractors would leak at 0.45)", () => {
    expect(resolveRecallConfidentAt({}, "nomic-embed-text")).toBe(DEFAULT_CONFIDENT_AT);
  });

  it("normalizes a provider prefix and :tag so ollama/<model>:latest still keys", () => {
    expect(resolveRecallConfidentAt({}, "ollama/nomic-embed-text-v2-moe:latest")).toBeCloseTo(0.45, 6);
  });

  it("an UNKNOWN embedder falls back to the conservative default (never a guessed bar)", () => {
    expect(resolveRecallConfidentAt({}, "some-future-embedder")).toBe(DEFAULT_CONFIDENT_AT);
    expect(resolveRecallConfidentAt({})).toBe(DEFAULT_CONFIDENT_AT);
  });

  it("an explicit MUSE_GROUNDING_MIN_COSINE override beats the embedder default", () => {
    expect(resolveRecallConfidentAt({ MUSE_GROUNDING_MIN_COSINE: "0.62" }, "nomic-embed-text-v2-moe")).toBeCloseTo(0.62, 6);
  });

  it("the v2-moe bar classifies a sub-0.55 clear top CONFIDENT that 0.55 would over-abstain on", () => {
    // A genuine v2-moe match at 0.49 (above 0.45, below 0.55) with a far runner-up.
    const m: readonly KnowledgeMatch[] = [
      { source: "note", text: "the answer-bearing note", score: 0.49, cosine: 0.49 },
      { source: "other", text: "unrelated", score: 0.25, cosine: 0.25 }
    ];
    expect(classifyRetrievalConfidence(m, { confidentAt: resolveRecallConfidentAt({}, "nomic-embed-text-v2-moe") })).toBe("confident");
    expect(classifyRetrievalConfidence(m, { confidentAt: resolveRecallConfidentAt({}, "nomic-embed-text") })).toBe("ambiguous");
  });

  it("an absent-like top (≤0.415 max-negative) STAYS ambiguous at the v2-moe bar — fabrication-safe", () => {
    const absent: readonly KnowledgeMatch[] = [
      { source: "note", text: "near miss", score: 0.41, cosine: 0.41 },
      { source: "other", text: "unrelated", score: 0.2, cosine: 0.2 }
    ];
    expect(classifyRetrievalConfidence(absent, { confidentAt: resolveRecallConfidentAt({}, "nomic-embed-text-v2-moe") })).toBe("ambiguous");
  });
});
