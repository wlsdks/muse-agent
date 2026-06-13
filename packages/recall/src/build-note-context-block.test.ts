import { describe, expect, it } from "vitest";

import { buildNoteContextBlock } from "./present.js";
import type { ContradictionPair } from "@muse/agent-core";

// Stub note chunk as the <<note>> block builder expects.
function chunk(text: string, file: string, score: number) {
  return { chunk: { text }, file, score };
}

describe("buildNoteContextBlock — assembled-path contradiction annotation", () => {
  const notesDir = "/home/user/.muse/notes";

  it("non-conflicting corpus produces NO ⚠ marker (clean normal answers stay clean)", () => {
    const chunks = [
      chunk("my flight leaves at 3pm from gate 12", `${notesDir}/travel.md`, 0.9),
      chunk("remember to bring sunscreen and a hat", `${notesDir}/packing.md`, 0.7)
    ];
    const block = buildNoteContextBlock(chunks, [], notesDir);
    expect(block).not.toContain("⚠");
    expect(block).toContain("<<note 1 — travel.md>>");
    expect(block).toContain("<<note 2 — packing.md>>");
  });

  it("conflicting corpus: the aIndex note gets the NEUTRAL ⚠ marker referencing bIndex", () => {
    const chunks = [
      chunk("my flight leaves at 3pm from gate 12", `${notesDir}/travel.md`, 0.9),
      chunk("my flight leaves at 6pm from gate 12", `${notesDir}/update.md`, 0.8)
    ];
    const contradictions: readonly ContradictionPair[] = [
      { aIndex: 0, bIndex: 1, topicSim: 0.92 }
    ];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir);

    // The marker is NEUTRAL — no recency claim.
    expect(block).toContain("[⚠ this note and note 2 give DIFFERENT values for what looks like the same point — treat as possibly-conflicting; do not assume either is current]");
    expect(block).not.toContain("more recent");
    expect(block).not.toContain("newer");
    expect(block).not.toContain("recent value");
    // aIndex note (note 1) gets the marker.
    expect(block).toContain("<<note 1 — travel.md>>");
    // bIndex note (note 2) has NO marker.
    const note2Section = block.split("<<note 2")[1] ?? "";
    expect(note2Section).not.toContain("⚠");
  });

  it("ADDITIVE: both notes still appear when a contradiction is flagged — never drops", () => {
    const chunks = [
      chunk("my flight leaves at 3pm from gate 12", `${notesDir}/travel.md`, 0.9),
      chunk("my flight leaves at 6pm from gate 12", `${notesDir}/update.md`, 0.8)
    ];
    const contradictions: readonly ContradictionPair[] = [
      { aIndex: 0, bIndex: 1, topicSim: 0.92 }
    ];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir);
    // Both note texts present.
    expect(block).toContain("3pm");
    expect(block).toContain("6pm");
    // Both wrappers present.
    expect(block).toContain("<<note 1 — travel.md>>");
    expect(block).toContain("<<note 2 — update.md>>");
    expect(block).toContain("[from travel.md]");
    expect(block).toContain("[from update.md]");
  });

  it("zero chunks → returns the unavailable string, no crash", () => {
    const block = buildNoteContextBlock([], [], notesDir);
    expect(block).toBe("(no relevant notes found)");
  });

  it("single chunk + no contradictions → no marker", () => {
    const chunks = [
      chunk("my flight leaves at 3pm from gate 12", `${notesDir}/travel.md`, 0.9)
    ];
    const block = buildNoteContextBlock(chunks, [], notesDir);
    expect(block).toContain("<<note 1 — travel.md>>");
    expect(block).not.toContain("⚠");
  });

  it("marker references the correct other note number by position (aIndex=1 → references bIndex+1=1)", () => {
    // aIndex=1, bIndex=0 — note 2 (index 1) gets the marker referencing note 1 (bIndex+1=1)
    const chunks = [
      chunk("my flight leaves at 6pm from gate 12", `${notesDir}/old.md`, 0.8),
      chunk("my flight leaves at 3pm from gate 12", `${notesDir}/new.md`, 0.9)
    ];
    const contradictions: readonly ContradictionPair[] = [
      { aIndex: 1, bIndex: 0, topicSim: 0.90 }
    ];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir);
    // Note 2 (index 1, new.md) gets the marker referencing note 1 (bIndex+1=1).
    expect(block).toContain("[⚠ this note and note 1 give DIFFERENT values for what looks like the same point — treat as possibly-conflicting; do not assume either is current]");
    // Marker has no recency claim.
    expect(block).not.toContain("more recent");
    // Note 1 (old.md) has no marker.
    const note1Section = block.split("<<note 1")[1]?.split("<<note 2")[0] ?? "";
    expect(note1Section).not.toContain("⚠");
  });

  it("marker does NOT contain 'more recent', 'newer', or 'recent value'", () => {
    const chunks = [
      chunk("the budget is $1250", `${notesDir}/budget-old.md`, 0.8),
      chunk("the budget is $1350", `${notesDir}/budget-new.md`, 0.9)
    ];
    const contradictions: readonly ContradictionPair[] = [
      { aIndex: 0, bIndex: 1, topicSim: 0.91 }
    ];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir);
    expect(block).toContain("⚠");
    expect(block).not.toContain("more recent");
    expect(block).not.toContain("newer");
    expect(block).not.toContain("recent value");
    expect(block).toContain("do not assume either is current");
  });
});
