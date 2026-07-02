import type { KnowledgeMatch } from "@muse/agent-core";
import { reportCitationPrecision, reportCitationRecall, stripCitationMarkers, untrustedOnlySentences } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

const m = (text: string, source: string, trusted = true): KnowledgeMatch =>
  ({ score: 0.8, source, text, trusted } as KnowledgeMatch);

// The ask/chat prompts teach ELEVEN citation-marker kinds ([from <file>] plus
// [feed|task|event|reminder|session|contact|command|commit|memory|action: …]),
// but the recall/precision/trust diagnostics recognized only [from …] — so a
// visibly-cited "[memory: favorite_language]" answer fired a false "carries no
// citation" warning on the flagship recall path (found by a live product probe).

describe("citation-recall recognizes every citation-marker kind", () => {
  const evidence = [
    m("favorite_language: TypeScript — the user's preferred programming language.", "memory"),
    m("Reminder: take your vitamins every morning.", "reminder:1")
  ];

  it("a [memory: …]-cited claim counts as CITED (no false 'carries no citation' warning)", () => {
    const report = reportCitationRecall("Your favorite programming language is TypeScript [memory: favorite_language].", evidence);
    expect(report.uncited).toEqual([]);
    expect(report.citedCount).toBe(report.citableCount);
  });

  it("a [reminder: …]-cited claim counts as CITED", () => {
    const report = reportCitationRecall("You take your vitamins every morning [reminder: take your vitamins].", evidence);
    expect(report.uncited).toEqual([]);
  });

  it("REGRESSION GUARD: a genuinely uncited claim is still flagged", () => {
    const report = reportCitationRecall("Your favorite programming language is TypeScript.", evidence);
    expect(report.uncited).toHaveLength(1);
  });
});

describe("stripCitationMarkers strips every marker kind", () => {
  it("removes [from …] and [<kind>: …] alike", () => {
    const text = "TypeScript [memory: favorite_language] and the VPN MTU is 1380 [from vpn.md] due tomorrow [task: ship the deck].";
    const stripped = stripCitationMarkers(text);
    expect(stripped).not.toContain("[memory:");
    expect(stripped).not.toContain("[from");
    expect(stripped).not.toContain("[task:");
    expect(stripped).toContain("TypeScript");
    expect(stripped).toContain("1380");
  });
});

describe("citation-precision masks non-[from] markers without pairing them", () => {
  const matches = [m("The WireGuard VPN MTU is 1380 to prevent packet fragmentation.", "vpn.md")];

  it("a [memory: …]-only citation yields no pairs (kind-specific resolution is the verdict's job)", () => {
    const report = reportCitationPrecision("Your favorite language is TypeScript [memory: favorite_language].", matches);
    expect(report.pairs).toEqual([]);
    expect(report.precision).toBe(1);
    expect(report.unsupported).toEqual([]);
  });

  it("[from …] pairing still works, and a mixed sentence pairs ONLY the [from] citation", () => {
    const report = reportCitationPrecision(
      "The VPN MTU is 1380 to prevent packet fragmentation [from vpn.md] [memory: vpn_mtu].",
      matches
    );
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]!.source).toBe("vpn.md");
    expect(report.pairs[0]!.supported).toBe(true);
  });

  it("a non-[from] marker's internal punctuation cannot split the sentence", () => {
    const report = reportCitationPrecision(
      "The VPN MTU is 1380 [session: talked about vpn.md tuning yesterday] [from vpn.md].",
      matches
    );
    expect(report.pairs).toHaveLength(1);
  });
});

describe("untrusted-sentences ignores non-[from] markers (masked, never trust-paired)", () => {
  it("a [memory: …]-cited sentence is not flagged; an untrusted [from …] still is", () => {
    const matches = [
      m("favorite_language: TypeScript.", "memory"),
      m("Claim scraped from the web.", "web:page", false)
    ];
    const answer =
      "Your favorite language is TypeScript [memory: favorite_language]. The scraped claim says X [from web:page].";
    const flagged = untrustedOnlySentences(answer, matches);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("scraped claim");
    expect(flagged[0]).not.toContain("TypeScript");
  });
});
