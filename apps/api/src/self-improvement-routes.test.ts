import type { WeaknessEntry } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { shapeWeaknesses } from "./self-improvement-routes.js";

function entry(partial: Partial<WeaknessEntry> & { topic: string; count: number; lastSeen: string }): WeaknessEntry {
  return {
    axis: "grounding-gap",
    firstSeen: "2026-06-01T00:00:00Z",
    ...partial
  } as WeaknessEntry;
}

describe("shapeWeaknesses", () => {
  it("orders by count descending, then most-recent lastSeen", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 2, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 5, lastSeen: "2026-06-02T00:00:00Z" }),
      entry({ topic: "c", count: 2, lastSeen: "2026-06-20T00:00:00Z" })
    ]);
    expect(out.entries.map((e) => e.topic)).toEqual(["b", "c", "a"]);
  });

  it("reports the total and never drops an entry", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 1, lastSeen: "2026-06-11T00:00:00Z" })
    ]);
    expect(out.total).toBe(2);
    expect(out.entries).toHaveLength(2);
  });

  it("normalizes absent hint/pKnown to null (JSON-friendly), present ones pass through", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 1, lastSeen: "2026-06-10T00:00:00Z", hint: "add a note", pKnown: 0.4 })
    ]);
    const a = out.entries.find((e) => e.topic === "a")!;
    const b = out.entries.find((e) => e.topic === "b")!;
    expect(a.hint).toBeNull();
    expect(a.pKnown).toBeNull();
    expect(b.hint).toBe("add a note");
    expect(b.pKnown).toBe(0.4);
  });

  it("preserves a pKnown of exactly 0 (a real value, not 'absent')", () => {
    const out = shapeWeaknesses([entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z", pKnown: 0 })]);
    expect(out.entries[0]!.pKnown).toBe(0);
  });

  it("an empty ledger is total 0, not a crash", () => {
    expect(shapeWeaknesses([])).toEqual({ total: 0, entries: [] });
  });
});
