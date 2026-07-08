import { describe, expect, it } from "vitest";

import { gateChatAnswerGrounding } from "@muse/recall";

describe("gateChatAnswerGrounding — the shared chat grounding gate", () => {
  it("DROPS a sentence whose only citation names a non-retrieved source, then hedges", () => {
    const gate = gateChatAnswerGrounding({
      answer: "Your API key is sk-live-abc123 [from vault.md].",
      evidence: [],
      question: "What is my API key?"
    });
    expect(gate.answer).not.toContain("sk-live-abc123");
    expect(gate.answer).toMatch(/not sure/i);
    expect(gate.strippedCitations).toContain("vault.md");
    expect(gate.groundingVerdict).toBe("ungrounded");
    expect(gate.gated).toBe(true);
  });

  it("passes a citation that resolves to real evidence through UNCHANGED (no over-gating)", () => {
    const answer = "The office wifi password is muse2026 [from office.md].";
    const gate = gateChatAnswerGrounding({
      answer,
      evidence: [{ source: "office.md", text: "The office wifi password is muse2026." }],
      question: "What is the office wifi password?"
    });
    expect(gate.answer).toBe(answer);
    expect(gate.strippedCitations).toEqual([]);
    expect(gate.gated).toBe(false);
    expect(gate.groundingVerdict).toBe("grounded");
  });

  it("resolves (keeps, not strips) a citation against a path-form grounding source", () => {
    const answer = "The VPN endpoint is vpn.example.com [from vpn-setup.md].";
    const gate = gateChatAnswerGrounding({
      answer,
      evidence: [{ source: "/home/u/notes/network/vpn-setup.md", text: "VPN endpoint: vpn.example.com" }],
      question: "What is the VPN endpoint?"
    });
    // The citation resolves (the claim survives, nothing stripped) — a tolerant hit
    // may be rewritten to the canonical source form, which is correct, not fabrication.
    expect(gate.strippedCitations).toEqual([]);
    expect(gate.answer).toContain("vpn.example.com");
    expect(gate.answer).toContain("vpn-setup.md");
  });

  it("leaves a plain, un-cited general answer untouched (content downgrade is citation-driven only)", () => {
    const answer = "Sure — a haiku has three lines of five, seven, and five syllables.";
    const gate = gateChatAnswerGrounding({ answer, evidence: [], question: "How many lines in a haiku?" });
    expect(gate.answer).toBe(answer);
    expect(gate.gated).toBe(false);
  });
});
