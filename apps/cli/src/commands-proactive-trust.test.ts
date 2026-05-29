import { describe, expect, it } from "vitest";

import { renderTrustScoreboard } from "./commands-proactive-trust.js";
import type { TrustLedgerEntry } from "@muse/mcp";

const entry = (over: Partial<TrustLedgerEntry>): TrustLedgerEntry => ({
  kind: "task",
  sourceKey: "task:t-1",
  surfacedAtMs: Date.parse("2026-05-18T09:00:00Z"),
  title: "Q3 memo",
  ...over
});

describe("renderTrustScoreboard", () => {
  it("shows the no-signal state when nothing has surfaced", () => {
    const out = renderTrustScoreboard([]);
    expect(out).toContain("No proactive notices yet");
    expect(out).not.toContain("Precision:");
  });

  it("renders precision + recent surfaces, most recent first", () => {
    const out = renderTrustScoreboard([
      entry({ outcome: "kept", sourceKey: "task:t-1", surfacedAtMs: 1_000, title: "First" }),
      entry({ outcome: "vetoed", sourceKey: "calendar:e-2", surfacedAtMs: 3_000, title: "Second" }),
      entry({ sourceKey: "task:t-3", surfacedAtMs: 2_000, title: "Third" })
    ]);
    expect(out).toContain("Surfaced: 3");
    expect(out).toContain("Vetoed: 1");
    // precision = (3 - 1) / 3 = 67%
    expect(out).toContain("Precision: 67%");
    // most-recent-first ordering: calendar:e-2 (3000) before task:t-3 (2000) before task:t-1 (1000)
    const order = ["calendar:e-2", "task:t-3", "task:t-1"].map((k) => out.indexOf(k));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(out).toContain("✗ vetoed");
    expect(out).toContain("muse proactive veto <source>");
  });
});
