import { describe, expect, it } from "vitest";

import { buildNoteContextBlock } from "./context-blocks.js";
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

  it("a conflict between an UNTRUSTED ingested note and the user's OWN note names the external one and says prefer your own (NP ask-path parity)", () => {
    const chunks = [
      chunk("the budget is $1250", `${notesDir}/mine.md`, 0.9), // note 1 — the user's own
      chunk("the budget is $9999", `${notesDir}/web/evil.md`, 0.85) // note 2 — externally ingested
    ];
    const contradictions: readonly ContradictionPair[] = [{ aIndex: 1, bIndex: 0, topicSim: 0.9 }];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir, new Set(["web/evil.md"]));
    // The marker sits on the UNTRUSTED note (note 2, aIndex 1) and points at note 1 (the user's own).
    const note2Section = block.split("<<note 2")[1] ?? "";
    expect(note2Section).toContain("EXTERNAL/UNVERIFIED");
    expect(note2Section).toContain("prefer note 1");
    expect(note2Section).not.toContain("treat as possibly-conflicting"); // NOT the neutral marker
  });

  it("the reverse direction: when the marker sits on the user's OWN note and the conflicting partner is the untrusted one, it names the partner external and says prefer THIS note", () => {
    const chunks = [
      chunk("the budget is $9999", `${notesDir}/web/evil.md`, 0.85), // note 1 — externally ingested
      chunk("the budget is $1250", `${notesDir}/mine.md`, 0.9) // note 2 — the user's own
    ];
    const contradictions: readonly ContradictionPair[] = [{ aIndex: 1, bIndex: 0, topicSim: 0.9 }];
    const block = buildNoteContextBlock(chunks, contradictions, notesDir, new Set(["web/evil.md"]));
    const note2Section = block.split("<<note 2")[1] ?? "";
    expect(note2Section).toContain("note 1 is from an EXTERNAL/UNVERIFIED source");
    expect(note2Section).toContain("prefer THIS note");
  });

  it("two TRUSTED notes conflicting keep the NEUTRAL marker (no false external label)", () => {
    const chunks = [
      chunk("the budget is $1250", `${notesDir}/a.md`, 0.9),
      chunk("the budget is $1350", `${notesDir}/b.md`, 0.85)
    ];
    const contradictions: readonly ContradictionPair[] = [{ aIndex: 1, bIndex: 0, topicSim: 0.9 }];
    // untrustedNoteSources present but neither note is in it → neutral marker.
    const block = buildNoteContextBlock(chunks, contradictions, notesDir, new Set(["web/evil.md"]));
    expect(block).toContain("treat as possibly-conflicting");
    expect(block).not.toContain("EXTERNAL/UNVERIFIED");
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
