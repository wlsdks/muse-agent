import { describe, expect, it } from "vitest";

import { verifyGrounding, type KnowledgeMatch } from "../src/index.js";

const match = (source: string, text: string, cosine: number): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text
});

describe("verifyGrounding — independent multi-criteria rubric verifier", () => {
  it("returns GROUNDED when a confident match covers the query and the answer is backed by it", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];
    const out = verifyGrounding("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches, "what MTU for the office VPN");
    expect(out.verdict).toBe("grounded");
    expect(out.invalidCitations).toEqual([]);
    expect(out.rubric.confidence).toBe(1);
  });

  it("returns UNGROUNDED when nothing was retrieved (empty matches → drop, becomes 'I'm not sure')", () => {
    const out = verifyGrounding("Your flight is at 9am.", [], "when is my flight");
    expect(out.verdict).toBe("ungrounded");
    expect(out.rubric.confidence).toBe(0);
  });

  it("returns UNGROUNDED and names the invalid citation when the answer cites a source that was not retrieved", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.71)];
    const out = verifyGrounding("Your flight is at 9am [from trips/itinerary.md].", matches, "when is my flight");
    expect(out.verdict).toBe("ungrounded");
    expect(out.invalidCitations).toEqual(["trips/itinerary.md"]);
    expect(out.rubric.citationValidity).toBeLessThan(1);
  });

  it("returns UNGROUNDED when the answer makes claims the evidence does not support (low coverage)", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.71)];
    const out = verifyGrounding(
      "Your dentist appointment is Tuesday at 3pm and the rent is due Friday.",
      matches,
      "what MTU for the office VPN"
    );
    expect(out.verdict).toBe("ungrounded");
    expect(out.rubric.coverage).toBeLessThan(0.5);
  });

  it("returns WEAK when the match is only weakly relevant (ambiguous cosine) but the answer is otherwise consistent", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
    const out = verifyGrounding("The VPN MTU is 1380 on wg0 [from notes/vpn.md].", matches, "what MTU for the office VPN");
    expect(out.verdict).toBe("weak");
    expect(out.invalidCitations).toEqual([]);
    expect(out.rubric.confidence).toBe(0.5);
  });

  it("produces every rubric criterion as a number in [0,1]", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.6)];
    const out = verifyGrounding("VPN MTU 1380 [from notes/vpn.md].", matches, "vpn mtu");
    for (const value of [out.rubric.confidence, out.rubric.coverage, out.rubric.answerability, out.rubric.citationValidity]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("does not count a re-cased citation to a real retrieved source as invalid (matched case/space-insensitively)", () => {
    const matches = [match("journal/2026-05-12.md", "Migrated the database to Postgres 16.", 0.7)];
    const out = verifyGrounding("You migrated the DB [from Journal/2026-05-12.MD].", matches, "what did I migrate");
    expect(out.invalidCitations).toEqual([]);
  });
});
