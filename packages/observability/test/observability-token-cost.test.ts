import { describe, expect, it } from "vitest";

import {
  InMemoryTokenCostQuery,
  InMemoryTokenUsageSink,
  buildKyselyTokenInsertValues,
  createBudgetTrackingTokenUsageSink
} from "../src/observability-token-cost.js";
import type { TokenUsageRecord } from "../src/index.js";

// Direct coverage for the token-usage / cost-analytics primitives (untested
// module) — the agent cost-accounting surface (DeepEval's cost dimension). The
// load-bearing property is NaN/Infinity-poison resistance: under the Qwen-only
// / $0 mandate every cost is 0, so the ranking falls through to token volume —
// a single corrupt token/cost row must NOT poison an aggregate sum or break the
// sort comparator (NaN ⇒ spec-undefined order). The Kysely query is deferred to
// the testcontainers Postgres item; the pure row builder it shares IS covered.

const rec = (over: Partial<TokenUsageRecord> = {}): TokenUsageRecord => ({
  completionTokens: 5,
  model: "qwen",
  promptTokens: 10,
  provider: "ollama",
  recordedAt: new Date("2026-05-30T10:00:00Z"),
  runId: "r1",
  totalTokens: 15,
  ...over
});
const WINDOW = { from: new Date("2026-05-30T00:00:00Z"), to: new Date("2026-05-31T00:00:00Z") };
const sinkWith = async (records: readonly TokenUsageRecord[]): Promise<InMemoryTokenUsageSink> => {
  const sink = new InMemoryTokenUsageSink();
  for (const r of records) await sink.record(r);
  return sink;
};

describe("InMemoryTokenUsageSink", () => {
  it("clones on record and on list so a caller can't mutate stored state", async () => {
    const sink = await sinkWith([rec({})]);
    const listed = sink.list();
    (listed[0] as { model: string }).model = "MUTATED";
    expect(sink.list()[0]?.model).toBe("qwen"); // stored copy untouched
  });
});

describe("buildKyselyTokenInsertValues", () => {
  it("maps fields, coerces NaN/Infinity cost+tokens to 0, defaults stepType to 'act' and time to now()", () => {
    const row = buildKyselyTokenInsertValues(rec({ estimatedCostUsd: Number.NaN, stepType: undefined, totalTokens: Number.POSITIVE_INFINITY }), () => new Date(0));
    expect(row.estimated_cost_usd).toBe("0"); // NaN → 0 (serialized)
    expect(row.total_tokens).toBe(0); // Infinity → 0
    expect(row.step_type).toBe("act");
    expect(row.time).toEqual(new Date("2026-05-30T10:00:00Z")); // recordedAt wins over now()
  });

  it("falls back to now() for the time when recordedAt is absent", () => {
    const row = buildKyselyTokenInsertValues(rec({ recordedAt: undefined }), () => new Date(42));
    expect(row.time).toEqual(new Date(42));
  });
});

describe("InMemoryTokenCostQuery", () => {
  it("bySession matches by runId PREFIX and sorts ascending by time", async () => {
    const sink = await sinkWith([
      rec({ recordedAt: new Date("2026-05-30T10:00:00Z"), runId: "run-abc", totalTokens: 15 }),
      rec({ recordedAt: new Date("2026-05-30T09:00:00Z"), runId: "run-abc", totalTokens: 5 }),
      rec({ recordedAt: new Date("2026-05-30T11:00:00Z"), runId: "other" })
    ]);
    const rows = await new InMemoryTokenCostQuery(sink).bySession("run");
    expect(rows.map((r) => r.totalTokens)).toEqual([5, 15]); // prefix-matched, time-asc
    expect(rows.every((r) => r.runId === "run-abc")).toBe(true);
  });

  it("daily aggregates per day|model within [from, to) and excludes a record AT `to`", async () => {
    const sink = await sinkWith([
      rec({ completionTokens: 5, estimatedCostUsd: 0.5, promptTokens: 10, totalTokens: 15 }),
      rec({ completionTokens: 5, estimatedCostUsd: 0.1, promptTokens: 10, totalTokens: 5 }),
      rec({ recordedAt: new Date("2026-05-31T00:00:00Z"), totalTokens: 999 }) // exactly `to` → excluded
    ]);
    const daily = await new InMemoryTokenCostQuery(sink).daily(WINDOW);
    expect(daily).toEqual([{ completionTokens: 10, day: "2026-05-30", model: "qwen", promptTokens: 20, totalCostUsd: 0.6, totalTokens: 20 }]);
  });

  it("topExpensive sums per runId, ranks cost-desc then token-desc, and applies the limit", async () => {
    const sink = await sinkWith([
      rec({ estimatedCostUsd: 0.5, runId: "run-abc", totalTokens: 15 }),
      rec({ estimatedCostUsd: 0.1, runId: "run-abc", totalTokens: 5 }),
      rec({ estimatedCostUsd: 0, runId: "other", totalTokens: 99 })
    ]);
    const top = await new InMemoryTokenCostQuery(sink).topExpensive({ ...WINDOW, limit: 2 });
    expect(top.map((e) => e.runId)).toEqual(["run-abc", "other"]); // cost 0.6 > cost 0
    expect(top[0]).toMatchObject({ totalCostUsd: 0.6, totalTokens: 20 });
  });

  it("is NaN/Infinity-poison resistant: a corrupt row doesn't poison the aggregate sum", async () => {
    const sink = await sinkWith([rec({ estimatedCostUsd: Number.NaN, totalTokens: Number.NaN }), rec({ estimatedCostUsd: 0.2, totalTokens: 10 })]);
    const [day] = await new InMemoryTokenCostQuery(sink).daily(WINDOW);
    expect(day?.totalTokens).toBe(10); // NaN row contributed 0, not NaN
    expect(Number.isFinite(day?.totalCostUsd)).toBe(true);
  });
});

describe("createBudgetTrackingTokenUsageSink", () => {
  it("fans each recorded cost into the tracker (undefined cost → 0) and keeps the inner sink queryable", async () => {
    const costs: number[] = [];
    const tracker = { recordCost: (c: number) => { costs.push(c); } } as unknown as Parameters<typeof createBudgetTrackingTokenUsageSink>[0];
    const wrapped = createBudgetTrackingTokenUsageSink(tracker, new InMemoryTokenUsageSink());
    await wrapped.record(rec({ estimatedCostUsd: 0.3 }));
    await wrapped.record(rec({ estimatedCostUsd: undefined }));
    expect(costs).toEqual([0.3, 0]);
    expect(typeof (wrapped as { list?: unknown }).list).toBe("function"); // queryable passthrough preserved
  });
});
