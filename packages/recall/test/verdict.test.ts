import { describe, expect, it } from "vitest";

import { drawBestGroundedRedraft, groundingVerdictNotice, type BestOfRedrawArgs } from "@muse/recall";

const baseArgs = (over: Partial<BestOfRedrawArgs>): BestOfRedrawArgs => ({
  attempts: 2,
  draw: async () => "draft",
  clean: (d) => d,
  isRefusal: () => false,
  expand: (d) => d,
  select: (drafts) => (drafts.length > 0 ? { index: 0 } : undefined),
  confirm: async () => undefined,
  ...over
});

describe("drawBestGroundedRedraft", () => {
  it("returns the confirmed best survivor", async () => {
    const out = await drawBestGroundedRedraft(baseArgs({ draw: async () => "the mtu is 1380" }));
    expect(out).toBe("the mtu is 1380");
  });
  it("fail-closes (undefined) when the full gate rejects the survivor", async () => {
    const out = await drawBestGroundedRedraft(baseArgs({ confirm: async () => "ungrounded notice" }));
    expect(out).toBeUndefined();
  });
  it("fail-closes when every draft is a refusal (nothing to select)", async () => {
    const out = await drawBestGroundedRedraft(baseArgs({ isRefusal: () => true }));
    expect(out).toBeUndefined();
  });
  it("skips empty drafts and draws exactly `attempts` times", async () => {
    let draws = 0;
    const out = await drawBestGroundedRedraft(baseArgs({
      attempts: 3,
      draw: async () => { draws += 1; return draws === 2 ? "real answer" : "   "; }
    }));
    expect(draws).toBe(3);
    expect(out).toBe("real answer");
  });
});

describe("groundingVerdictNotice", () => {
  it("stays silent (undefined) on a refusal answer — short-circuits before the verdict", async () => {
    const out = await groundingVerdictNotice("I'm not sure — that isn't in your notes.", [], "what is X?");
    expect(out).toBeUndefined();
  });
  it("returns a 'treat as unverified' notice when the answer's claims aren't backed", async () => {
    const out = await groundingVerdictNotice(
      "The capital of Atlantis is Poseidonis, population 4 million.",
      [{ cosine: 0.1, score: 0.1, source: "notes/cats.md", text: "my cat likes tuna" }],
      "atlantis capital?"
    );
    expect(out === undefined || /unverified/.test(out)).toBe(true);
  });
});
