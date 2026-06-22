import { describe, expect, it } from "vitest";

import { createWebWatchRunner, detectWatchTrigger, webWatchesFromConfig, type ProactiveNoticeSink, type WebWatch } from "@muse/proactivity";

describe("detectWatchTrigger — numeric below/above threshold (price-drop alert)", () => {
  it("below fires on the rising edge of crossing under, not every poll while under", () => {
    const rule = { below: 40, extract: "Price: \\$(\\d+)" };
    // 42 → not below; no baseline change yet.
    expect(detectWatchTrigger("Price: $45", "Price: $42", rule).triggered).toBe(false);
    // 42 → 39: crosses below 40 → fire.
    expect(detectWatchTrigger("Price: $42", "Price: $39", rule).triggered).toBe(true);
    // 39 → 38: still below, was already below → no re-fire.
    expect(detectWatchTrigger("Price: $39", "Price: $38", rule).triggered).toBe(false);
    // 38 → 41: back above → no fire (only fires on the downward crossing).
    expect(detectWatchTrigger("Price: $38", "Price: $41", rule).triggered).toBe(false);
  });

  it("above mirrors below — fires when the value newly exceeds the threshold", () => {
    const rule = { above: 100, extract: "(\\d+) in stock" };
    expect(detectWatchTrigger("80 in stock", "95 in stock", rule).triggered).toBe(false);
    expect(detectWatchTrigger("95 in stock", "120 in stock", rule).triggered).toBe(true);
    expect(detectWatchTrigger("120 in stock", "130 in stock", rule).triggered).toBe(false);
  });

  it("parses thousands separators and ignores surrounding noise", () => {
    const rule = { below: 1500 };
    expect(detectWatchTrigger("$1,699.00", "Now $1,299.00 — limited", rule).triggered).toBe(true);
  });

  it("no parseable number → no fire (degrades, never throws)", () => {
    const rule = { below: 40, extract: "Price: \\$(\\d+)" };
    expect(detectWatchTrigger("Price: $50", "Sold out", rule).triggered).toBe(false);
  });

  it("first observation already below → fires (the user learns it's under now)", () => {
    expect(detectWatchTrigger(undefined, "Price: $35", { below: 40 }).triggered).toBe(true);
    expect(detectWatchTrigger(undefined, "Price: $45", { below: 40 }).triggered).toBe(false);
  });
});

describe("webWatchesFromConfig — parses numeric below/above as a firing condition", () => {
  it("a below-only rule is a valid condition (not dropped) and fires end-to-end on the price drop", async () => {
    let i = 0;
    const bodies = ["<b>Price: $45</b> ad#1", "<b>Price: $44</b> ad#2", "<b>Price: $38</b> ad#3"];
    const fetchImpl = (async () => new Response(bodies[Math.min(i++, bodies.length - 1)]!, { status: 200 })) as unknown as typeof globalThis.fetch;

    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "deal", message: "Price dropped under $40!", rule: { below: 40, extract: "Price: \\$(\\d+)" }, title: "Deal", url: "https://shop.test/x" }]),
      { fetchImpl, retryOptions: { baseDelayMs: 0, sleep: async () => {} } }
    );
    expect(watches).toHaveLength(1);

    const delivered: { title: string; text: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createWebWatchRunner({ sink, watches: watches as WebWatch[] });
    expect((await runner.tick()).delivered).toBe(0); // 45 baseline
    expect((await runner.tick()).delivered).toBe(0); // 44 still above
    expect((await runner.tick()).delivered).toBe(1); // 38 → under 40 → fire
    expect(delivered[0]!.text).toContain("Price dropped under $40");
  });

  it("a non-finite below is ignored, leaving an otherwise-conditionless rule dropped", () => {
    const watches = webWatchesFromConfig(JSON.stringify([
      { id: "bad", message: "m", rule: { below: "cheap" }, title: "t", url: "https://x.test" },
      { id: "ok", message: "m", rule: { below: 40 }, title: "t", url: "https://x.test" }
    ]));
    expect(watches.map((w) => w.id)).toEqual(["ok"]);
  });
});
