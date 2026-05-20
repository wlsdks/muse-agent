import type { TokenUsageRecord } from "@muse/observability";
import { describe, expect, it } from "vitest";

import { buildKyselyTokenInsertValues } from "../src/observability-token-cost.js";

const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");
const now = () => FIXED_NOW;

function base(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    completionTokens: 5,
    estimatedCostUsd: 0,
    model: "qwen3:8b",
    promptTokens: 7,
    provider: "ollama",
    runId: "run_1",
    totalTokens: 12,
    ...overrides
  };
}

describe("buildKyselyTokenInsertValues — guards against NaN/Infinity poisoning the metric_token_usage row", () => {
  it("passes clean numbers through unchanged", () => {
    const row = buildKyselyTokenInsertValues(base({
      promptCachedTokens: 3,
      reasoningTokens: 0,
      stepType: "react"
    }), now);
    expect(row.prompt_tokens).toBe(7);
    expect(row.completion_tokens).toBe(5);
    expect(row.total_tokens).toBe(12);
    expect(row.prompt_cached_tokens).toBe(3);
    expect(row.reasoning_tokens).toBe(0);
    expect(row.estimated_cost_usd).toBe("0");
    expect(row.step_type).toBe("react");
    expect(row.time).toEqual(FIXED_NOW);
  });

  it("defaults optional fields when undefined (step_type, recordedAt, promptCachedTokens, reasoningTokens, estimatedCostUsd)", () => {
    const row = buildKyselyTokenInsertValues(base(), now);
    expect(row.step_type).toBe("act");
    expect(row.time).toEqual(FIXED_NOW);
    expect(row.prompt_cached_tokens).toBe(0);
    expect(row.reasoning_tokens).toBe(0);
    expect(row.estimated_cost_usd).toBe("0");
  });

  it("clamps NaN promptCachedTokens to 0 — `?? 0` does NOT catch NaN so a poisoned upstream usage object would otherwise corrupt the metric row", () => {
    const row = buildKyselyTokenInsertValues(base({ promptCachedTokens: Number.NaN }), now);
    expect(row.prompt_cached_tokens).toBe(0);
  });

  it("clamps NaN reasoningTokens to 0", () => {
    const row = buildKyselyTokenInsertValues(base({ reasoningTokens: Number.NaN }), now);
    expect(row.reasoning_tokens).toBe(0);
  });

  it("clamps NaN estimatedCostUsd to '0' (avoids String(NaN)='NaN' going into a NUMERIC column and either rejecting the INSERT or coercing strangely)", () => {
    const row = buildKyselyTokenInsertValues(base({ estimatedCostUsd: Number.NaN }), now);
    expect(row.estimated_cost_usd).toBe("0");
  });

  it("clamps Infinity / -Infinity to 0 across all numeric fields (runaway provider usage object)", () => {
    const row = buildKyselyTokenInsertValues(base({
      promptCachedTokens: Number.POSITIVE_INFINITY,
      reasoningTokens: Number.NEGATIVE_INFINITY,
      estimatedCostUsd: Number.POSITIVE_INFINITY
    }), now);
    expect(row.prompt_cached_tokens).toBe(0);
    expect(row.reasoning_tokens).toBe(0);
    expect(row.estimated_cost_usd).toBe("0");
  });

  it("clamps NaN on the required token fields (promptTokens / completionTokens / totalTokens) — same finite-guard convention the aggregation paths already use", () => {
    const row = buildKyselyTokenInsertValues(base({
      promptTokens: Number.NaN,
      completionTokens: Number.NaN,
      totalTokens: Number.NaN
    }), now);
    expect(row.prompt_tokens).toBe(0);
    expect(row.completion_tokens).toBe(0);
    expect(row.total_tokens).toBe(0);
  });
});
