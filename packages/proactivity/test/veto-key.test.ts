import { describe, expect, it } from "vitest";

import { isVetoed, kindOf, vetoKeyFor } from "../src/veto-key.js";

describe("kindOf", () => {
  it("returns everything before the first ':'", () => {
    expect(kindOf("pattern-firing:tod:mon:9-12:journal")).toBe("pattern-firing");
    expect(kindOf("followup:fu-1")).toBe("followup");
  });

  it("returns the input unchanged when there is no ':'", () => {
    expect(kindOf("followup")).toBe("followup");
  });
});

describe("isVetoed", () => {
  it("matches an EXACT sourceKey", () => {
    const avoided = new Set(["pattern-firing:pat-1"]);
    expect(isVetoed(avoided, "pattern-firing:pat-1")).toBe(true);
    expect(isVetoed(avoided, "pattern-firing:pat-2")).toBe(false);
  });

  it("also matches at the KIND level (a kind-only veto silences every instance)", () => {
    const avoided = new Set(["followup"]);
    expect(isVetoed(avoided, "followup:fu-1")).toBe(true);
    expect(isVetoed(avoided, "followup:fu-2")).toBe(true);
    expect(isVetoed(avoided, "background-exit:p1")).toBe(false);
  });

  it("undefined avoidedSources never vetoes anything", () => {
    expect(isVetoed(undefined, "followup:fu-1")).toBe(false);
  });
});

describe("vetoKeyFor", () => {
  it("records the INSTANCE key verbatim for a recurring source (pattern-firing, ambient-notice, commitment-checkin)", () => {
    expect(vetoKeyFor("pattern-firing:tod:mon:9-12:journal")).toBe("pattern-firing:tod:mon:9-12:journal");
    expect(vetoKeyFor("ambient-notice:standup-rule")).toBe("ambient-notice:standup-rule");
    expect(vetoKeyFor("commitment-checkin:renew my passport")).toBe("commitment-checkin:renew my passport");
  });

  it("records just the KIND for a one-shot source whose id never recurs (followup, background-exit)", () => {
    expect(vetoKeyFor("followup:fu-1")).toBe("followup");
    expect(vetoKeyFor("background-exit:p1")).toBe("background-exit");
  });
});
