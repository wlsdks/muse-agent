import { type KnowledgeMatch } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { citationPrecisionNotice, citationRecallNotice, sourceCheckSignals, untrustedFeedMatch, untrustedOnlyGroundingNotice } from "./grounding-notices.js";

const match = (source: string, text: string, cosine: number, trusted?: boolean): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text,
  ...(trusted === undefined ? {} : { trusted })
});

describe("untrustedOnlyGroundingNotice", () => {
  it("warns when a faithful answer resolves ONLY to untrusted tool-fetched sources", () => {
    const matches = [match("tool: web_search", "The capital of France is Paris.", 1, false)];
    const notice = untrustedOnlyGroundingNotice("The capital of France is Paris [from tool: web_search].", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched");
  });

  it("stays silent for an answer grounded only in the user's own notes", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    expect(untrustedOnlyGroundingNotice("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches)).toBeUndefined();
  });

  it("surfaces a per-claim untrusted source in a MIXED answer — whole-answer gate clears on a trusted note, but one claim rests only on tool data", () => {
    const matches = [
      match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72), // trusted note
      match("tool: web_search", "Paris is the capital of France.", 1, false) // untrusted tool source
    ];
    const answer = "Set the VPN MTU to 1380 on wg0 [from notes/vpn.md]. Paris is the capital of France [from tool: web_search].";
    const notice = untrustedOnlyGroundingNotice(answer, matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("one claim rests only on tool-fetched data"); // the per-claim notice, not the whole-answer one
    expect(notice).toContain("Paris is the capital of France"); // the specific untrusted claim is surfaced
  });

  it("STILL warns when the answer OMITS the [from <src>] citation but ALL evidence is tool-fetched (citation-independent — the 8B may not cite)", () => {
    const matches = [match("tool: web_search", "The capital of France is Paris.", 1, false)];
    // No [from ...] marker — grounded via content overlap without emitting a citation.
    const notice = untrustedOnlyGroundingNotice("The capital of France is Paris.", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched");
  });

  it("does NOT warn on a non-citing answer when a trusted note is in the evidence pool (not structurally tool-only)", () => {
    const matches = [
      match("notes/geo.md", "Paris is the capital of France.", 0.7),
      match("tool: web_search", "Paris is the capital of France.", 1, false)
    ];
    expect(untrustedOnlyGroundingNotice("Paris is the capital of France.", matches)).toBeUndefined();
  });

  it("does NOT warn on a non-citing answer with NO evidence (nothing to rest on)", () => {
    expect(untrustedOnlyGroundingNotice("Paris is the capital of France.", [])).toBeUndefined();
  });

  it("does NOT warn on an EMPTY answer even when evidence is all tool-fetched (no claim to scrutinize)", () => {
    expect(untrustedOnlyGroundingNotice("   ", [match("tool: web_search", "x", 1, false)])).toBeUndefined();
  });

  it("does NOT warn on a REFUSAL answer even when evidence is all tool-fetched (a non-answer rests on nothing — parity with the chat abstention guard)", () => {
    expect(untrustedOnlyGroundingNotice("I'm not sure about that.", [match("tool: web_search", "x", 1, false)])).toBeUndefined();
  });
});

describe("untrustedFeedMatch — external feed evidence is tagged trusted:false (grounded≠true: a poisonable RSS/Atom headline isn't the user's own data)", () => {
  it("tags the feed match trusted:false with the canonical source + title(+summary) text", () => {
    expect(untrustedFeedMatch("TechBlog", "Acme acquires Beta")).toEqual({
      cosine: 1,
      score: 1,
      source: "feed: TechBlog",
      text: "Acme acquires Beta",
      trusted: false
    });
    expect(untrustedFeedMatch("TechBlog", "Acme acquires Beta", "for $1B").text).toBe("Acme acquires Beta for $1B");
  });

  it("makes a faithful answer resting ONLY on a feed headline trip the untrusted-only source-check cue", () => {
    const matches = [untrustedFeedMatch("TechBlog", "Acme acquired Beta for $1B")];
    const notice = untrustedOnlyGroundingNotice("Acme acquired Beta for $1B [from feed: TechBlog].", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched"); // the untrusted-only cue
  });

  it("is cleared by a single trusted note in the pool (a feed-backed claim alongside the user's own data is not untrusted-ONLY)", () => {
    const matches = [
      { cosine: 0.7, score: 0.7, source: "notes/deals.md", text: "Acme acquired Beta for $1B." }, // trusted (no flag)
      untrustedFeedMatch("TechBlog", "Acme acquired Beta for $1B")
    ];
    expect(untrustedOnlyGroundingNotice("Acme acquired Beta for $1B [from notes/deals.md].", matches)).toBeUndefined();
  });
});

describe("sourceCheckSignals — the machine twin of the source-check cues (grounded≠true on the --json/run-log surface)", () => {
  it("flags untrustedOnly when a faithful answer rests only on a feed/tool source", () => {
    const matches = [untrustedFeedMatch("TechBlog", "Acme acquired Beta for $1B")];
    expect(sourceCheckSignals("Acme acquired Beta for $1B [from feed: TechBlog].", matches)).toEqual({
      untrustedOnly: true,
      citationUnsupported: false,
      citationUncited: false
    });
  });

  it("flags citationUnsupported when a cited source doesn't support its claim", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    const signals = sourceCheckSignals("The office MTU is 1380 [from vpn.md]. The flight departs from gate twelve [from vpn.md].", matches);
    expect(signals?.citationUnsupported).toBe(true);
  });

  it("flags citationUncited when a groundable claim carries no citation", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    expect(sourceCheckSignals("The office MTU is 1380.", matches)?.citationUncited).toBe(true);
  });

  it("returns undefined when every source-check is clean (no --json noise on a clean grounded answer)", () => {
    const matches = [match("notes/vpn.md", "Set the office VPN MTU to 1380 on wg0.", 0.72)];
    expect(sourceCheckSignals("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches)).toBeUndefined();
  });

  it("agrees with the human cues — fires the structured signal exactly when a notice would (no drift)", () => {
    const matches = [untrustedFeedMatch("TechBlog", "Acme acquired Beta for $1B")];
    const answer = "Acme acquired Beta for $1B [from feed: TechBlog].";
    const noticeFired = untrustedOnlyGroundingNotice(answer, matches) !== undefined;
    expect(Boolean(sourceCheckSignals(answer, matches))).toBe(noticeFired);
  });
});

describe("citationPrecisionNotice", () => {
  it("warns when a cited source resolves but does not support its sentence", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    const notice = citationPrecisionNotice("The office MTU is 1380 [from vpn.md]. The flight departs from gate twelve [from vpn.md].", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("Citation check");
  });

  it("stays silent when every cited source supports its sentence", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    expect(citationPrecisionNotice("The office MTU is 1380 [from vpn.md].", matches)).toBeUndefined();
  });
});

describe("citationRecallNotice", () => {
  it("warns when a citable claim carries no citation", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    const notice = citationRecallNotice("The office MTU is 1380.", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("Attribution check");
  });

  it("stays silent when the citable claim carries its citation", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    expect(citationRecallNotice("The office MTU is 1380 [from vpn.md].", matches)).toBeUndefined();
  });
});
