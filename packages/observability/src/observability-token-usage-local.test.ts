import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aggregateTokenUsage, JsonlTokenUsageSink, readLocalTokenUsage } from "./observability-token-usage-local.js";
import type { TokenUsageRecord } from "./index.js";

const rec = (over: Partial<TokenUsageRecord> = {}): TokenUsageRecord => ({
  completionTokens: 20,
  estimatedCostUsd: 0,
  model: "ollama/gemma4:12b",
  promptTokens: 100,
  provider: "ollama",
  runId: "run-default",
  totalTokens: 120,
  ...over
});

describe("JsonlTokenUsageSink — persists usage across processes (local-first, no DB)", () => {
  it("appends each record as JSONL and a fresh reader recovers them (survives process exit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-usage-"));
    try {
      const file = join(dir, "nested", "token-usage.jsonl"); // nested → mkdir -p is exercised
      const sink = new JsonlTokenUsageSink(file);
      await sink.record(rec({ runId: "r1", recordedAt: new Date("2026-06-28T10:00:00Z") }));
      await sink.record(rec({ runId: "r2", model: "ollama/qwen3:8b", totalTokens: 50, promptTokens: 40, completionTokens: 10 }));
      // A FRESH reader (no shared memory) — the cross-process guarantee.
      const read = await readLocalTokenUsage(file);
      expect(read).toHaveLength(2);
      expect(read[0]!.runId).toBe("r1");
      expect(read[0]!.recordedAt?.toISOString()).toBe("2026-06-28T10:00:00.000Z");
      expect(read[1]!.model).toBe("ollama/qwen3:8b");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("also mirrors in-memory for the in-process query", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-usage-"));
    try {
      const sink = new JsonlTokenUsageSink(join(dir, "u.jsonl"));
      await sink.record(rec({ runId: "r1" }));
      expect(sink.list()).toHaveLength(1);
      expect(sink.list()[0]!.runId).toBe("r1");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("readLocalTokenUsage — tolerant of a missing file / corrupt lines", () => {
  it("a missing file → [] (never throws)", async () => {
    expect(await readLocalTokenUsage("/no/such/path/token-usage.jsonl")).toEqual([]);
  });

  it("skips a half-written / corrupt line, keeps the valid ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-usage-"));
    try {
      const file = join(dir, "u.jsonl");
      const sink = new JsonlTokenUsageSink(file);
      await sink.record(rec({ runId: "good" }));
      // simulate a torn write
      const { appendFileSync } = await import("node:fs");
      appendFileSync(file, '{"runId":"torn",bad json\n');
      await sink.record(rec({ runId: "good2" }));
      const read = await readLocalTokenUsage(file);
      expect(read.map((r) => r.runId)).toEqual(["good", "good2"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("aggregateTokenUsage — pure totals + per-model/run/day, NaN-guarded", () => {
  it("sums totals and groups by model / run / day, heaviest first", () => {
    const out = aggregateTokenUsage([
      rec({ runId: "r1", model: "gemma", totalTokens: 100, recordedAt: new Date("2026-06-28T10:00:00Z") }),
      rec({ runId: "r1", model: "gemma", totalTokens: 100, recordedAt: new Date("2026-06-28T11:00:00Z") }),
      rec({ runId: "r2", model: "qwen", totalTokens: 30, recordedAt: new Date("2026-06-27T10:00:00Z") })
    ]);
    expect(out.calls).toBe(3);
    expect(out.totalTokens).toBe(230);
    expect(out.byModel[0]).toMatchObject({ key: "gemma", totalTokens: 200, calls: 2 }); // heaviest first
    expect(out.byRun[0]).toMatchObject({ key: "r1", totalTokens: 200 });
    expect(out.byDay.map((d) => d.key)).toEqual(["2026-06-28", "2026-06-27"]);
  });

  it("a NaN/Infinity token row cannot poison the total or the sort", () => {
    const out = aggregateTokenUsage([
      rec({ totalTokens: Number.NaN, promptTokens: Number.POSITIVE_INFINITY }),
      rec({ totalTokens: 50 })
    ]);
    expect(out.totalTokens).toBe(50);
    expect(Number.isFinite(out.promptTokens)).toBe(true);
  });

  it("records without a date are summed but omitted from byDay (no 'unknown' bucket)", () => {
    const out = aggregateTokenUsage([rec({ totalTokens: 10 })]);
    expect(out.totalTokens).toBe(10);
    expect(out.byDay).toHaveLength(0);
  });
});

describe("JsonlTokenUsageSink — bounded (no unbounded growth)", () => {
  it("caps the in-memory mirror to maxRows (ring buffer — no server heap leak)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-usage-"));
    try {
      const sink = new JsonlTokenUsageSink(join(dir, "u.jsonl"), 3); // tiny cap
      for (let i = 0; i < 10; i++) await sink.record(rec({ runId: `r${i}` }));
      expect(sink.list()).toHaveLength(3); // only the last 3 kept in memory
      expect(sink.list().map((r) => r.runId)).toEqual(["r7", "r8", "r9"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
