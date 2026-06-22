import { describe, expect, it } from "vitest";

import { createFeedsSearchTool, type FeedEntryLike } from "../src/index.js";

// Reader returns entries newest-first; the tool must preserve that order.
const ENTRIES: FeedEntryLike[] = [
  { feedName: "Space News", id: "f1", publishedAt: "2026-06-12", summary: "The rover reached the crater.", title: "Mars mission update" },
  { feedName: "Space News", id: "f2", publishedAt: "2026-05-01", summary: "Launch window set for the Mars sample return.", title: "Sample return plan" },
  { feedName: "TS Weekly", id: "f3", summary: "5.9 ships decorators.", title: "New TypeScript release" },
  { feedName: "Home", id: "f4", summary: "Mulch your beds in spring.", title: "Gardening tips" }
];
function tool(entries: FeedEntryLike[] = ENTRIES) {
  return createFeedsSearchTool({ feedEntries: () => entries });
}

describe("createFeedsSearchTool — search the watched feed archive", () => {
  it("is risk:read and matches title OR summary case-insensitively, newest-first order preserved", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({ query: "mars" }) as { count: number; query: string; hits: { id: string; title: string; feedName?: string }[] };
    expect(out.count).toBe(2);
    expect(out.hits.map((h) => h.id)).toEqual(["f1", "f2"]); // input (newest-first) order kept
    expect(out.hits[0]).toMatchObject({ feedName: "Space News", id: "f1", title: "Mars mission update" });
    // A summary-only, differently-cased match still hits.
    const mulch = await tool().execute({ query: "MULCH" }) as { count: number; hits: { id: string }[] };
    expect(mulch.count).toBe(1);
    expect(mulch.hits[0]?.id).toBe("f4");
  });

  it("returns count 0 (no hits) when nothing matches", async () => {
    const out = await tool().execute({ query: "kubernetes" }) as { count: number; hits: unknown[] };
    expect(out.count).toBe(0);
    expect(out.hits).toEqual([]);
  });

  it("rejects an empty / whitespace query without scanning (found:false, no hits)", async () => {
    const out = await tool().execute({ query: "   " }) as { count: number; hits: unknown[]; found?: boolean };
    expect(out.count).toBe(0);
    expect(out.hits).toEqual([]);
    expect(out.found).toBe(false);
  });

  it("caps results to limit (clamped 1..50, default 10)", async () => {
    const out = await tool().execute({ query: "a", limit: 1 }) as { hits: unknown[]; limit: number };
    expect(out.limit).toBe(1);
    expect(out.hits).toHaveLength(1);
    // out-of-range clamps to 50 rather than a huge/NaN cap.
    expect((await tool().execute({ query: "a", limit: 999 }) as { limit: number }).limit).toBe(50);
  });
});
