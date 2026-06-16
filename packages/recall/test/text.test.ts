import { describe, expect, it } from "vitest";

import {
  answerIsPureRefusal,
  answerIsRefusal,
  composeChatSystemContent,
  corpusOnboardingHint,
  formatCorpusOverview,
  formatGraphLinksSection,
  looksLikeBinaryContent,
  queryHasAdHocGrounding,
  shouldSuggestRepair,
  shouldWarmClose,
  shouldWarnStrippedCitations,
  stripEchoedCiteAs,
  suggestOptInSource,
  urlGroundingSource
} from "@muse/recall";

describe("stripEchoedCiteAs", () => {
  it("removes an echoed 'cite as:' label before a real citation", () => {
    expect(stripEchoedCiteAs("MTU 1380. cite as: [from vpn.md]")).toBe("MTU 1380. [from vpn.md]");
  });
  it("leaves text without the echoed label untouched", () => {
    expect(stripEchoedCiteAs("plain [from vpn.md]")).toBe("plain [from vpn.md]");
  });
});

describe("answerIsRefusal", () => {
  it("detects EN and KO refusal phrasing", () => {
    expect(answerIsRefusal("I'm not sure about that")).toBe(true);
    expect(answerIsRefusal("그 정보가 없습니다")).toBe(true);
  });
  it("is false for a grounded answer", () => {
    expect(answerIsRefusal("Your MTU is 1380 [from vpn.md]")).toBe(false);
  });
});

describe("answerIsPureRefusal", () => {
  it("is true for a pure refusal (EN + KO) — nothing to verify", () => {
    expect(answerIsPureRefusal("I'm not sure — that isn't in your notes.")).toBe(true);
    expect(answerIsPureRefusal("I don't have that information.")).toBe(true);
    expect(answerIsPureRefusal("그 정보는 없습니다.")).toBe(true);
  });
  it("is FALSE for a hedge-then-assert (refusal substring + a tacked-on claim)", () => {
    expect(answerIsPureRefusal("I don't have access to live flight data, but your flight leaves at 9:00 AM from Gate 22.")).toBe(false);
    expect(answerIsPureRefusal("I don't have your flight info. Your flight is at 9am from gate 22.")).toBe(false);
    expect(answerIsPureRefusal("없어요. 하지만 회의는 3시예요.")).toBe(false);
  });
  it("catches a hedge joined by an em-dash or a colon (not just sentence/adversative seams)", () => {
    expect(answerIsPureRefusal("I don't have your flight — your flight is at 9am from gate 22.")).toBe(false);
    expect(answerIsPureRefusal("I don't have that info: your meeting is at 3pm in room 5.")).toBe(false);
  });
  it("stays TRUE for a pure refusal whose continuation is itself negative (the seam-split regression guard)", () => {
    // The continuation crosses the new em-dash/colon seam but is a refusal
    // RESTATEMENT (negative), not a tacked-on claim — must stay pure.
    expect(answerIsPureRefusal("I'm not sure — that isn't in your notes.")).toBe(true);
    expect(answerIsPureRefusal("I'm not sure — nothing comes to mind.")).toBe(true);
    expect(answerIsPureRefusal("없어요. 회의 자료는 못 찾았어요.")).toBe(true);
  });
  it("catches a NEGATED fabrication — a negation clause that carries concrete data is still a claim", () => {
    // The negation-skip must not let "…is NOT at 3pm, it's at 4pm" ride through:
    // a negated clause with a digit asserts a (corrected) fact → reach the verdict.
    expect(answerIsPureRefusal("I don't have it, but your meeting is not at 3pm, it is at 4pm in room 5.")).toBe(false);
    expect(answerIsPureRefusal("I'm not sure — your flight isn't at 9am, it's at 11am.")).toBe(false);
  });
  it("catches a NAMED-ENTITY negation→correction with NO digit (fire-42: the digit heuristic's blind spot)", () => {
    // "isn't A, it's B" smuggles a corrected named value past the negation — a
    // real fabrication that previously rode through as pure (no digit to flag it).
    expect(answerIsPureRefusal("I don't have that, but your manager isn't Alice, it's Bob.")).toBe(false);
    expect(answerIsPureRefusal("I'm not sure — your dentist isn't Dr. Park, it's Dr. Kim.")).toBe(false);
    // Comma-only join (no sentence/adversative seam): the refusal marker and the
    // correction share one clause, yet the pivot is still caught.
    expect(answerIsPureRefusal("I'm not certain, your manager isn't Alice, it's Bob.")).toBe(false);
  });
  it("does NOT misfire on a pure refusal whose copula continuation is itself negative/locational", () => {
    // "that's not…" / "it's in your notes" after a negation is a restatement, not
    // a corrective value — must stay pure (no false-drop on the honesty floor).
    expect(answerIsPureRefusal("I'm not sure, that's not something in your notes.")).toBe(true);
    expect(answerIsPureRefusal("I don't have that — it's not in your notes.")).toBe(true);
  });
  it("is false for a non-refusal answer (defers to the verdict)", () => {
    expect(answerIsPureRefusal("Your MTU is 1380 [from vpn.md]")).toBe(false);
  });
});

describe("looksLikeBinaryContent", () => {
  it("flags content with a NUL byte", () => {
    expect(looksLikeBinaryContent(new Uint8Array([72, 0, 73]))).toBe(true);
  });
  it("accepts plain UTF-8 text", () => {
    expect(looksLikeBinaryContent(new TextEncoder().encode("hello world"))).toBe(false);
  });
  it("treats empty input as non-binary", () => {
    expect(looksLikeBinaryContent(new Uint8Array([]))).toBe(false);
  });
});

describe("urlGroundingSource", () => {
  it("returns the host with www stripped", () => {
    expect(urlGroundingSource("https://www.example.com/page")).toBe("example.com");
  });
  it("falls back to the raw string when unparseable", () => {
    expect(urlGroundingSource("not a url")).toBe("not a url");
  });
});

describe("formatGraphLinksSection", () => {
  it("is empty with no links", () => {
    expect(formatGraphLinksSection([])).toBe("");
  });
  it("renders each linked note", () => {
    expect(formatGraphLinksSection(["a", "b"])).toContain("↔ a");
  });
});

describe("formatCorpusOverview", () => {
  it("lists notes and a '… and N more' line when truncated", () => {
    const out = formatCorpusOverview(["a.md", "b.md"], 5);
    expect(out).toContain("You have 5 notes");
    expect(out).toContain("… and 3 more");
  });
});

describe("queryHasAdHocGrounding", () => {
  it("is true when any ad-hoc source is supplied", () => {
    expect(queryHasAdHocGrounding({ url: "https://x.com" })).toBe(true);
    expect(queryHasAdHocGrounding({ clipboard: true })).toBe(true);
  });
  it("is false with no ad-hoc source", () => {
    expect(queryHasAdHocGrounding({ file: "  " })).toBe(false);
    expect(queryHasAdHocGrounding({})).toBe(false);
  });
});

describe("corpusOnboardingHint", () => {
  it("is undefined when the user has notes or other personal data", () => {
    expect(corpusOnboardingHint(3)).toBeUndefined();
    expect(corpusOnboardingHint(0, true)).toBeUndefined();
  });
  it("gives the on-ramp for a genuinely empty Muse", () => {
    expect(corpusOnboardingHint(0)).toContain("muse demo");
  });
});

describe("shouldWarmClose", () => {
  it("warm-closes a refusal only when the user has notes", () => {
    expect(shouldWarmClose("I'm not sure", 3)).toBe(true);
    expect(shouldWarmClose("I'm not sure", 0)).toBe(false);
    expect(shouldWarmClose("Here is the answer [from a.md]", 3)).toBe(false);
  });
});

describe("composeChatSystemContent", () => {
  it("prepends a non-empty playbook section", () => {
    expect(composeChatSystemContent("SYS", "PLAY")).toBe("PLAY\n\nSYS");
  });
  it("returns the bare system prompt when no playbook", () => {
    expect(composeChatSystemContent("SYS", undefined)).toBe("SYS");
    expect(composeChatSystemContent("SYS", "  ")).toBe("SYS");
  });
});

describe("shouldSuggestRepair", () => {
  it("fires only when the verdict fired, repair wasn't requested, not json, and there is evidence", () => {
    expect(shouldSuggestRepair({ verdictFired: true, repairRequested: false, json: false, evidenceCount: 2 })).toBe(true);
    expect(shouldSuggestRepair({ verdictFired: false, repairRequested: false, json: false, evidenceCount: 2 })).toBe(false);
    expect(shouldSuggestRepair({ verdictFired: true, repairRequested: true, json: false, evidenceCount: 2 })).toBe(false);
    expect(shouldSuggestRepair({ verdictFired: true, repairRequested: false, json: true, evidenceCount: 2 })).toBe(false);
    expect(shouldSuggestRepair({ verdictFired: true, repairRequested: false, json: false, evidenceCount: 0 })).toBe(false);
  });
});

describe("shouldWarnStrippedCitations", () => {
  it("warns only on a non-json, non-action, non-refusal answer that had citations stripped", () => {
    expect(shouldWarnStrippedCitations({ strippedCount: 1, json: false, isActionRequest: false, isRefusal: false })).toBe(true);
    expect(shouldWarnStrippedCitations({ strippedCount: 0, json: false, isActionRequest: false, isRefusal: false })).toBe(false);
    expect(shouldWarnStrippedCitations({ strippedCount: 1, json: true, isActionRequest: false, isRefusal: false })).toBe(false);
    expect(shouldWarnStrippedCitations({ strippedCount: 1, json: false, isActionRequest: false, isRefusal: true })).toBe(false);
  });
});

describe("suggestOptInSource", () => {
  it("tips --git on git intent when git is off, and nothing when already enabled", () => {
    expect(suggestOptInSource("what did I commit yesterday?", { git: false, shell: false })).toContain("--git");
    expect(suggestOptInSource("what did I commit yesterday?", { git: true, shell: false })).toBeUndefined();
  });
  it("tips --shell on shell intent, and nothing for an unrelated query", () => {
    expect(suggestOptInSource("which docker command did I run?", { git: false, shell: false })).toContain("--shell");
    expect(suggestOptInSource("what is my rent?", { git: false, shell: false })).toBeUndefined();
  });
});
