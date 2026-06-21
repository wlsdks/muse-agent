import { describe, expect, it } from "vitest";
import { classifyTier, planTieredRun, shouldEscalateToHeavy } from "../src/index.js";

const MODELS = { fast: "ollama/qwen3:1.7b", heavy: "ollama/qwen3:8b" } as const;

describe("classifyTier", () => {
  it("routes simple lookups to the fast tier", () => {
    expect(classifyTier("what is the capital of France")).toBe("fast");
    expect(classifyTier("what time is it in Tokyo")).toBe("fast");
    expect(classifyTier("convert 5 km to miles")).toBe("fast");
    expect(classifyTier("define entropy")).toBe("fast");
    expect(classifyTier("몇 시야 지금")).toBe("fast");
  });

  it("routes reasoning to the heavy tier", () => {
    expect(classifyTier("analyze the trade-offs between REST and gRPC")).toBe("heavy");
    expect(classifyTier("why does my code segfault")).toBe("heavy");
    expect(classifyTier("design a caching strategy")).toBe("heavy");
    expect(classifyTier("explain step by step how TLS works")).toBe("heavy");
    expect(classifyTier("두 방법을 비교해줘")).toBe("heavy");
  });

  it("defaults to heavy when unsure — never silently downgrades reasoning", () => {
    expect(classifyTier("the quarterly numbers and what they imply for us")).toBe("heavy");
    expect(classifyTier("")).toBe("heavy");
  });

  it("keeps a task with BOTH signals on heavy (reasoning wins)", () => {
    // "define" is a lookup signal but "strategy" is a reasoning signal —
    // the reasoning-first ordering must keep this heavy.
    expect(classifyTier("define a strategy to cut latency")).toBe("heavy");
  });
});

describe("planTieredRun", () => {
  const tasks = [
    { id: "a", text: "what is the capital of France" },
    { id: "b", text: "analyze the trade-offs between REST and gRPC" }
  ];

  it("assigns each task to its tier's model and runs parallel when the host holds both tiers", async () => {
    const plan = await planTieredRun({ canHoldBothTiers: () => true, models: MODELS, tasks });
    expect(plan.collapsedToHeavy).toBe(false);
    expect(plan.mode).toBe("parallel");
    expect(plan.assignments).toEqual([
      { id: "a", model: "ollama/qwen3:1.7b", tier: "fast" },
      { id: "b", model: "ollama/qwen3:8b", tier: "heavy" }
    ]);
  });

  it("collapses to the single heavy model sequentially when the host cannot hold both", async () => {
    const plan = await planTieredRun({ canHoldBothTiers: () => false, models: MODELS, tasks });
    expect(plan.collapsedToHeavy).toBe(true);
    expect(plan.mode).toBe("sequential");
    expect(plan.assignments.every((a) => a.model === "ollama/qwen3:8b" && a.tier === "heavy")).toBe(true);
    expect(new Set(plan.assignments.map((a) => a.model)).size).toBe(1);
  });

  it("fails open to single-heavy when the capacity probe throws (never downgrades to fast on probe error)", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => { throw new Error("probe unavailable"); },
      models: MODELS,
      tasks
    });
    expect(plan.collapsedToHeavy).toBe(true);
    expect(plan.mode).toBe("sequential");
    expect(plan.assignments.every((a) => a.model === "ollama/qwen3:8b")).toBe(true);
  });

  it("cascade: a fast task with a KNOWN low fast-pass confidence escalates to heavy", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => true,
      models: MODELS,
      priorConfidence: new Map([["a", -2.0]]), // below default −1.0
      tasks
    });
    // task "a" classified fast but escalates; task "b" was heavy already
    expect(plan.assignments).toEqual([
      { id: "a", model: "ollama/qwen3:8b", tier: "heavy" },
      { id: "b", model: "ollama/qwen3:8b", tier: "heavy" }
    ]);
  });

  it("cascade: a fast task with HIGH fast-pass confidence stays fast (no needless escalation)", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => true,
      models: MODELS,
      priorConfidence: new Map([["a", -0.2]]), // above default −1.0
      tasks
    });
    expect(plan.assignments[0]).toEqual({ id: "a", model: "ollama/qwen3:1.7b", tier: "fast" });
  });

  it("cascade: undefined/absent fast-pass confidence escalates (safe direction)", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => true,
      models: MODELS,
      priorConfidence: new Map([["a", undefined]]),
      tasks
    });
    expect(plan.assignments[0]).toEqual({ id: "a", model: "ollama/qwen3:8b", tier: "heavy" });
  });

  it("cascade: a task ABSENT from priorConfidence is untouched — byte-identical to no map", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => true,
      models: MODELS,
      priorConfidence: new Map([["b", -2.0]]), // only b present; a not eligible
      tasks
    });
    expect(plan.assignments[0]).toEqual({ id: "a", model: "ollama/qwen3:1.7b", tier: "fast" });
  });

  it("cascade: honours an escalateThreshold override", async () => {
    const plan = await planTieredRun({
      canHoldBothTiers: () => true,
      escalateThreshold: -0.1, // strict: even −0.2 now escalates
      models: MODELS,
      priorConfidence: new Map([["a", -0.2]]),
      tasks
    });
    expect(plan.assignments[0].tier).toBe("heavy");
  });
});

describe("shouldEscalateToHeavy", () => {
  it("escalates a below-threshold (low) confidence and keeps an above-threshold one", () => {
    expect(shouldEscalateToHeavy(-2.0)).toBe(true); // < −1.0 default
    expect(shouldEscalateToHeavy(-0.5)).toBe(false); // > −1.0
  });

  it("does NOT escalate exactly at the threshold (strict <)", () => {
    expect(shouldEscalateToHeavy(-1.0)).toBe(false);
  });

  it("escalates on undefined or non-finite confidence (the safe direction)", () => {
    expect(shouldEscalateToHeavy(undefined)).toBe(true);
    expect(shouldEscalateToHeavy(Number.NaN)).toBe(true);
    expect(shouldEscalateToHeavy(Number.NEGATIVE_INFINITY)).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(shouldEscalateToHeavy(-0.3, -0.1)).toBe(true);
    expect(shouldEscalateToHeavy(-0.3, -0.5)).toBe(false);
  });
});
