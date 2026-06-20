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
