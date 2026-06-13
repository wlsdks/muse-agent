import { describe, expect, it } from "vitest";

import { DEFAULT_CLAIM_SUPPORT_FLOOR, screenClaimsBySemanticSupport } from "../src/index.js";

const vec = (...values: number[]): readonly number[] => values;

// A tiny deterministic embedder: each text maps to a fixed named unit vector.
// cosineSimilarity on unit vectors = dot product.
function makeEmbedder(map: Record<string, readonly number[]>) {
  return async (text: string): Promise<readonly number[]> => {
    const result = map[text];
    if (!result) throw new Error(`No embedding for: ${text}`);
    return result;
  };
}

describe("screenClaimsBySemanticSupport — non-vacuity / counterfactual", () => {
  const supportedVec = vec(1, 0, 0);
  const orthogonalVec = vec(0, 1, 0);
  const evidenceVec = vec(1, 0, 0);

  const embed = makeEmbedder({
    "The meeting is on Tuesday": supportedVec,
    "The budget is 999 KRW": orthogonalVec,
    "evidence text": evidenceVec
  });

  it("a claim orthogonal to all evidence is suspect (cosine ≈ 0 < floor)", async () => {
    const results = await screenClaimsBySemanticSupport(["The budget is 999 KRW"], ["evidence text"], embed);
    expect(results[0].suspect).toBe(true);
    expect(results[0].maxCosine).toBeCloseTo(0, 5);
  });

  it("a claim aligned with evidence is not suspect (cosine = 1 ≥ floor)", async () => {
    const results = await screenClaimsBySemanticSupport(["The meeting is on Tuesday"], ["evidence text"], embed);
    expect(results[0].suspect).toBe(false);
    expect(results[0].maxCosine).toBeCloseTo(1, 5);
  });

  it("counterfactual: flipping the fabricated claim to match evidence flips suspect to false", async () => {
    const suspectEmbed = makeEmbedder({
      "fabricated claim": orthogonalVec,
      "true claim": evidenceVec,
      "evidence text": evidenceVec
    });
    const suspectResult = await screenClaimsBySemanticSupport(["fabricated claim"], ["evidence text"], suspectEmbed);
    expect(suspectResult[0].suspect).toBe(true);

    const supportedResult = await screenClaimsBySemanticSupport(["true claim"], ["evidence text"], suspectEmbed);
    expect(supportedResult[0].suspect).toBe(false);
  });
});

describe("screenClaimsBySemanticSupport — fail-open: embed errors → suspect:false", () => {
  const throwingEmbed = async (_text: string): Promise<readonly number[]> => {
    throw new Error("embedder unavailable");
  };

  it("all claims get suspect:false when the embedder throws (never refuses due to infra error)", async () => {
    const results = await screenClaimsBySemanticSupport(
      ["claim A", "claim B"],
      ["evidence text"],
      throwingEmbed
    );
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.suspect).toBe(false);
    }
  });
});

describe("screenClaimsBySemanticSupport — no evidence → suspect:false", () => {
  const embed = makeEmbedder({ "claim A": vec(1, 0, 0) });

  it("returns suspect:false for all claims when no evidence is provided", async () => {
    const results = await screenClaimsBySemanticSupport(["claim A"], [], embed);
    expect(results[0].suspect).toBe(false);
    expect(results[0].maxCosine).toBe(0);
  });
});

describe("screenClaimsBySemanticSupport — empty claims", () => {
  it("returns empty array for empty claims input", async () => {
    const embed = makeEmbedder({});
    const results = await screenClaimsBySemanticSupport([], ["evidence"], embed);
    expect(results).toHaveLength(0);
  });
});

describe("screenClaimsBySemanticSupport — multilingual: semantic alignment despite zero token overlap", () => {
  // Simulates a KO claim paraphrasing an EN evidence fact.
  // A real cross-lingual embedder (nomic-embed-text-v2-moe) aligns KO↔EN in the
  // same space; here we fake the same effect with a high-cosine mapping.
  // A lexical screen would flag this as suspect (zero shared tokens);
  // the semantic screen must not (high cosine → not suspect).
  const koClaimVec = vec(0.9, 0.43, 0);    // high cosine with evidence
  const enEvidenceVec = vec(1, 0, 0);
  const floor = DEFAULT_CLAIM_SUPPORT_FLOOR;

  const alignedEmbed = makeEmbedder({
    "회의는 화요일에 있습니다": koClaimVec, // KO: "The meeting is on Tuesday"
    "The meeting is scheduled for Tuesday": enEvidenceVec
  });

  it("a KO claim paraphrasing an EN evidence fact is NOT flagged as suspect (cosine > floor)", async () => {
    const results = await screenClaimsBySemanticSupport(
      ["회의는 화요일에 있습니다"],
      ["The meeting is scheduled for Tuesday"],
      alignedEmbed,
      floor
    );
    const cosine = results[0].maxCosine;
    // Verify the cosine is above floor and claim is not suspect
    expect(cosine).toBeGreaterThan(floor);
    expect(results[0].suspect).toBe(false);
  });
});

describe("DEFAULT_CLAIM_SUPPORT_FLOOR — value and semantics", () => {
  it("is 0.45 (conservative floor to minimize false-suspect on short claims vs longer evidence)", () => {
    expect(DEFAULT_CLAIM_SUPPORT_FLOOR).toBe(0.45);
  });
});
