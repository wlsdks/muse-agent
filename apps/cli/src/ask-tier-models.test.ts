import { describe, expect, it } from "vitest";

import { resolveAskTierModels, routeAskTierModel } from "./ask-tier-models.js";

describe("resolveAskTierModels", () => {
  it("falls back to the default model for both tiers when no tier env is set", () => {
    expect(resolveAskTierModels("ollama/gemma4:12b", {})).toEqual({
      fast: "ollama/gemma4:12b",
      heavy: "ollama/gemma4:12b"
    });
  });

  it("treats blank/whitespace tier env as unset (falls back to default)", () => {
    expect(resolveAskTierModels("def", { MUSE_FAST_MODEL: "  ", MUSE_HEAVY_MODEL: "" })).toEqual({
      fast: "def",
      heavy: "def"
    });
  });

  it("trims and uses an explicit tier model when set", () => {
    expect(resolveAskTierModels("def", { MUSE_FAST_MODEL: " fastm ", MUSE_HEAVY_MODEL: "heavym" })).toEqual({
      fast: "fastm",
      heavy: "heavym"
    });
  });
});

describe("routeAskTierModel", () => {
  it("routes to the tier the query classifies into and returns that tier's model", () => {
    const env = { MUSE_FAST_MODEL: "fastm", MUSE_HEAVY_MODEL: "heavym" };
    const routed = routeAskTierModel("what is the capital of France", "def", env);
    expect(routed.model).toBe(routed.tier === "fast" ? "fastm" : "heavym");
  });
});
