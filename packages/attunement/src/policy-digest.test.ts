import { describe, expect, it } from "vitest";

import { fingerprintContinuityPolicy } from "./policy-digest.js";

describe("fingerprintContinuityPolicy", () => {
  it("is deterministic and binds every policy field", () => {
    const baseline = {
      detail: "standard" as const,
      nextStep: "direct" as const,
      suppression: "none" as const,
      version: 0
    };
    const digest = fingerprintContinuityPolicy(baseline);

    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintContinuityPolicy({ ...baseline })).toBe(digest);
    expect(fingerprintContinuityPolicy({ ...baseline, detail: "compact" })).not.toBe(digest);
    expect(fingerprintContinuityPolicy({ ...baseline, nextStep: "contextual" })).not.toBe(digest);
    expect(fingerprintContinuityPolicy({
      ...baseline,
      suppression: "acknowledge-previous"
    })).not.toBe(digest);
    expect(fingerprintContinuityPolicy({ ...baseline, version: 1 })).not.toBe(digest);
  });
});
