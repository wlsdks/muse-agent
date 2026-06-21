import { describe, expect, it } from "vitest";

import { COMMITMENT_DEDUP_COSINE, collapseNearDuplicateCommitments, detectUserCommitments, selectDischargedCommitments } from "../src/commitment-detector.js";
import type { UserCommitment } from "../src/commitment-detector.js";

describe("detectUserCommitments — rule-only, conservative (EN + KO)", () => {
  it("captures explicit English 'I need/have/got to' commitments as high confidence", () => {
    const found = detectUserCommitments([
      "I need to email Bob about the Q3 report.",
      "Also I have to finish the slides by Friday",
      "I've got to renew my passport"
    ]);
    expect(found.map((c) => c.text)).toEqual([
      "email Bob about the Q3 report",
      "finish the slides by Friday",
      "renew my passport"
    ]);
    expect(found.every((c) => c.confidence === "high")).toBe(true);
  });

  it("marks softer 'I should' as low confidence", () => {
    const [c] = detectUserCommitments(["I should call the dentist"]);
    expect(c).toMatchObject({ text: "call the dentist", confidence: "low", kind: "should" });
  });

  it("captures the common stated-intent forms: I'll / I will / I'm going to / gonna", () => {
    expect(detectUserCommitments(["I'll call the dentist tomorrow."])[0]).toMatchObject({ text: "call the dentist tomorrow", kind: "will", confidence: "high" });
    expect(detectUserCommitments(["I will finish the Q3 report by Friday."])[0]).toMatchObject({ text: "finish the Q3 report by Friday", kind: "will" });
    expect(detectUserCommitments(["I'm going to review the PR this afternoon."])[0]).toMatchObject({ text: "review the PR this afternoon", kind: "will" });
    expect(detectUserCommitments(["I'm gonna pick up groceries later."])[0]).toMatchObject({ text: "pick up groceries later", kind: "will" });
  });

  it("does NOT fire on a stative 'I'll be …' / 'I'll see' remark, or a 'Will I …?' question", () => {
    expect(detectUserCommitments(["I'll be late to the meeting."])).toHaveLength(0);
    expect(detectUserCommitments(["I'll see."])).toHaveLength(0);
    expect(detectUserCommitments(["Will I make it on time?"])).toHaveLength(0);
  });

  it("captures Korean 해야/하기로 했 commitments", () => {
    const found = detectUserCommitments([
      "내일 회의 자료 준비해야 해",
      "그 사람한테 연락하기로 했어"
    ]);
    expect(found.map((c) => c.kind)).toEqual(["ko-haeya", "ko-plan"]);
    expect(found[0]?.text).toContain("회의 자료 준비");
    expect(found[1]?.text).toContain("연락");
  });

  it("does NOT fire on statements with no commitment", () => {
    expect(detectUserCommitments(["I love this", "what time is it?", "그건 별로야"])).toEqual([]);
  });

  it("does NOT capture a NEGATED intent as a commitment (no nag about what the user won't do)", () => {
    expect(detectUserCommitments(["I will not email Bob about this."])).toEqual([]);
    expect(detectUserCommitments(["I'll never use that vendor again."])).toEqual([]);
    expect(detectUserCommitments(["I should not ship it tonight."])).toEqual([]);
    // a real commitment whose action merely CONTAINS "not" later is unaffected
    expect(detectUserCommitments(["I need to note the address"])).toHaveLength(1);
  });

  it("does NOT mistake a question for a commitment", () => {
    expect(detectUserCommitments(["Do I need to call the dentist?"])).toEqual([]);
    expect(detectUserCommitments(["Why do I have to do this?"])).toEqual([]);
    expect(detectUserCommitments(["I need to call the dentist?"])).toEqual([]);
    // the same words as a plain statement still fire
    expect(detectUserCommitments(["I need to call the dentist"])).toHaveLength(1);
  });

  it("skips a non-string or blank turn without crashing, still capturing the real one", () => {
    // Persisted turns can arrive malformed (a corrupt history blob, a null
    // hole). `matchAll` on a non-string throws — the typeof/empty guard must
    // skip those defensively rather than blow up the whole detector pass.
    const turns = [null, 123, "", "   ", "I need to email Bob"] as unknown as string[];
    const found = detectUserCommitments(turns);
    expect(found.map((c) => c.text)).toEqual(["email Bob"]);
  });

  it("keeps a minimal two-character commitment clause (the length floor is `< 2`, not `<= 2`)", () => {
    // The capture group requires ≥2 chars; a clause that resolves to exactly
    // two ("go") is a real commitment and must NOT be dropped by an
    // off-by-one floor.
    const [c] = detectUserCommitments(["I need to go."]);
    expect(c).toMatchObject({ text: "go", kind: "need-to" });
  });

  it("skips an inverted question even with NO trailing '?' (interrogative prefix in the 12 chars before)", () => {
    // The match[2] === "?" guard only catches clauses that END in "?". An
    // inverted question whose terminator is a period ("Do I need to ship it.")
    // is still a question, caught only by the INTERROGATIVE_PREFIX scan of the
    // window *before* the match — which depends on `index - 12`, not `+ 12`.
    expect(detectUserCommitments(["Do I need to ship it."])).toEqual([]);
    expect(detectUserCommitments(["Should I have to wait."])).toEqual([]);
    // control: the same clause with no interrogative lead-in still fires
    expect(detectUserCommitments(["I need to ship it."])).toHaveLength(1);
  });

  it("dedupes the same commitment and caps the count", () => {
    const dup = detectUserCommitments(["I need to water the plants", "I need to water the plants"]);
    expect(dup).toHaveLength(1);

    const many = Array.from({ length: 20 }, (_, i) => `I need to do task number ${i.toString()}`);
    expect(detectUserCommitments(many, { maxCommitments: 5 })).toHaveLength(5);
  });
});

// --- collapseNearDuplicateCommitments (SemDeDup, arXiv:2303.09540) ---

function makeCommitment(text: string, confidence: "high" | "low" = "low"): UserCommitment {
  return { text, confidence, kind: "need-to" };
}

// Stub embedder: maps specific texts to fixed vectors.
function makeStubEmbed(map: Record<string, readonly number[]>): (text: string) => Promise<readonly number[]> {
  return async (text: string): Promise<readonly number[]> => {
    const v = map[text];
    if (!v) throw new Error(`stub: no vector for "${text}"`);
    return v;
  };
}

describe("collapseNearDuplicateCommitments — SemDeDup semantic dedup", () => {
  // Near-dup pair: very similar vectors (cos≈1.0, well above 0.86).
  const nearA = [1, 0.1, 0];
  const nearB = [0.98, 0.12, 0.02]; // cos with nearA ≈ 0.999
  // Orthogonal pair: completely different topics (cos=0).
  const orthoA = [1, 0, 0];
  const orthoB = [0, 1, 0];

  it("collapses near-duplicate pair and keeps the HIGH-confidence representative", async () => {
    const low = makeCommitment("email Bob the report", "low");
    const high = makeCommitment("email Bob about the report", "high");
    const embed = makeStubEmbed({
      "email Bob the report": nearA,
      "email Bob about the report": nearB
    });
    const result = await collapseNearDuplicateCommitments([low, high], embed);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(high);
  });

  it("keeps the EARLIER/shorter form when confidence is tied", async () => {
    const first = makeCommitment("email Bob", "high");
    const second = makeCommitment("email Bob soon", "high");
    const embed = makeStubEmbed({
      "email Bob": nearA,
      "email Bob soon": nearB
    });
    const result = await collapseNearDuplicateCommitments([first, second], embed);
    expect(result).toHaveLength(1);
    // First item is the rep since it comes earlier and confidence is tied.
    expect(result[0]).toBe(first);
  });

  it("NON-over-collapse: keeps BOTH distinct commitments (orthogonal vectors)", async () => {
    const a = makeCommitment("email Bob", "high");
    const b = makeCommitment("call the dentist", "high");
    const embed = makeStubEmbed({
      "email Bob": orthoA,
      "call the dentist": orthoB
    });
    const result = await collapseNearDuplicateCommitments([a, b], embed);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });

  it("threshold counterfactual: raising threshold above the pair cosine → both survive", async () => {
    const a = makeCommitment("email Bob the report", "low");
    const b = makeCommitment("email Bob about the report", "low");
    const embed = makeStubEmbed({
      "email Bob the report": nearA,
      "email Bob about the report": nearB
    });
    // With default threshold they would collapse; raise it to 0.9999 → no collapse.
    const result = await collapseNearDuplicateCommitments([a, b], embed, { threshold: 0.9999 });
    expect(result).toHaveLength(2);
  });

  it("fail-soft: throwing embedder → input returned unchanged", async () => {
    const a = makeCommitment("email Bob", "high");
    const b = makeCommitment("call the dentist", "high");
    const throwingEmbed = async (_text: string): Promise<readonly number[]> => { throw new Error("network"); };
    const result = await collapseNearDuplicateCommitments([a, b], throwingEmbed);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });

  it("fail-soft: zero-norm (empty) vector → cos=0 → no collapse", async () => {
    const a = makeCommitment("email Bob", "high");
    const b = makeCommitment("email Bob the report", "low");
    // Both return [] which cosineSimilarity treats as 0.
    const zeroEmbed = async (_text: string): Promise<readonly number[]> => [];
    const result = await collapseNearDuplicateCommitments([a, b], zeroEmbed);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });

  it("SUBTRACTIVE: every output element is === an element from the input (no rewritten text)", async () => {
    const a = makeCommitment("email Bob", "high");
    const b = makeCommitment("email Bob about the report", "low");
    const c = makeCommitment("call the dentist", "high");
    const embed = makeStubEmbed({
      "email Bob": nearA,
      "email Bob about the report": nearB,
      "call the dentist": orthoB
    });
    const inputs = [a, b, c];
    const result = await collapseNearDuplicateCommitments(inputs, embed);
    for (const item of result) {
      expect(inputs).toContain(item);
    }
  });

  it("empty input → empty output", async () => {
    const embed = makeStubEmbed({});
    const result = await collapseNearDuplicateCommitments([], embed);
    expect(result).toHaveLength(0);
  });

  it("single item → returned unchanged", async () => {
    const a = makeCommitment("email Bob", "high");
    const embed = makeStubEmbed({ "email Bob": orthoA });
    const result = await collapseNearDuplicateCommitments([a], embed);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  it("exports COMMITMENT_DEDUP_COSINE = 0.86", () => {
    expect(COMMITMENT_DEDUP_COSINE).toBe(0.86);
  });
});

describe("selectDischargedCommitments — cross-session auto-discharge (π-Bench arXiv:2605.14678)", () => {
  const VOCAB = ["email", "bob", "report", "dentist", "appointment", "weekend"] as const;
  const stubEmbed = async (text: string): Promise<readonly number[]> => {
    const lower = text.toLowerCase();
    return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
  };
  const scheduled = [{ commitment: "email Bob the report", id: "c1" }];

  it("cancels a standing check-in the user reports done this session (marker AND cosine)", async () => {
    expect(await selectDischargedCommitments(scheduled, ["done, I emailed Bob the report"], stubEmbed)).toEqual(["c1"]);
  });

  it("does NOT cancel on an UNRELATED discharge (marker present, but cosine too low)", async () => {
    expect(await selectDischargedCommitments(scheduled, ["finished — called the dentist for my appointment"], stubEmbed)).toEqual([]);
  });

  it("does NOT cancel without a discharge MARKER (a future intent is not a discharge)", async () => {
    expect(await selectDischargedCommitments(scheduled, ["I will email Bob the report tomorrow"], stubEmbed)).toEqual([]);
  });

  it("fail-soft: a throwing embedder discharges nothing (keep every check-in)", async () => {
    const boom = async (): Promise<readonly number[]> => { throw new Error("embedder down"); };
    expect(await selectDischargedCommitments(scheduled, ["done, I emailed Bob the report"], boom)).toEqual([]);
  });
});
