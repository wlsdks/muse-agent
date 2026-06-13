import { describe, expect, it } from "vitest";

import { askOutcomeLabel, askWeaknessAxis, createStageTimer, recordAskWeakness, recordAskWeaknessResolved } from "@muse/recall";

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
