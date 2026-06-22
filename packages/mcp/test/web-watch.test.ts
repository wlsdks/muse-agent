import { describe, expect, it } from "vitest";

import { detectWatchTrigger } from "@muse/proactivity";

describe("detectWatchTrigger — appears (rising edge)", () => {
  it("fires when the term newly appears, not while it persists", () => {
    expect(detectWatchTrigger("Out of stock", "In stock now", { appears: "in stock" }).triggered).toBe(true);
    expect(detectWatchTrigger("In stock now", "Still in stock", { appears: "in stock" }).triggered).toBe(false);
  });

  it("fires on first observation if the term is already present (no baseline)", () => {
    const t = detectWatchTrigger(undefined, "In stock now", { appears: "in stock" });
    expect(t.triggered).toBe(true);
    expect(t.reason).toContain("appeared");
  });

  it("does not fire when the term is absent", () => {
    expect(detectWatchTrigger("Out of stock", "Sold out", { appears: "in stock" }).triggered).toBe(false);
  });
});

describe("detectWatchTrigger — disappears (falling edge)", () => {
  it("fires when a term that WAS present goes away; needs a baseline", () => {
    expect(detectWatchTrigger("Status: processing", "Status: shipped", { disappears: "processing" }).triggered).toBe(true);
    expect(detectWatchTrigger(undefined, "Status: shipped", { disappears: "processing" }).triggered).toBe(false); // no baseline
    expect(detectWatchTrigger("Status: processing", "Still processing", { disappears: "processing" }).triggered).toBe(false);
  });
});

describe("detectWatchTrigger — onAnyChange + edge cases", () => {
  it("fires on any content change vs the baseline, never on first observation", () => {
    expect(detectWatchTrigger("v1", "v2", { onAnyChange: true }).triggered).toBe(true);
    expect(detectWatchTrigger("v1", "v1", { onAnyChange: true }).triggered).toBe(false);
    expect(detectWatchTrigger(undefined, "v1", { onAnyChange: true }).triggered).toBe(false); // baseline
  });

  it("a rule with no condition never fires", () => {
    expect(detectWatchTrigger("a", "b", {}).triggered).toBe(false);
  });

  it("case-insensitive by default; opt out with caseInsensitive:false", () => {
    expect(detectWatchTrigger("X", "PRICE DROPPED", { appears: "price dropped" }).triggered).toBe(true);
    expect(detectWatchTrigger("X", "PRICE DROPPED", { appears: "price dropped", caseInsensitive: false }).triggered).toBe(false);
  });
});
