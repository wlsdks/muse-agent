import { describe, expect, it } from "vitest";

import {
  buildGroundingReverify,
  buildGroundingReverifyPrompt,
  judgeConsensus,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  segmentClaims,
  verifyGroundingPerClaim,
  verifyGroundingWithReverify,
  type KnowledgeMatch
} from "../src/index.js";

describe("buildGroundingReverify — canonical one-shot grounding judge from a minimal provider", () => {
  const provider = (output: string) => ({ generate: async () => ({ output }) });
  it("returns true on a YES verdict (free text) and false on NO — works without structured output", async () => {
    expect(await buildGroundingReverify(provider("YES"), "m")({ answer: "a", evidence: "e", query: "q" })).toBe(true);
    expect(await buildGroundingReverify(provider("NO"), "m")({ answer: "a", evidence: "e", query: "q" })).toBe(false);
  });
  it('also parses a {"supported":true} JSON verdict', async () => {
    expect(await buildGroundingReverify(provider('{"supported":true}'), "m")({ answer: "a", evidence: "e", query: "q" })).toBe(true);
  });
  it("feeds the answer + evidence into the judge prompt (the claim is checked against its source)", async () => {
    let seen = "";
    const capturing = { generate: async (req: { readonly messages: readonly { readonly content: string }[] }) => { seen = req.messages.map((m) => m.content).join("\n"); return { output: "YES" }; } };
    await buildGroundingReverify(capturing, "m")({ answer: "Room B", evidence: "Standup in Room A", query: "q" });
    expect(seen).toContain("Room B");
    expect(seen).toContain("Room A");
  });
});

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

  // DATE drift — the ASK-path counterpart of the chat date guard (fire 31). A calendar/
  // renewal date that drifts by a DAY (the model says Sep 14, the note says Sep 13) is a
  // high-harm value the bare-digit guard misses (the day "14" appears elsewhere in
  // evidence; "September" is stoplisted). Bind month+day as one key across ISO/prose/KO.
  const dateMatches = [match("cal/renewal.md", "Your renewal is on September 13, 2026. There are 14 days left.", 0.72)];
  it("escalates a GROUNDED answer asserting a DRIFTED prose date (Sep 14 vs evidence Sep 13) — day '14' elsewhere in evidence doesn't save it", async () => {
    const out = await verifyGroundingWithReverify("Your renewal is on September 14 [from cal/renewal.md].", dateMatches, "when is my renewal", async () => false);
    expect(out.verdict).toBe("ungrounded");
    expect(out.reason).toContain("value the evidence does not support");
  });
  it("FAIL-OPENS the date escalation: a judge error never demotes (ask-path semantics preserved)", async () => {
    const out = await verifyGroundingWithReverify("Your renewal is on September 14 [from cal/renewal.md].", dateMatches, "when is my renewal", async () => { throw new Error("down"); });
    expect(out.verdict).toBe("grounded");
  });
  it("does NOT escalate a CORRECT date, incl. ISO↔prose equivalence (no false escalation)", async () => {
    const iso = [match("cal/r.md", "Your renewal date is 2026-09-13 on file.", 0.72)];
    const out = await verifyGroundingWithReverify("Your renewal date is September 13 [from cal/r.md].", iso, "when is my renewal date", never);
    expect(out.verdict).toBe("grounded");
  });
  it("escalates a DRIFTED Korean month-day (9월 14일 vs evidence 9월 13일)", async () => {
    const ko = [match("cal/k.md", "갱신일은 9월 13일입니다.", 0.72)];
    const out = await verifyGroundingWithReverify("갱신일은 9월 14일이에요 [from cal/k.md].", ko, "갱신일", async () => false);
    expect(out.verdict).toBe("ungrounded");
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

describe("verifyGroundingPerClaim — suspectClaims pre-filter (MiniCheck, arXiv:2404.10774)", () => {
  const ev = [match("notes", "Mina owns pricing. The budget is unspecified.", 0.9)];

  it("calls judge ONLY on the suspect claim — cap/escalation parity: 1 of 3 claims judged", async () => {
    const claims = "Mina owns pricing. The team is five. The budget was 2,000,000 KRW.";
    let judgeCallCount = 0;
    const judge = async ({ answer }: { answer: string }): Promise<boolean> => {
      judgeCallCount += 1;
      return !answer.toLowerCase().includes("budget");
    };
    // Only the "budget" sentence is suspect; the other two are in the supported set.
    const suspectClaims = new Set(["The budget was 2,000,000 KRW."]);
    const out = await verifyGroundingPerClaim(claims, ev, "who owns what?", judge, { suspectClaims });
    expect(judgeCallCount).toBe(1);
    expect(out.dropped).toBe(1);
    expect(out.answer).toContain("Mina owns pricing");
    expect(out.answer).toContain("I'm not sure about");
  });

  it("back-compat: absent suspectClaims → ALL claims judged (original behavior)", async () => {
    let judgeCallCount = 0;
    const judge = async (): Promise<boolean> => {
      judgeCallCount += 1;
      return true;
    };
    await verifyGroundingPerClaim("Claim one. Claim two. Claim three.", ev, "q", judge);
    expect(judgeCallCount).toBe(3);
  });

  it("all-supported answer with no suspects → ZERO judge calls (the cheap common case)", async () => {
    let judgeCallCount = 0;
    const judge = async (): Promise<boolean> => {
      judgeCallCount += 1;
      return true;
    };
    const suspectClaims = new Set<string>(); // empty — no suspects
    await verifyGroundingPerClaim("Mina owns pricing. The team is three.", ev, "q", judge, { suspectClaims });
    expect(judgeCallCount).toBe(0);
  });

  it("floor monotonicity: the refiner can only drop, never upgrade — output is byte-identical when nothing is dropped", async () => {
    const answer = "Mina owns pricing. The team is three.";
    const judge = async (): Promise<boolean> => true;
    const suspectClaims = new Set<string>();
    const out = await verifyGroundingPerClaim(answer, ev, "q", judge, { suspectClaims });
    expect(out.dropped).toBe(0);
    expect(out.answer).toBe(answer);
  });
});

// --- judgeConsensus pure helper (arXiv:2203.11171 self-consistency; arXiv:2510.27106 intra-rater variance) ---

describe("judgeConsensus — unanimous fail-close aggregator", () => {
  it("unanimous-pass: all-true → true", () => {
    expect(judgeConsensus([true, true, true], "unanimous-pass")).toBe(true);
  });

  it("unanimous-pass: any-false → false", () => {
    expect(judgeConsensus([true, false, true], "unanimous-pass")).toBe(false);
  });

  it("unanimous-pass: empty → false", () => {
    expect(judgeConsensus([], "unanimous-pass")).toBe(false);
  });

  it("unanimous-keep: all-true → true", () => {
    expect(judgeConsensus([true, true], "unanimous-keep")).toBe(true);
  });

  it("unanimous-keep: any-false → false", () => {
    expect(judgeConsensus([true, false], "unanimous-keep")).toBe(false);
  });

  it("unanimous-keep: empty → false", () => {
    expect(judgeConsensus([], "unanimous-keep")).toBe(false);
  });
});

// --- reverifySamples consensus sampling: counterfactual non-vacuity tests ---
// A YES-then-NO fake judge proves that dissent (k=3) yields `ungrounded`
// while a single-sample (k=1) all-YES fake yields `grounded`.

describe("verifyGroundingWithReverify — reverifySamples=3 catches judge dissent (self-consistency gate)", () => {
  // Weak-band fixture: answer and match where base verdict is "weak".
  const weakMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
  const weakAnswer = "The VPN MTU is 1380 on wg0 [from notes/vpn.md].";
  const query = "what MTU for the office VPN";

  it("weak-band: YES-then-NO judge with k=3 → ungrounded (dissent caught)", async () => {
    let calls = 0;
    const yesNo = async () => { calls += 1; return calls === 1; };
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, yesNo, { reverifySamples: 3 });
    expect(out.verdict).toBe("ungrounded");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("weak-band: all-YES judge with k=1 → grounded (back-compat single-sample)", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => true, { reverifySamples: 1 });
    expect(out.verdict).toBe("grounded");
  });

  it("weak-band: all-YES judge with k=3 → grounded (unanimous pass)", async () => {
    let calls = 0;
    const allYes = async () => { calls += 1; return true; };
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, allYes, { reverifySamples: 3 });
    expect(out.verdict).toBe("grounded");
    expect(calls).toBe(3);
  });

  it("weak-band: reverifySamples absent (default 1) → existing behaviour byte-identical", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => true);
    expect(out.verdict).toBe("grounded");
  });

  // Low-coverage branch (cross-lingual fixture): confident retrieval but below coverage floor.
  it("low-coverage: YES-then-NO judge with k=3 → ungrounded (dissent caught)", async () => {
    const lowCovMatches = [match("notes/net.md", "The office WiFi password is hunter2-blue.", 0.72)];
    const krAnswer = "당신의 와이파이 비밀번호는 hunter2-blue입니다 [from notes/net.md].";
    const krQuery = "내 와이파이 비밀번호";
    let calls = 0;
    const yesNo = async () => { calls += 1; return calls === 1; };
    const out = await verifyGroundingWithReverify(krAnswer, lowCovMatches, krQuery, yesNo, { reverifySamples: 3 });
    expect(out.verdict).toBe("ungrounded");
  });

  it("low-coverage: all-YES judge with k=3 → grounded (unanimous pass)", async () => {
    const lowCovMatches = [match("notes/net.md", "The office WiFi password is hunter2-blue.", 0.72)];
    const krAnswer = "당신의 와이파이 비밀번호는 hunter2-blue입니다 [from notes/net.md].";
    const krQuery = "내 와이파이 비밀번호";
    const out = await verifyGroundingWithReverify(krAnswer, lowCovMatches, krQuery, async () => true, { reverifySamples: 3 });
    expect(out.verdict).toBe("grounded");
  });

  // Value-check branch (grounded but asserts unsupported value).
  it("value-check: YES-then-NO judge with k=3 → ungrounded (dissent caught)", async () => {
    const confidentMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];
    const wrongValueAnswer = "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].";
    let calls = 0;
    const yesNo = async () => { calls += 1; return calls === 1; };
    const out = await verifyGroundingWithReverify(wrongValueAnswer, confidentMatches, query, yesNo, { reverifySamples: 3 });
    expect(out.verdict).toBe("ungrounded");
  });

  it("value-check: all-YES judge with k=3 → grounded (unanimous keep)", async () => {
    const confidentMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];
    const wrongValueAnswer = "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].";
    const out = await verifyGroundingWithReverify(wrongValueAnswer, confidentMatches, query, async () => true, { reverifySamples: 3 });
    expect(out.verdict).toBe("grounded");
  });

  it("reverifySamples clamped to 5 (does not exceed 5 calls)", async () => {
    let calls = 0;
    const allYes = async () => { calls += 1; return true; };
    await verifyGroundingWithReverify(weakAnswer, weakMatches, query, allYes, { reverifySamples: 10 });
    expect(calls).toBeLessThanOrEqual(5);
  });

  it("reverifySamples clamped to 1 minimum (0 treated as 1)", async () => {
    let calls = 0;
    const allYes = async () => { calls += 1; return true; };
    await verifyGroundingWithReverify(weakAnswer, weakMatches, query, allYes, { reverifySamples: 0 });
    expect(calls).toBe(1);
  });
});

describe("verifyGroundingWithReverify — empty-evidence fail-close (no judge escalation on '')", () => {
  // A high-cosine match whose TEXT is empty gives confidence>0 but evidence="".
  // The coverage-failure band would otherwise consult the judge on ""; a YES would
  // upgrade a fabricated answer to grounded — the fabrication-floor leak f4 closed
  // for council/reflection, here on the PRIMARY recall/ask/chat gate.
  it("fail-closes to ungrounded WITHOUT consulting the judge when evidence text is empty", async () => {
    const emptyMatch: KnowledgeMatch = { cosine: 0.9, score: 0.9, source: "notes/x.md", text: "" };
    let called = false;
    const out = await verifyGroundingWithReverify(
      "Your flight is at 9am.",
      [emptyMatch],
      "when is my flight",
      async () => { called = true; return true; }
    );
    expect(out.verdict).toBe("ungrounded");
    expect(called).toBe(false);
  });

  it("still consults the judge when there IS real evidence text (guard is empty-only)", async () => {
    const realMatch: KnowledgeMatch = { cosine: 0.5, score: 0.5, source: "notes/vpn.md", text: "The office VPN MTU is 1380 on wg0." };
    let called = false;
    await verifyGroundingWithReverify(
      "The VPN MTU is 1380 on wg0 [from notes/vpn.md].",
      [realMatch],
      "what MTU for the office VPN",
      async () => { called = true; return true; }
    );
    expect(called).toBe(true);
  });
});
