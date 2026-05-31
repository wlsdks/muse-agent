import { describe, expect, it } from "vitest";

import { notesGroundingFraming } from "./commands-ask.js";

const chunk = (file: string, text: string, score: number) => ({ chunk: { chunkIndex: 0, embedding: [], file, text }, file, score });

describe("notesGroundingFraming — CRAG gate on muse ask notes grounding", () => {
  it("CONFIDENT (top cosine ≥ ~0.61) → plain cite header, no weak-match guidance", () => {
    const f = notesGroundingFraming([chunk("policy.md", "renewal 2026-09-14", 0.72), chunk("misc.md", "x", 0.30)]);
    expect(f.verdict).toBe("confident");
    expect(f.header).toContain("top relevant chunks");
    expect(f.guidance).toBeUndefined();
  });

  it("AMBIGUOUS (notes exist but top cosine < ~0.61) → LOW-confidence header + don't-cite-as-fact guidance", () => {
    const f = notesGroundingFraming([chunk("near.md", "loosely related", 0.42)]);
    expect(f.verdict).toBe("ambiguous");
    expect(f.header).toContain("LOW confidence");
    expect(f.guidance).toContain("WEAK matches");
    expect(f.guidance).toContain("say you are not sure");
  });

  it("NONE (no chunks) → verdict none, plain header (the 'no relevant notes' block shows separately)", () => {
    const f = notesGroundingFraming([]);
    expect(f.verdict).toBe("none");
    expect(f.header).toContain("top relevant chunks");
    expect(f.guidance).toBeUndefined();
  });

  describe("lexical-strength upgrade — a strong keyword match rescues a sub-threshold cosine from a false LOW flag", () => {
    it("UPGRADES ambiguous→confident when a grounded chunk strongly matches the query's keywords (nomic compresses cosine)", () => {
      // cosine 0.50 alone is "ambiguous", but the chunk shares MTU/WireGuard/VPN
      // with the query — the corpus genuinely covers it, so it must not be flagged LOW.
      const f = notesGroundingFraming(
        [chunk("vpn.md", "WireGuard VPN MTU is 1380 to avoid fragmentation", 0.50)],
        "What MTU did I set for the WireGuard VPN?"
      );
      expect(f.verdict).toBe("confident");
      expect(f.header).toContain("top relevant chunks");
      expect(f.guidance).toBeUndefined();
    });

    it("does NOT upgrade a must-refuse question (no shared content tokens) → stays LOW, fabrication=0 preserved", () => {
      const f = notesGroundingFraming(
        [chunk("investor.md", "runway and burn rate for the next raise", 0.50)],
        "What's my sister's birthday?"
      );
      expect(f.verdict).toBe("ambiguous");
      expect(f.header).toContain("LOW confidence");
    });

    it("does NOT upgrade on a single shared token (needs ≥2 distinct content-token matches)", () => {
      const f = notesGroundingFraming(
        [chunk("vpn.md", "WireGuard tunnel config notes", 0.50)],
        "What MTU did I pick?" // shares only nothing strong: 'mtu','pick' vs note → 0–1 overlap
      );
      expect(f.verdict).toBe("ambiguous");
    });
  });
});
