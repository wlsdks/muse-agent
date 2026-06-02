import { describe, expect, it } from "vitest";

import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  verifyGroundingWithReverify,
  type KnowledgeMatch
} from "../src/index.js";

describe("REVERIFY_SYSTEM_PROMPT — judges FACTS across a language gap, not wording", () => {
  it("instructs the judge that answer/evidence may be in different languages and to compare values", () => {
    expect(REVERIFY_SYSTEM_PROMPT.toLowerCase()).toContain("different languages");
    // still strict: a value the evidence lacks is unsupported in any language
    expect(REVERIFY_SYSTEM_PROMPT.toLowerCase()).toContain("any language");
  });
});

const match = (source: string, text: string, cosine: number): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text
});

// Force a `weak` base verdict (otherwise-consistent answer over an ambiguous
// cosine, just under the default 0.55 threshold).
const weakMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
const weakAnswer = "The VPN MTU is 1380 on wg0 [from notes/vpn.md].";
const query = "what MTU for the office VPN";

const never = () => {
  throw new Error("reverify must NOT be called when the deterministic core already decides");
};

describe("verifyGroundingWithReverify — test-time re-verification of the weak verdict (fail-close)", () => {
  it("promotes WEAK to GROUNDED when the injected re-verifier judges the answer supported", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => true);
    expect(out.verdict).toBe("grounded");
  });

  it("demotes WEAK to UNGROUNDED when the re-verifier judges the answer unsupported", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => false);
    expect(out.verdict).toBe("ungrounded");
  });

  it("fail-closes WEAK to UNGROUNDED when the re-verifier throws (no silent upgrade on error)", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => {
      throw new Error("model unreachable");
    });
    expect(out.verdict).toBe("ungrounded");
  });

  it("does NOT call the re-verifier when the deterministic core already returns GROUNDED", async () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    const out = await verifyGroundingWithReverify(weakAnswer, matches, query, never);
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT call the re-verifier when the deterministic core already returns UNGROUNDED", async () => {
    const out = await verifyGroundingWithReverify("Your flight is at 9am.", [], "when is my flight", never);
    expect(out.verdict).toBe("ungrounded");
  });
});

describe("verifyGroundingWithReverify — claim-level value escalation (the wrong-value hole, fail-OPEN)", () => {
  // Confident + high-coverage, every citation valid: the deterministic rubric
  // returns `grounded` and never sees that "9000" contradicts the evidence's
  // "1380" — the documented hole that whole-answer coverage can't catch.
  const confidentMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];
  const wrongValueAnswer = "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].";

  it("escalates a GROUNDED answer asserting an unsupported NUMBER and demotes it on an unsupported judge verdict", async () => {
    const out = await verifyGroundingWithReverify(wrongValueAnswer, confidentMatches, query, async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("keeps a GROUNDED answer with an unsupported number when the judge upholds it (a legitimate value)", async () => {
    const out = await verifyGroundingWithReverify(wrongValueAnswer, confidentMatches, query, async () => true);
    expect(out.verdict).toBe("grounded");
  });

  it("FAIL-OPENS the value escalation: a judge error never demotes an otherwise-grounded answer", async () => {
    const out = await verifyGroundingWithReverify(wrongValueAnswer, confidentMatches, query, async () => {
      throw new Error("model unreachable");
    });
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT escalate a GROUNDED answer whose numbers all appear in the evidence", async () => {
    const out = await verifyGroundingWithReverify("The office VPN uses MTU 1380 on wg0 [from notes/vpn.md].", confidentMatches, query, never);
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT escalate a GROUNDED answer that asserts no numbers at all", async () => {
    const matches = [match("notes/owner.md", "Mina owns pricing for the Q3 launch.", 0.72)];
    const out = await verifyGroundingWithReverify("Mina owns pricing [from notes/owner.md].", matches, "who owns pricing", never);
    expect(out.verdict).toBe("grounded");
  });

  it("escalates a GROUNDED answer asserting a WRONG NAMED ENTITY and demotes it on an unsupported judge verdict", async () => {
    const matches = [match("notes/lease.md", "Apartment lease: landlord is Mr. Park, rent due on the 1st.", 0.72)];
    const out = await verifyGroundingWithReverify("Your landlord is Mr. Lee [from notes/lease.md].", matches, "who is my landlord", async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("does NOT escalate a GROUNDED answer whose named entities all appear in the evidence", async () => {
    const matches = [match("notes/lease.md", "Apartment lease: landlord is Mr. Park, rent due on the 1st.", 0.72)];
    const out = await verifyGroundingWithReverify("Your landlord is Mr. Park [from notes/lease.md].", matches, "who is my landlord", never);
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT escalate on a month name in a correct date answer (month/day names are excluded)", async () => {
    const matches = [match("notes/ins.md", "Home insurance renewal date 2026-09-14.", 0.72)];
    const out = await verifyGroundingWithReverify("Your home insurance renewal date is in September [from notes/ins.md].", matches, "when is my home insurance renewal date", never);
    expect(out.verdict).toBe("grounded");
  });
});

describe("parseGroundingReverifyVerdict — deterministic YES/NO parse, fail-close", () => {
  it("treats a clear YES as supported", () => {
    expect(parseGroundingReverifyVerdict("YES — the passage states MTU 1380.")).toBe(true);
  });

  it("treats NO as unsupported", () => {
    expect(parseGroundingReverifyVerdict("NO, the evidence does not mention that.")).toBe(false);
  });

  it("fail-closes an ambiguous or empty model reply to unsupported", () => {
    expect(parseGroundingReverifyVerdict("I'm not certain")).toBe(false);
    expect(parseGroundingReverifyVerdict("")).toBe(false);
  });
});

describe("buildGroundingReverifyPrompt", () => {
  it("includes the answer, the query, and the evidence so a one-shot judge has everything", () => {
    const prompt = buildGroundingReverifyPrompt({
      answer: weakAnswer,
      evidence: weakMatches.map((m) => m.text).join("\n"),
      query
    });
    expect(prompt).toContain(weakAnswer);
    expect(prompt).toContain(query);
    expect(prompt).toContain("MTU 1380");
  });
});
