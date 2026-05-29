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
});
