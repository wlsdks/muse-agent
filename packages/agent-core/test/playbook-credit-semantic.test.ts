import { describe, expect, it } from "vitest";

import { DEFAULT_PLAYBOOK_CREDIT_COSINE, selectCreditTargetSemantic } from "../src/index.js";

// Semantic credit assignment for the playbook RL loop (Memory-R2 arXiv:2605.21768;
// mis-credited reward replays via experience-following arXiv:2505.16067). The
// strategy TEXT (terse imperative) and the feedback CUE (user prose) are different
// distributions — lexical Jaccard mis-/no-credits a paraphrase; embedding cosine
// picks the strategy the cue actually implicates.

// Controlled vectors: "true" strategy parallel to the cue, "decoy" orthogonal.
const VECS: Record<string, readonly number[]> = {
  cue: [1, 0, 0],
  true_match: [0.99, 0.01, 0], // ~parallel to cue
  decoy: [0, 1, 0] // orthogonal
};
const stubEmbed = async (text: string): Promise<readonly number[]> => VECS[text] ?? [0, 0, 1];

describe("selectCreditTargetSemantic (Memory-R2 arXiv:2605.21768)", () => {
  it("credits the SEMANTICALLY matching strategy, not a lexical decoy", async () => {
    const id = await selectCreditTargetSemantic(
      [{ id: "decoy-id", text: "decoy" }, { id: "true-id", text: "true_match" }],
      "cue",
      stubEmbed
    );
    expect(id).toBe("true-id");
  });

  it("returns undefined when nothing clears the cosine floor (caller falls back to lexical)", async () => {
    const id = await selectCreditTargetSemantic([{ id: "decoy-id", text: "decoy" }], "cue", stubEmbed);
    expect(id).toBeUndefined();
  });

  it("respects a custom threshold (a near-but-below match is not credited)", async () => {
    const id = await selectCreditTargetSemantic(
      [{ id: "true-id", text: "true_match" }],
      "cue",
      stubEmbed,
      0.99999 // above the ~0.99995 cosine of cue,true_match
    );
    expect(id).toBeUndefined();
  });

  it("picks the HIGHEST-cosine candidate when several clear the floor", async () => {
    const embed = async (t: string): Promise<readonly number[]> =>
      t === "cue" ? [1, 0, 0] : t === "near" ? [0.9, 0.4, 0] : [0.99, 0.01, 0];
    const id = await selectCreditTargetSemantic(
      [{ id: "near-id", text: "near" }, { id: "best-id", text: "best" }],
      "cue",
      embed
    );
    expect(id).toBe("best-id");
  });

  it("fail-soft: an embedder that throws returns undefined (lexical fallback path)", async () => {
    const throwing = async (): Promise<readonly number[]> => {
      throw new Error("embedder down");
    };
    expect(await selectCreditTargetSemantic([{ id: "x", text: "true_match" }], "cue", throwing)).toBeUndefined();
  });

  it("empty candidates or empty cue is undefined (no embed call needed)", async () => {
    let called = 0;
    const counting = async (t: string): Promise<readonly number[]> => {
      called += 1;
      return VECS[t] ?? [0, 0, 1];
    };
    expect(await selectCreditTargetSemantic([], "cue", counting)).toBeUndefined();
    expect(await selectCreditTargetSemantic([{ id: "x", text: "true_match" }], "   ", counting)).toBeUndefined();
    expect(called).toBe(0);
  });

  it("a candidate with no embedding is skipped, not credited (zero-vector safe)", async () => {
    const embed = async (t: string): Promise<readonly number[]> => (t === "blank" ? [] : VECS[t] ?? [0, 0, 1]);
    const id = await selectCreditTargetSemantic(
      [{ id: "blank-id", text: "blank" }, { id: "true-id", text: "true_match" }],
      "cue",
      embed
    );
    expect(id).toBe("true-id");
  });

  it("exports a sane default credit floor", () => {
    expect(DEFAULT_PLAYBOOK_CREDIT_COSINE).toBeGreaterThan(0);
    expect(DEFAULT_PLAYBOOK_CREDIT_COSINE).toBeLessThan(1);
  });
});
