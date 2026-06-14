import type { ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  collapseNearDuplicateReflections,
  filterReflectionsAgainstStore,
  REFLECTION_DEDUP_COSINE,
  synthesizeReflections,
  type Reflection
} from "../src/index.js";

// Semantic near-duplicate collapse on grounded reflections (SemDeDup,
// arXiv:2303.09540): two paraphrases of one theme — both grounded — merge into
// one, their sources UNIONed. Lexical store dedup misses the paraphrase; cosine
// catches it (the cumulative lesson: semantic > lexical on model-prose).

const MORNING_A = "prefers morning meetings";
const MORNING_B = "likes scheduling meetings in the morning"; // paraphrase of A
const EMAILS = "dislikes long emails"; // orthogonal theme

// Controlled vectors: A and B nearly parallel (cosine ~0.99995), EMAILS orthogonal.
const VECS: Record<string, readonly number[]> = {
  [MORNING_A]: [1, 0, 0],
  [MORNING_B]: [0.99, 0.01, 0],
  [EMAILS]: [0, 1, 0]
};
const stubEmbed = async (text: string): Promise<readonly number[]> => VECS[text] ?? [0, 0, 1];

const reflection = (insight: string, sourceIds: string[]): Reflection => ({
  insight,
  sourceIds,
  supportCount: sourceIds.length
});

describe("collapseNearDuplicateReflections (SemDeDup arXiv:2303.09540)", () => {
  it("merges two paraphrases into one, UNIONing their sources", async () => {
    const out = await collapseNearDuplicateReflections(
      [reflection(MORNING_A, ["e1", "e2"]), reflection(MORNING_B, ["e2", "e3"])],
      stubEmbed
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.insight).toBe(MORNING_A); // tie on support → earlier representative
    expect([...out[0]!.sourceIds].sort()).toEqual(["e1", "e2", "e3"]); // unioned, deduped
    expect(out[0]!.supportCount).toBe(3); // support GREW with the union — no grounding lost
  });

  it("keeps two distinct (orthogonal) insights", async () => {
    const out = await collapseNearDuplicateReflections(
      [reflection(MORNING_A, ["e1", "e2"]), reflection(EMAILS, ["e3", "e4"])],
      stubEmbed
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.insight)).toEqual([MORNING_A, EMAILS]);
  });

  it("a high enough threshold keeps even the paraphrases separate (non-vacuity / no over-merge)", async () => {
    const out = await collapseNearDuplicateReflections(
      [reflection(MORNING_A, ["e1", "e2"]), reflection(MORNING_B, ["e3", "e4"])],
      stubEmbed,
      { threshold: 0.99999 } // above the ~0.99995 cosine of A,B
    );
    expect(out).toHaveLength(2);
  });

  it("the HIGHER-support insight becomes the representative on merge", async () => {
    const out = await collapseNearDuplicateReflections(
      // B has more support → its text wins, sources unioned across both
      [reflection(MORNING_A, ["e1", "e2"]), reflection(MORNING_B, ["e2", "e3", "e4"])],
      stubEmbed
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.insight).toBe(MORNING_B);
    expect([...out[0]!.sourceIds].sort()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(out[0]!.supportCount).toBe(4);
  });

  it("fail-soft: an embedder that throws returns the input unchanged", async () => {
    const throwing = async (): Promise<readonly number[]> => {
      throw new Error("embedder down");
    };
    const input = [reflection(MORNING_A, ["e1", "e2"]), reflection(MORNING_B, ["e2", "e3"])];
    const out = await collapseNearDuplicateReflections(input, throwing);
    expect(out).toHaveLength(2);
  });

  it("an empty embedding keeps that reflection as its own cluster (never merged on a zero vector)", async () => {
    const out = await collapseNearDuplicateReflections(
      [reflection(MORNING_A, ["e1", "e2"]), reflection("unembeddable", ["e3", "e4"])],
      async (text) => (text === "unembeddable" ? [] : VECS[text] ?? [0, 0, 1])
    );
    expect(out).toHaveLength(2);
  });

  it("fewer than 2 reflections is a no-op", async () => {
    const out = await collapseNearDuplicateReflections([reflection(MORNING_A, ["e1", "e2"])], stubEmbed);
    expect(out).toHaveLength(1);
  });

  it("exports a sane default cosine floor", () => {
    expect(REFLECTION_DEDUP_COSINE).toBeGreaterThan(0.8);
    expect(REFLECTION_DEDUP_COSINE).toBeLessThan(1);
  });
});

describe("filterReflectionsAgainstStore (Mem0 NOOP arXiv:2504.19413) — cross-tick write dedup", () => {
  it("drops a fresh insight that paraphrases one ALREADY in the store", async () => {
    const out = await filterReflectionsAgainstStore(
      [reflection(MORNING_B, ["e3", "e4"]), reflection(EMAILS, ["e5", "e6"])],
      [MORNING_A], // already stored — MORNING_B is its paraphrase
      stubEmbed
    );
    expect(out.map((r) => r.insight)).toEqual([EMAILS]); // the paraphrase is NOOP-dropped, the distinct one survives
  });

  it("keeps everything when nothing in the store matches", async () => {
    const out = await filterReflectionsAgainstStore(
      [reflection(MORNING_A, ["e1", "e2"])],
      [EMAILS], // orthogonal stored insight
      stubEmbed
    );
    expect(out).toHaveLength(1);
  });

  it("empty store / empty fresh is a no-op pass-through", async () => {
    expect(await filterReflectionsAgainstStore([reflection(MORNING_A, ["e1"])], [], stubEmbed)).toHaveLength(1);
    expect(await filterReflectionsAgainstStore([], [MORNING_A], stubEmbed)).toHaveLength(0);
  });

  it("fail-soft: an embedder that throws keeps all fresh reflections (store dedup falls back to lexical)", async () => {
    const throwing = async (): Promise<readonly number[]> => {
      throw new Error("embedder down");
    };
    const out = await filterReflectionsAgainstStore([reflection(MORNING_B, ["e3"])], [MORNING_A], throwing);
    expect(out).toHaveLength(1);
  });

  it("a fresh insight with no embedding is kept (never NOOP-dropped on a zero vector)", async () => {
    const out = await filterReflectionsAgainstStore(
      [reflection("unembeddable", ["e3"])],
      [MORNING_A],
      async (text) => (text === "unembeddable" ? [] : VECS[text] ?? [0, 0, 1])
    );
    expect(out).toHaveLength(1);
  });
});

describe("synthesizeReflections — embed option collapses paraphrased dreams end-to-end", () => {
  const inputs = [
    { id: "e1", text: "scheduled the standup at 9am" },
    { id: "e2", text: "moved the review to early morning" },
    { id: "e3", text: "asked for a morning slot again" }
  ];
  // The 12B emits two PARAPHRASES of one theme, each grounded in >=2 real ids.
  const twoParaphrases = JSON.stringify([
    { insight: MORNING_A, sources: ["e1", "e2"] },
    { insight: MORNING_B, sources: ["e2", "e3"] }
  ]);
  const provider = { generate: async (r: ModelRequest) => ({ id: "r", model: r.model, output: twoParaphrases }) };

  it("WITHOUT embed: both grounded paraphrases survive (back-compat)", async () => {
    const out = await synthesizeReflections(inputs, { model: "m", modelProvider: provider });
    expect(out).toHaveLength(2);
  });

  it("WITH embed: the paraphrase collapses to one, sources unioned (non-inert through the real seam)", async () => {
    const out = await synthesizeReflections(inputs, { model: "m", modelProvider: provider, embed: stubEmbed });
    expect(out).toHaveLength(1);
    expect([...out[0]!.sourceIds].sort()).toEqual(["e1", "e2", "e3"]);
  });
});
