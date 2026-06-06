import { describe, expect, it } from "vitest";

import { peakEndDigest } from "../src/peak-end.js";

describe("peakEndDigest — grounded two-point session summary (peak + end)", () => {
  it("picks the most salient non-final turn as the peak and the last as the end", () => {
    const digest = peakEndDigest([
      { role: "user", content: "hey" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "I decided to move out on June 12 — rent is 1,250,000" }, // salient (number + decided) → PEAK
      { role: "assistant", content: "Got it, noted." } // END
    ]);
    expect(digest).toContain("Peak:");
    expect(digest).toContain("move out on June 12");
    expect(digest).toContain('Ended on: "Got it, noted."');
  });

  it("a single meaningful turn → 'ended on' only", () => {
    expect(peakEndDigest([{ role: "user", content: "just this one thing" }])).toBe('Session ended on: "just this one thing"');
  });

  it("only ever quotes real turns (grounded by construction)", () => {
    const digest = peakEndDigest([
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta important decision" },
      { role: "user", content: "omega" }
    ])!;
    expect(digest).toContain("beta important decision");
    expect(digest).toContain("omega");
  });

  it("returns null when there's nothing to digest", () => {
    expect(peakEndDigest([])).toBeNull();
    expect(peakEndDigest([{ role: "user", content: "   " }])).toBeNull();
  });

  it("clips long turns", () => {
    const long = "x".repeat(300);
    expect(peakEndDigest([{ role: "user", content: long }], 50)).toContain("…");
  });
});
