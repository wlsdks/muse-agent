import { describe, expect, it } from "vitest";

import { askOutcomeLabel, askWeaknessAxis, createStageTimer, misgroundedOutcome, recordAskWeakness, recordAskWeaknessResolved } from "@muse/recall";

describe("askOutcomeLabel", () => {
  it("maps a refusal to abstain, else passes the verdict through", () => {
    expect(askOutcomeLabel({ refusal: true, verdict: null })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: false, verdict: "grounded" })).toBe("grounded");
    expect(askOutcomeLabel({ refusal: false, verdict: "ungrounded" })).toBe("ungrounded");
    expect(askOutcomeLabel({ refusal: false, verdict: null })).toBeNull();
  });
});

describe("askWeaknessAxis", () => {
  it("prioritises unbacked-action, skips action requests, maps abstain/ungrounded to grounding-gap", () => {
    expect(askWeaknessAxis("abstain", { claimedUnbackedAction: true })).toBe("unbacked-action");
    expect(askWeaknessAxis("abstain", { isActionRequest: true })).toBeNull();
    expect(askWeaknessAxis("abstain")).toBe("grounding-gap");
    expect(askWeaknessAxis("ungrounded")).toBe("grounding-gap");
    expect(askWeaknessAxis("grounded")).toBeNull();
    expect(askWeaknessAxis(null)).toBeNull();
  });
  it("maps a misgrounded outcome to the misgrounding axis (distinct from a grounding-gap, survives an action request, yields to unbacked-action)", () => {
    expect(askWeaknessAxis("misgrounded")).toBe("misgrounding");
    expect(askWeaknessAxis("misgrounded", { isActionRequest: true })).toBe("misgrounding");
    expect(askWeaknessAxis("misgrounded", { claimedUnbackedAction: true })).toBe("unbacked-action");
  });
});

describe("misgroundedOutcome", () => {
  it("downgrades a grounded verdict to misgrounded when the unsupported fraction clears the floor", () => {
    // the gate said grounded, but half-or-more of the answer's sentences are not
    // backed by the cited evidence — a confident misgrounding hiding as a success.
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0.6 })).toBe("misgrounded");
  });
  it("keeps a grounded verdict when the answer is mostly supported", () => {
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0.2 })).toBe("grounded");
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0 })).toBe("grounded");
  });
  it("never relabels a non-grounded outcome (only a confident grounded answer can hide misgrounding)", () => {
    expect(misgroundedOutcome({ outcome: "ungrounded", unsupportedFraction: 1 })).toBe("ungrounded");
    expect(misgroundedOutcome({ outcome: "abstain", unsupportedFraction: 1 })).toBe("abstain");
    expect(misgroundedOutcome({ outcome: null, unsupportedFraction: 1 })).toBeNull();
  });
  it("respects a custom floor", () => {
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0.4, floor: 0.3 })).toBe("misgrounded");
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0.4, floor: 0.5 })).toBe("grounded");
  });
  it("does NOT flag a fully-unsupported answer (fraction 1.0) — that's a measurement artifact (cross-lingual answer vs evidence / heavy paraphrase the lexical probe can't see), not a confident misgrounding which needs PARTIAL grounding", () => {
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 1 })).toBe("grounded");
    // just under 1.0 (some assertive sentence IS supported) still flags
    expect(misgroundedOutcome({ outcome: "grounded", unsupportedFraction: 0.9 })).toBe("misgrounded");
  });
});

describe("createStageTimer", () => {
  it("accumulates per-stage deltas and a total from an injected clock", () => {
    let t = 0;
    const timer = createStageTimer(() => t);
    t = 10; timer.mark("retrieval");
    t = 25; timer.mark("generation");
    const timings = timer.timings();
    expect(timings.retrieval).toBe(10);
    expect(timings.generation).toBe(15);
    expect(timings.totalMs).toBe(25);
  });
});

describe("recordAskWeakness", () => {
  it("records via injected deps for a real axis, and no-ops on null axis / empty query", async () => {
    const calls: unknown[] = [];
    const deps = { recordWeakness: async (file: string, sig: unknown) => { calls.push({ file, sig }); }, weaknessesFile: "/w.json" };
    await recordAskWeakness("why no vpn note?", "grounding-gap", deps, "add a note");
    await recordAskWeakness("x", null, deps);
    await recordAskWeakness("   ", "grounding-gap", deps);
    expect(calls).toHaveLength(1);
  });
  it("swallows a throwing ledger write (never breaks ask)", async () => {
    const deps = { recordWeakness: async () => { throw new Error("disk full"); }, weaknessesFile: "/w.json" };
    await expect(recordAskWeakness("q", "grounding-gap", deps)).resolves.toBeUndefined();
  });
});

describe("recordAskWeaknessResolved", () => {
  it("records a resolved query via injected deps, no-ops on empty", async () => {
    const seen: string[] = [];
    const deps = { recordWeaknessResolved: async (_f: string, q: string) => { seen.push(q); }, weaknessesFile: "/w.json" };
    await recordAskWeaknessResolved("vpn mtu", deps);
    await recordAskWeaknessResolved("  ", deps);
    expect(seen).toEqual(["vpn mtu"]);
  });
});
