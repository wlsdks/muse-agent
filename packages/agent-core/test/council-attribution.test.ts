import { describe, expect, it } from "vitest";

import {
  COUNCIL_ATTRIBUTION_COSINE_FLOOR,
  screenUnfaithfulContributors,
  synthesizeCouncilAnswer,
  type CouncilUtterance
} from "../src/index.js";

// Council contributor-attribution faithfulness screen (arXiv:2412.18004 —
// "Correctness is not Faithfulness in RAG Attributions": citations are often
// post-rationalized). A peer listed as a contributor whose reasoning does NOT
// semantically support the answer is a false-provenance leak; drop it.

// Controlled vectors. answer ≈ alice, orthogonal to bob; both reasonings are
// on-topic vs the question (so they survive the pre-synthesis screens).
const VEC = (text: string): readonly number[] =>
  text.includes("alice") ? [1, 1, 0]
    : text.includes("bob") ? [1, 0, 1]
      : text.includes("synthesized") ? [0, 1, 0] // the answer
        : [1, 0, 0]; // question / default
const stubEmbed = async (text: string): Promise<readonly number[]> => VEC(text);

const utterances: readonly CouncilUtterance[] = [
  { peerId: "alice", reasoning: "alice reasoning here" },
  { peerId: "bob", reasoning: "bob reasoning here" }
];

describe("screenUnfaithfulContributors (arXiv:2412.18004)", () => {
  const answer = "the synthesized answer"; // → [0,1,0]

  it("drops a contributor whose reasoning does not support the answer", async () => {
    const kept = await screenUnfaithfulContributors(answer, ["alice", "bob"], utterances, stubEmbed);
    expect(kept).toEqual(["alice"]); // bob orthogonal to the answer → dropped
  });

  it("keeps every contributor whose reasoning genuinely supports the answer", async () => {
    // Both reasonings align with the answer → both kept.
    const embed = async (t: string): Promise<readonly number[]> => (t.includes("synthesized") || t.includes("alice") || t.includes("bob") ? [0, 1, 0] : [1, 0, 0]);
    const kept = await screenUnfaithfulContributors(answer, ["alice", "bob"], utterances, embed);
    expect([...kept].sort()).toEqual(["alice", "bob"]);
  });

  it("never empties the provenance — keeps the single best-supported peer", async () => {
    // Both orthogonal to the answer → would empty → keep the best (alice, higher cosine).
    const embed = async (t: string): Promise<readonly number[]> =>
      t.includes("synthesized") ? [0, 0, 1] : t.includes("alice") ? [0.2, 0, 1] : [1, 0, 0];
    const kept = await screenUnfaithfulContributors(answer, ["alice", "bob"], utterances, embed);
    expect(kept).toHaveLength(1);
    expect(kept).toEqual(["alice"]);
  });

  it("≤1 contributor is a no-op (a sole source is never screened away)", async () => {
    expect(await screenUnfaithfulContributors(answer, ["alice"], utterances, stubEmbed)).toEqual(["alice"]);
  });

  it("fail-soft: an embedder that throws leaves the contributor list intact", async () => {
    const throwing = async (): Promise<readonly number[]> => { throw new Error("embedder down"); };
    expect(await screenUnfaithfulContributors(answer, ["alice", "bob"], utterances, throwing)).toEqual(["alice", "bob"]);
  });

  it("a contributor with no matching utterance reasoning is kept (fail-open per-id)", async () => {
    const kept = await screenUnfaithfulContributors(answer, ["alice", "ghost"], utterances, stubEmbed);
    expect([...kept].sort()).toEqual(["alice", "ghost"]);
  });

  it("exports a sane attribution floor", () => {
    expect(COUNCIL_ATTRIBUTION_COSINE_FLOOR).toBeGreaterThan(0);
    expect(COUNCIL_ATTRIBUTION_COSINE_FLOOR).toBeLessThan(1);
  });
});

describe("synthesizeCouncilAnswer — drops a falsely-attributed contributor end-to-end", () => {
  // The synthesiser post-rationalizes BOTH peers as contributors; only alice's
  // reasoning supports the answer, so bob's false attribution is screened out.
  const fakeProvider = (output: string) => ({ generate: async () => ({ id: "r", model: "m", output }) });
  const synthesis = JSON.stringify({ answer: "the synthesized answer", contributors: ["alice", "bob"] });

  it("with embed: a peer whose reasoning doesn't support the answer is removed from provenance", async () => {
    const out = await synthesizeCouncilAnswer("which approach is best", utterances, {
      model: "m",
      modelProvider: fakeProvider(synthesis),
      embed: stubEmbed
    });
    expect(out?.contributors).toEqual(["alice"]); // bob (post-rationalized) dropped
  });

  it("without embed: behaviour is unchanged (both contributors retained, back-compat)", async () => {
    const out = await synthesizeCouncilAnswer("which approach is best", utterances, {
      model: "m",
      modelProvider: fakeProvider(synthesis)
    });
    expect([...(out?.contributors ?? [])].sort()).toEqual(["alice", "bob"]);
  });
});
