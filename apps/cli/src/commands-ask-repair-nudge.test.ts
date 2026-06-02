import { describe, expect, it } from "vitest";

import { shouldSuggestRepair } from "./commands-ask.js";

describe("shouldSuggestRepair — surface --repair only when it can actually help", () => {
  const base = { evidenceCount: 2, json: false, repairRequested: false, verdictFired: true };

  it("suggests it on an ungrounded answer with retrieved evidence and no --repair yet", () => {
    expect(shouldSuggestRepair(base)).toBe(true);
  });

  it("stays silent when the grounding verdict did NOT fire (a clean cited answer)", () => {
    expect(shouldSuggestRepair({ ...base, verdictFired: false })).toBe(false);
  });

  it("stays silent when --repair was already requested (it ran, no tip needed)", () => {
    expect(shouldSuggestRepair({ ...base, repairRequested: true })).toBe(false);
  });

  it("stays silent under --json (no prose tips in structured output)", () => {
    expect(shouldSuggestRepair({ ...base, json: true })).toBe(false);
  });

  it("stays silent with NO retrieved evidence — repair would just refuse, so the tip would mislead", () => {
    expect(shouldSuggestRepair({ ...base, evidenceCount: 0 })).toBe(false);
  });
});
