import { describe, expect, it } from "vitest";

import { detectPairwiseContradictions } from "./evidence-conflicts.js";
import { detectEvidenceContradictions } from "./knowledge-recall.js";
import type { KnowledgeMatch } from "./knowledge-recall.js";

// Fake embedder: each call returns a deterministic vector derived from the text.
// Designed so:
//   - same-topic pairs get high cosine (≥0.86) via a shared base direction
//   - different-topic pairs get low cosine (<0.86) via an orthogonal direction
//
// Strategy: a note embedding = baseDir + content contribution. Two notes that
// share the same topic base contribute the same large base component, yielding
// a high cosine. An off-topic note uses a perpendicular base direction.
function makeTopicEmbed(topicKey: string): (text: string) => Promise<readonly number[]> {
  // Two orthogonal base directions in 4-D space.
  const topicBases: Record<string, readonly number[]> = {
    flight: [0.9, 0.1, 0, 0],
    weather: [0, 0, 0.9, 0.1]
  };
  return async (_text: string): Promise<readonly number[]> => {
    const base = topicBases[topicKey] ?? topicBases["flight"]!;
    // Normalise so cosine between same-topic notes is near 1.
    return base;
  };
}

// A pair of embedders where both notes use the "flight" topic base → high cosine.
function sameTopicEmbed(): (text: string) => Promise<readonly number[]> {
  return makeTopicEmbed("flight");
}

// An embedder that returns a high cosine for same-topic notes but a low
// cosine for a note declared as "weather" (different topic).
function crossTopicEmbed(noteText: string): (text: string) => Promise<readonly number[]> {
  return async (text: string) => {
    if (text === noteText) return [0, 0, 0.9, 0.1]; // weather direction
    return [0.9, 0.1, 0, 0]; // flight direction
  };
}

const flightAt3: KnowledgeMatch = {
  score: 0.9,
  source: "notes/travel.md",
  text: "my flight leaves at 3pm from gate 12"
};
const flightAt6: KnowledgeMatch = {
  score: 0.8,
  source: "notes/update.md",
  text: "my flight leaves at 6pm from gate 12"
};

// Same-value paraphrase: different words, same meaning (low overlap, high cosine).
const flightParaphrase: KnowledgeMatch = {
  score: 0.75,
  source: "notes/paraphrase.md",
  text: "departure is scheduled for 3 in the afternoon"
};

// Korean note with same value — different script from English.
const flightKorean: KnowledgeMatch = {
  score: 0.85,
  source: "notes/korean.md",
  text: "항공편은 오후 3시에 게이트 12에서 출발합니다"
};

// Complementary same-topic notes: same flight time, different additional facts.
const flightAt3Extra: KnowledgeMatch = {
  score: 0.88,
  source: "notes/extra.md",
  text: "my flight leaves at 3pm bring passport"
};

describe("detectEvidenceContradictions — genuine value-conflict detection (arXiv:2504.19413)", () => {

  it("positive: same-script same-topic notes with high overlap and a differing value → exactly one pair", async () => {
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightAt6],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(1);
    // aIndex=0 (earlier in array), bIndex=1 — no score-based ordering
    expect(pairs[0]!.aIndex).toBe(0);
    expect(pairs[0]!.bIndex).toBe(1);
    expect(pairs[0]!.topicSim).toBeGreaterThanOrEqual(0.86);
  });

  it("FALSE-POSITIVE GUARD — paraphrase (same value, different words) → ZERO pairs", async () => {
    // flightAt3 and flightParaphrase share the same value but different words → low token overlap.
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightParaphrase],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("FALSE-POSITIVE GUARD — cross-lingual agreeing pair (EN + KO same value, different script) → ZERO pairs", async () => {
    // The same-script guard blocks EN vs KO pairs entirely (fail-open).
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightKorean],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("FALSE-POSITIVE GUARD — two genuinely different-topic notes (low cosine) → ZERO pairs", async () => {
    // Use a cross-topic embed: the second note gets the weather direction.
    const weatherNote: KnowledgeMatch = {
      score: 0.7,
      source: "notes/weather.md",
      text: "tomorrow will be sunny with temperatures around 25 degrees"
    };
    const pairs = await detectEvidenceContradictions(
      [flightAt3, weatherNote],
      crossTopicEmbed(weatherNote.text)
    );
    expect(pairs).toHaveLength(0);
  });

  it("FALSE-POSITIVE GUARD — complementary same-topic notes (same value, extra different tokens) → assessed", async () => {
    // flightAt3: "my flight leaves at 3pm from gate 12"
    // flightAt3Extra: "my flight leaves at 3pm bring passport"
    // Both share "3pm" but "gate 12" vs "bring passport" differ.
    // Token sets:
    //   flightAt3: {flight, leaves, 3pm, gate, 12}
    //   flightAt3Extra: {flight, leaves, 3pm, bring, passport}
    //   intersection: {flight, leaves, 3pm} = 3
    //   union: {flight, leaves, 3pm, gate, 12, bring, passport} = 7
    //   overlapRatio = 3/7 ≈ 0.43 < STATEMENT_OVERLAP_MIN (0.5) → NOT flagged.
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightAt3Extra],
      sameTopicEmbed()
    );
    // With a 3/7 overlap ratio (< 0.5), the statement-overlap gate correctly
    // rejects this pair — these are complementary facts, not a value conflict.
    expect(pairs).toHaveLength(0);
  });

  it("counterfactual / non-vacuity: flip conflicting value to match → zero pairs", async () => {
    const flightAt3Copy: KnowledgeMatch = {
      score: 0.8,
      source: "notes/copy.md",
      text: "my flight leaves at 3pm from gate 12"
    };
    // Identical texts → identical token sets → the identical-set check fires → 0 pairs.
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightAt3Copy],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("fail-open: embed throws → zero pairs (never throws)", async () => {
    const throwingEmbed = async (_text: string): Promise<readonly number[]> => {
      throw new Error("Ollama unreachable");
    };
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightAt6],
      throwingEmbed
    );
    expect(pairs).toHaveLength(0);
  });

  it("aIndex is the earlier-in-array note (i), bIndex the later (j) — no score-based ordering", async () => {
    // Swap order: lower-score first
    const pairs = await detectEvidenceContradictions(
      [flightAt6, flightAt3],  // at6 first (index 0), at3 second (index 1)
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(1);
    // aIndex=0 (earlier), bIndex=1 (later) — score no longer determines order
    expect(pairs[0]!.aIndex).toBe(0);
    expect(pairs[0]!.bIndex).toBe(1);
  });

  it("single match → zero pairs (no pairs possible)", async () => {
    const pairs = await detectEvidenceContradictions([flightAt3], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  // --- Defect-2 guards: ELABORATION false-positives must → ZERO pairs ---

  it("ELABORATION FP GUARD — 'meeting at 2pm' / 'meeting at 2pm in room 4' → ZERO pairs (neither-subset)", async () => {
    // tokA = {meeting, 2pm}; tokB = {meeting, 2pm, room}
    // A ⊂ B → aMinusB=0 → not a conflict
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "meeting at 2pm" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "meeting at 2pm in room 4" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  it("ELABORATION FP GUARD — dinner reservation elaboration → ZERO pairs", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "dinner reservation at 7pm" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "dinner reservation at 7pm for four people" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  it("ELABORATION FP GUARD — wifi password elaboration → ZERO pairs", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "wifi password is bluefox42" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "wifi password is bluefox42 on the 5ghz band" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  it("ELABORATION FP GUARD — project deadline elaboration → ZERO pairs", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "project deadline is friday" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "project deadline is friday per the kickoff doc" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  it("ELABORATION FP GUARD — budget elaboration → ZERO pairs", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "the budget is $1250 for Q3" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "the budget is $1250, approved by Mina" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(0);
  });

  // --- Genuine conflicts must still be flagged ---
  // Note: the overlap gate (≥0.5 Jaccard) requires notes to share the statement
  // skeleton — short 2-token notes ("meeting at 2pm") don't clear it. These tests
  // use realistic note sentences so the skeleton + value-change pattern is present.

  it("GENUINE CONFLICT — standup meeting time changed (2pm vs 3pm) → 1 pair", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "the team standup meeting is at 2pm daily" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "the team standup meeting is at 3pm daily" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(1);
  });

  it("GENUINE CONFLICT — 'flight departs at 3pm' vs 'flight departs at 6pm' → 1 pair", async () => {
    const pairs = await detectEvidenceContradictions(
      [flightAt3, flightAt6],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(1);
  });

  it("GENUINE CONFLICT — budget value changed (1250 vs 1350) → 1 pair", async () => {
    const noteA: KnowledgeMatch = { score: 0.9, source: "a.md", text: "the quarterly budget is set at 1250 dollars" };
    const noteB: KnowledgeMatch = { score: 0.85, source: "b.md", text: "the quarterly budget is set at 1350 dollars" };
    const pairs = await detectEvidenceContradictions([noteA, noteB], sameTopicEmbed());
    expect(pairs).toHaveLength(1);
  });
});

// Live-calibrated regression pins (eval:council-floors). The detector previously
// gated "same topic" on cosine ≥ 0.86 and compared ALL content tokens — but a
// value difference LOWERS the cosine (the embedding encodes the value), so the
// high floor skipped real conflicts while admitting paraphrases, which the
// all-token neither-subset test then flagged. Net: an AGREEING panel reported a
// contradiction and a genuinely disagreeing one reported none. These pin both
// directions with an embedder faithful to the measured cosines.
describe("detectPairwiseContradictions — value-token discrimination (measured bands)", () => {
  // Faithful stub — reproduces the MEASURED nomic-v2-moe cosines exactly, so a
  // regression in the topic floor is caught here and not only in the live
  // battery: paraphrase 0.94, real value-conflict 0.79, elaboration 0.79,
  // unrelated 0.05. Angles chosen so cos(Δθ) hits those numbers.
  const angleFor = (t: string): number => {
    if (t.includes("dodgers")) return 1.52;              // cos(1.52) ≈ 0.05 vs base
    if (/130|3일|4pm|wednesday/u.test(t)) return 0.66;   // conflict variant: cos ≈ 0.79
    if (/room 4|automatic/u.test(t)) return 0.66;        // elaboration / reworded: cos ≈ 0.79
    if (/입니다/u.test(t)) return 0.35;                   // paraphrase: cos ≈ 0.94
    return 0;                                            // the base statement
  };
  const embed = async (t: string): Promise<readonly number[]> => {
    const theta = angleFor(t.toLowerCase());
    return [Math.cos(theta), Math.sin(theta)];
  };

  it("does NOT flag an agreeing pair that differs only in phrasing (KO particle drift)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["월세는 매달 25일에 나가고 금액은 90만원이야.", "월세는 매달 25일에 나가고 금액은 90만원입니다."],
      embed
    );
    expect(pairs).toEqual([]);
  });

  it("flags a genuine value conflict on the same statement skeleton (KO)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["월세는 매달 25일에 나가고 금액은 90만원이야.", "월세는 매달 3일에 나가고 금액은 130만원이야."],
      embed
    );
    expect(pairs).toHaveLength(1);
  });

  it("flags a conflicting weekday (a value that carries no digits)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["the deadline is tuesday", "the deadline is wednesday"],
      embed
    );
    expect(pairs).toHaveLength(1);
  });

  it("does NOT flag an elaboration whose values are a superset", async () => {
    const pairs = await detectPairwiseContradictions(["meeting at 2pm", "meeting at 2pm in room 4"], embed);
    expect(pairs).toEqual([]);
  });

  it("does NOT flag a pair with no value tokens at all (precision-first: no values, no conflict)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["the rent is paid by auto transfer", "the rent goes out by automatic transfer"],
      embed
    );
    expect(pairs).toEqual([]);
  });
});

// Independent-review regression pins (2026-07-13). Each of these shipped GREEN
// and was still wrong — the review found them with concrete inputs.
describe("detectPairwiseContradictions — notation + polarity (adversarial review)", () => {
  const embed = async (t: string): Promise<readonly number[]> => {
    const lower = t.toLowerCase();
    if (lower.includes("dodgers")) return [0, 1];
    // Opposite-polarity same-statement pairs measure ~0.9 live; same-statement
    // value variants ~0.79; a negated DIFFERENT statement ~0.24.
    const theta = /관리비|different/u.test(lower) ? 1.33 : /not|않|아니|4pm|130/u.test(lower) ? 0.45 : 0;
    return [Math.cos(theta), Math.sin(theta)];
  };

  it("a notation variant (2pm vs 14:00) is NOT a conflict", async () => {
    expect(
      await detectPairwiseContradictions(
        ["The meeting is at 2pm in the main room.", "The meeting is at 14:00 in the main room."],
        embed
      )
    ).toEqual([]);
  });

  it("a Korean myriad/comma notation variant (90만원 vs 900,000원) is NOT a conflict", async () => {
    expect(
      await detectPairwiseContradictions(["월세는 90만원입니다.", "월세는 900,000원입니다."], embed)
    ).toEqual([]);
  });

  it("the correcting phrasing that QUOTES the rival value is still a conflict (superset values)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["월세는 90만원입니다.", "월세는 90만원이 아니라 130만원입니다."],
      embed
    );
    expect(pairs).toHaveLength(1);
  });

  it("qualitative disagreement with NO value tokens is a conflict (polarity)", async () => {
    const pairs = await detectPairwiseContradictions(
      ["We should ship the feature now.", "We should not ship the feature now."],
      embed
    );
    expect(pairs).toHaveLength(1);
  });

  it("a negated sentence on a DIFFERENT statement is NOT a conflict", async () => {
    expect(
      await detectPairwiseContradictions(["월세는 매달 25일에 나가.", "관리비는 포함되지 않아."], embed)
    ).toEqual([]);
  });

  it("'now' does not read as the negation 'no' (word-boundary matching)", async () => {
    // Both affirmative → same polarity → no polarity conflict.
    expect(
      await detectPairwiseContradictions(
        ["We should ship the feature now.", "We should ship the feature now, definitely."],
        embed
      )
    ).toEqual([]);
  });
});
