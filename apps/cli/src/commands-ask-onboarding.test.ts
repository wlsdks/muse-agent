import { describe, expect, it } from "vitest";

import { corpusOnboardingHint } from "./commands-ask.js";

describe("corpusOnboardingHint — first-run on-ramp for an empty corpus", () => {
  it("returns a hint naming the concrete ways to add notes when the corpus is empty", () => {
    const hint = corpusOnboardingHint(0);
    expect(hint).toBeDefined();
    expect(hint).toMatch(/corpus is empty/i);
    // points at every real on-ramp built for the front door
    expect(hint).toContain("muse demo");
    expect(hint).toContain("--save-to-notes");
    expect(hint).toContain("watch-folder --ingest");
  });

  it("returns undefined once ANY note exists — a normal no-match answer is never cluttered", () => {
    expect(corpusOnboardingHint(1)).toBeUndefined();
    expect(corpusOnboardingHint(42)).toBeUndefined();
  });
});
