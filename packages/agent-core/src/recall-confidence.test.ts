import { describe, expect, it } from "vitest";

import { classifyRetrievalConfidence } from "./recall-confidence.js";

// Build ranked matches from raw cosines (classifyRetrievalConfidence reads
// `cosine ?? score` and sorts internally, so order here is irrelevant).
const m = (...cosines: number[]) =>
  cosines.map((cosine, i) => ({ source: `s${i}.md`, text: `t${i}`, cosine, score: cosine }));

describe("classifyRetrievalConfidence", () => {
  it("returns none on an empty retrieval", () => {
    expect(classifyRetrievalConfidence([])).toBe("none");
  });

  it("a top clearly above the bar is confident", () => {
    expect(classifyRetrievalConfidence(m(0.7, 0.3))).toBe("confident");
  });

  it("a borderline-confident top with a flat distribution is demoted to ambiguous", () => {
    expect(classifyRetrievalConfidence(m(0.57, 0.55))).toBe("ambiguous");
  });

  // --- default OFF: every shared caller is unchanged (fire-5 blast-radius fix) ---

  it("DEFAULT OFF: a sub-bar top with a strong margin stays ambiguous (no promotion)", () => {
    // music-like: top 0.50 (< 0.55), margin 0.255 — WITHOUT opt-in must NOT promote,
    // so proactive/council/notes keep their old thresholds.
    expect(classifyRetrievalConfidence(m(0.5, 0.245))).toBe("ambiguous");
  });

  // --- OPT-IN: only a caller passing promoteOnMargin gets the rescue ---

  it("OPT-IN: a sub-bar top above the floor WITH a strong margin is promoted", () => {
    expect(classifyRetrievalConfidence(m(0.5, 0.245), { promoteOnMargin: true })).toBe("confident");
  });

  it("OPT-IN FABRICATION GUARD: a sub-bar top with a WEAK margin stays ambiguous (flat = absent-like)", () => {
    expect(classifyRetrievalConfidence(m(0.5, 0.42), { promoteOnMargin: true })).toBe("ambiguous");
  });

  it("OPT-IN HARD FLOOR: a sub-floor top stays ambiguous even with a strong margin", () => {
    expect(classifyRetrievalConfidence(m(0.4, 0.1), { promoteOnMargin: true })).toBe("ambiguous");
  });

  it("OPT-IN real absents stay abstaining (measured fabrication cases)", () => {
    // company-name absent: top 0.346, margin 0.009 ; movie absent: 0.341, margin 0.113
    expect(classifyRetrievalConfidence(m(0.346, 0.337), { promoteOnMargin: true })).toBe("ambiguous");
    expect(classifyRetrievalConfidence(m(0.341, 0.228), { promoteOnMargin: true })).toBe("ambiguous");
  });

  it("OPT-IN real under-confidence positives are rescued (measured golden-set values)", () => {
    expect(classifyRetrievalConfidence(m(0.465, 0.259), { promoteOnMargin: true })).toBe("confident"); // coffee
    expect(classifyRetrievalConfidence(m(0.515, 0.286), { promoteOnMargin: true })).toBe("confident"); // dentist
  });

  it("OPT-IN FAIL-SAFE: a RAISED bar suppresses promotion (override may only raise abstention)", () => {
    expect(classifyRetrievalConfidence(m(0.5, 0.2), { promoteOnMargin: true, confidentAt: 0.8 })).toBe("ambiguous");
    // …and with the default bar the same top IS promoted (rescue still works)
    expect(classifyRetrievalConfidence(m(0.5, 0.2), { promoteOnMargin: true })).toBe("confident");
  });
});
