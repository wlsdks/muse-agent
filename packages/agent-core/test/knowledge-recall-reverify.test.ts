import { describe, expect, it } from "vitest";

import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  segmentClaims,
  verifyGroundingPerClaim,
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

describe("verifyGroundingWithReverify — coverage-only failure escalation (cross-lingual, fail-close)", () => {
  // A confident retrieval with a VALID citation but low lexical coverage — the
  // shape a correct cross-lingual answer takes (Korean prose over English
  // evidence). The deterministic core fails it on coverage; the judge decides.
  const matches = [match("notes/net.md", "The office WiFi password is hunter2-blue.", 0.72)];
  const correctKr = "당신의 와이파이 비밀번호는 hunter2-blue입니다 [from notes/net.md].";
  const wrongKr = "당신의 와이파이 비밀번호는 dragon99-red입니다 [from notes/net.md].";
  const krQuery = "내 와이파이 비밀번호";

  it("escalates the coverage failure and upholds a correct cross-lingual answer to GROUNDED", async () => {
    const out = await verifyGroundingWithReverify(correctKr, matches, krQuery, async () => true);
    expect(out.verdict).toBe("grounded");
    expect(out.reason).toContain("low coverage");
  });

  it("escalates but a WRONG cross-lingual value stays UNGROUNDED when the judge rejects it", async () => {
    const out = await verifyGroundingWithReverify(wrongKr, matches, krQuery, async () => false);
    expect(out.verdict).toBe("ungrounded");
  });

  it("fail-closes to the original ungrounded verdict when the judge errors (no silent upgrade)", async () => {
    const out = await verifyGroundingWithReverify(correctKr, matches, krQuery, async () => {
      throw new Error("judge unreachable");
    });
    expect(out.verdict).toBe("ungrounded");
  });

  it("does NOT escalate a coverage failure whose citation is INVALID (cites an unretrieved source)", async () => {
    const out = await verifyGroundingWithReverify(
      "당신의 와이파이 비밀번호는 hunter2-blue입니다 [from notes/other.md].",
      matches,
      krQuery,
      never
    );
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

  it("escalates a GROUNDED answer asserting a WRONG EMAIL DOMAIN and demotes it on an unsupported judge verdict", async () => {
    const matches = [match("notes/contacts.md", "Jane Park leads sales; her email is jane@globex.com.", 0.72)];
    const out = await verifyGroundingWithReverify("Jane Park's email is jane@acme.com [from notes/contacts.md].", matches, "what is Jane Park's email", async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("does NOT escalate a GROUNDED answer whose email matches the evidence verbatim", async () => {
    const matches = [match("notes/contacts.md", "Jane Park leads sales; her email is jane@globex.com.", 0.72)];
    const out = await verifyGroundingWithReverify("Jane Park's email is jane@globex.com [from notes/contacts.md].", matches, "what is Jane Park's email", never);
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

describe("segmentClaims — atomic claims for per-claim grounding (Self-RAG ISSUP)", () => {
  it("splits a clausal 'and' (right side carries a value) into TWO claims", () => {
    expect(segmentClaims("Mina owns pricing and the budget was 2,000,000 KRW")).toEqual([
      "Mina owns pricing",
      "the budget was 2,000,000 KRW"
    ]);
  });

  it("does NOT split a short noun list ('Sarah and Bob report to Mina') — one claim", () => {
    expect(segmentClaims("Sarah and Bob report to Mina")).toEqual(["Sarah and Bob report to Mina"]);
  });

  it("splits sentences on terminal punctuation, keeping each whole", () => {
    expect(segmentClaims("Alice owns the roadmap. The launch is on August 14.")).toEqual([
      "Alice owns the roadmap.",
      "The launch is on August 14."
    ]);
  });

  it("keeps a [citation] marker attached to its clause", () => {
    expect(segmentClaims("The rent is 900,000 KRW [from notes] and the lease ends in December [from lease]")).toEqual([
      "The rent is 900,000 KRW [from notes]",
      "the lease ends in December [from lease]"
    ]);
  });

  it("returns [] for empty / whitespace and one claim for a single statement", () => {
    expect(segmentClaims("   ")).toEqual([]);
    expect(segmentClaims("The meeting is at 3pm")).toEqual(["The meeting is at 3pm"]);
  });
});

describe("verifyGroundingWithReverify — sentence-opener stoplist (connectives not treated as named entities)", () => {
  // Answer with a sentence-opener + a citation + strong token overlap so the
  // base verdict reaches `grounded`. If "However" / "Based" / "Therefore" were
  // treated as named entities the value-escalation path would fire (they are
  // absent from the evidence); with the stoplist they are ignored.
  const mtuMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];

  it("does NOT escalate when the answer starts with 'However' but the number is supported", async () => {
    const out = await verifyGroundingWithReverify(
      "However, the office VPN MTU is 1380 on wg0 [from notes/vpn.md].",
      mtuMatches, query, async () => false
    );
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT escalate when the answer starts with 'Based' but the number is supported", async () => {
    const out = await verifyGroundingWithReverify(
      "Based on your notes, the office VPN MTU is 1380 on wg0 [from notes/vpn.md].",
      mtuMatches, query, async () => false
    );
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT escalate when the answer starts with 'Therefore' but the number is supported", async () => {
    const out = await verifyGroundingWithReverify(
      "Therefore the office VPN MTU is 1380 on wg0 [from notes/vpn.md].",
      mtuMatches, query, async () => false
    );
    expect(out.verdict).toBe("grounded");
  });

  it("still escalates (genuine wrong named entity) when a proper noun is absent from evidence", async () => {
    // Identical token coverage but wrong entity — reaches `grounded` on coverage
    // then the value-escalation path fires because "Patel" ∉ evidence tokens.
    const contactMatches = [match("notes/contacts.md", "The office contact lead engineer is Dr. Kim at the office.", 0.72)];
    const out = await verifyGroundingWithReverify(
      "The office contact lead engineer is Dr. Patel [from notes/contacts.md].",
      contactMatches, "who is the lead engineer", async () => false
    );
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("still escalates (number drift) when the answer asserts a number absent from evidence", async () => {
    const out = await verifyGroundingWithReverify("The office VPN MTU is 9000 on wg0 [from notes/vpn.md].", mtuMatches, query, async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("still escalates (email drift) when the answer asserts a wrong email domain", async () => {
    const emailMatches = [match("notes/contacts.md", "Jane Park leads sales; her email is jane@globex.com.", 0.72)];
    const out = await verifyGroundingWithReverify("Jane Park leads sales; her email is jane@acme.com [from notes/contacts.md].", emailMatches, "what is Jane's email", async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });

  it("does NOT escalate when the entity 'Stark' is present in evidence", async () => {
    const starkMatches = [match("notes/user.md", "Stark is the user with admin access on the system.", 0.72)];
    const out = await verifyGroundingWithReverify("Stark is the user with admin access [from notes/user.md].", starkMatches, "who is the user", async () => false);
    expect(out.verdict).toBe("grounded");
  });
});

describe("verifyGroundingPerClaim — surgically drop only the unsupported claim", () => {
  const ev = [match("notes", "Mina owns pricing. The budget is unspecified.", 0.9)];

  it("KEEPS the supported claim and DROPS the unsupported one with an honest note", async () => {
    const judge = async ({ answer }: { answer: string }) => !answer.toLowerCase().includes("budget");
    const out = await verifyGroundingPerClaim("Mina owns pricing and the budget was 2,000,000 KRW", ev, "who owns what?", judge);
    expect(out.dropped).toBe(1);
    expect(out.answer).toContain("Mina owns pricing");
    expect(out.answer).toContain("I'm not sure about: the budget was 2,000,000 KRW");
    // the dropped clause is NOT asserted as fact — the value appears ONLY inside the disclaimer
    expect(out.answer.split("I'm not sure about:")[0]).not.toContain("2,000,000");
  });

  it("returns a FULLY-supported answer untouched", async () => {
    const out = await verifyGroundingPerClaim("Mina owns pricing and the team is three people", ev, "q", async () => true);
    expect(out.dropped).toBe(0);
    expect(out.answer).toBe("Mina owns pricing and the team is three people");
  });

  it("a single-claim answer is returned untouched without calling the judge", async () => {
    let calls = 0;
    const out = await verifyGroundingPerClaim("Mina owns pricing", ev, "q", async () => { calls += 1; return false; });
    expect(out.answer).toBe("Mina owns pricing");
    expect(out.dropped).toBe(0);
    expect(calls).toBe(0);
  });

  it("FAILS OPEN on a judge error — keeps the claim rather than dropping a possibly-true clause", async () => {
    const out = await verifyGroundingPerClaim("Mina owns pricing and the budget was 2,000,000 KRW", ev, "q", async () => { throw new Error("judge down"); });
    expect(out.dropped).toBe(0);
    expect(out.answer).toContain("2,000,000");
  });
});
