import { describe, expect, it } from "vitest";

import {
  COUNCIL_DISSENT_COSINE_FLOOR,
  selectDissentingExclusions,
  synthesizeCouncilAnswer,
  type CouncilAnswer,
  type CouncilUtterance
} from "../src/index.js";

// Dissent-surfacing advisory (Hear Both Sides, arXiv:2603.20640): a consensus
// -outlier the majority set aside, whose reasoning materially diverges from the
// answer, is surfaced as a caution — never re-admitted.

const utterances: readonly CouncilUtterance[] = [
  { peerId: "alice", reasoning: "alice reasoning supporting the plan" },
  { peerId: "carol", reasoning: "carol dissent against the plan" }
];
// answer ≈ alice, orthogonal to carol.
const VEC = (t: string): readonly number[] =>
  t.includes("carol") ? [0, 1, 0] : t.includes("synthes") || t.includes("alice") ? [1, 0, 0] : [0, 0, 1];
const stubEmbed = async (t: string): Promise<readonly number[]> => VEC(t);

const answerWith = (excludedPeers: CouncilAnswer["excludedPeers"]): CouncilAnswer => ({
  answer: "the synthesised answer", contributors: ["alice"], ...(excludedPeers ? { excludedPeers } : {})
});

describe("selectDissentingExclusions (Hear Both Sides arXiv:2603.20640)", () => {
  it("surfaces a consensus-outlier whose reasoning diverges from the answer", async () => {
    const out = await selectDissentingExclusions(answerWith([{ peerId: "carol", reason: "consensus-outlier" }]), utterances, stubEmbed);
    expect(out).toEqual(["carol"]);
  });

  it("does NOT surface a quarantined peer whose reasoning agrees with the answer (cosine ≥ floor)", async () => {
    const embed = async (t: string): Promise<readonly number[]> => (t.includes("carol") ? [0.95, 0.05, 0] : [1, 0, 0]); // carol ≈ answer
    const out = await selectDissentingExclusions(answerWith([{ peerId: "carol", reason: "consensus-outlier" }]), utterances, embed);
    expect(out).toEqual([]);
  });

  it("ignores OFF-TOPIC exclusions (only consensus-outliers are dissent)", async () => {
    const out = await selectDissentingExclusions(answerWith([{ peerId: "carol", reason: "off-topic" }]), utterances, stubEmbed);
    expect(out).toEqual([]);
  });

  it("returns [] when there are no exclusions", async () => {
    expect(await selectDissentingExclusions(answerWith(undefined), utterances, stubEmbed)).toEqual([]);
  });

  it("fail-soft: an embedder that throws surfaces nothing (today's silent behaviour)", async () => {
    const throwing = async (): Promise<readonly number[]> => { throw new Error("embedder down"); };
    expect(await selectDissentingExclusions(answerWith([{ peerId: "carol", reason: "consensus-outlier" }]), utterances, throwing)).toEqual([]);
  });

  it("exports a sane dissent floor", () => {
    expect(COUNCIL_DISSENT_COSINE_FLOOR).toBeGreaterThan(0);
    expect(COUNCIL_DISSENT_COSINE_FLOOR).toBeLessThan(1);
  });
});

describe("synthesizeCouncilAnswer → selectDissentingExclusions — end-to-end (a quarantined dissenter is surfaced)", () => {
  // 3-peer panel: alice+bob agree, carol dissents → the outlier screen (minPanel 3)
  // quarantines carol as a consensus-outlier; her reasoning is orthogonal to the
  // synthesised answer, so she surfaces as dissent.
  const panel: readonly CouncilUtterance[] = [
    { peerId: "alice", reasoning: "alice agrees we should ship gradually behind a flag" },
    { peerId: "bob", reasoning: "bob agrees ship gradually behind a flag" },
    { peerId: "carol", reasoning: "carol says do not ship at all this quarter" }
  ];
  // alice/bob cluster ([1,*,0]); carol orthogonal ([0,0,1]); question on-topic for all.
  const panelEmbed = async (t: string): Promise<readonly number[]> => {
    if (t.includes("carol") || t.includes("not ship")) return [0, 0, 1];
    if (t.includes("alice")) return [1, 0, 0];
    if (t.includes("bob")) return [0.96, 0.28, 0];
    if (t.includes("ship gradually")) return [1, 0, 0]; // the synthesised answer ≈ majority
    return [0.6, 0.4, 0.6]; // question — on-topic to everyone
  };
  const synthesis = JSON.stringify({ answer: "ship gradually behind a flag", contributors: ["alice", "bob"] });
  const provider = { generate: async (r: { model: string }) => ({ id: "r", model: r.model, output: synthesis }) };

  it("quarantines the dissenter and surfaces it via selectDissentingExclusions", async () => {
    const answer = await synthesizeCouncilAnswer("should we ship?", panel, { model: "m", modelProvider: provider, embed: panelEmbed });
    expect(answer).not.toBeNull();
    // carol was quarantined as a consensus-outlier before synthesis...
    expect(answer!.excludedPeers?.some((e) => e.peerId === "carol" && e.reason === "consensus-outlier")).toBe(true);
    // ...and surfaces as dissent (her reasoning diverges from the answer).
    expect(await selectDissentingExclusions(answer!, panel, panelEmbed)).toEqual(["carol"]);
  });
});
