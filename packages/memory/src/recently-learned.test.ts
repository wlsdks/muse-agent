import { describe, expect, it } from "vitest";
import type { UserMemory } from "./index.js";
import { projectRecentlyLearned, renderRecentlyLearnedLines, summarizeRecentlyLearned, type RecentlyLearnedItem } from "./recently-learned.js";

function mem(
  partial: Partial<Pick<UserMemory, "facts" | "factHistory">>
): Pick<UserMemory, "facts" | "factHistory"> {
  return { facts: partial.facts ?? {}, factHistory: partial.factHistory };
}

describe("projectRecentlyLearned", () => {
  it("returns [] when there is no fact history", () => {
    expect(projectRecentlyLearned(mem({ facts: { home_city: "Seoul" } }))).toEqual([]);
    expect(projectRecentlyLearned(mem({ factHistory: [] }))).toEqual([]);
  });

  it("projects a recorded supersession with its current value and a provenance citation", () => {
    const items = projectRecentlyLearned(
      mem({
        facts: { home_city: "Busan" },
        factHistory: [
          { key: "home_city", previousValue: "Seoul", replacedAt: new Date("2026-06-21T10:00:00Z"), kind: "contradict" }
        ]
      })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "home_city",
      currentValue: "Busan",
      previousValue: "Seoul",
      kind: "contradict",
      source: 'updated from "Seoul" on 2026-06-21'
    });
  });

  it("orders newest first by replacedAt", () => {
    const items = projectRecentlyLearned(
      mem({
        facts: { a: "1", b: "2" },
        factHistory: [
          { key: "a", previousValue: "old-a", replacedAt: new Date("2026-06-01T00:00:00Z") },
          { key: "b", previousValue: "old-b", replacedAt: new Date("2026-06-20T00:00:00Z") }
        ]
      })
    );
    expect(items.map((i) => i.key)).toEqual(["b", "a"]);
  });

  it("respects the limit (and limit 0 -> [])", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      key: `k${i}`,
      previousValue: `p${i}`,
      replacedAt: new Date(2026, 5, i + 1)
    }));
    expect(projectRecentlyLearned(mem({ facts: {}, factHistory: history }), { limit: 3 })).toHaveLength(3);
    expect(projectRecentlyLearned(mem({ factHistory: history }), { limit: 0 })).toEqual([]);
    expect(projectRecentlyLearned(mem({ factHistory: history }))).toHaveLength(5);
  });

  it("treats a legacy entry with no recorded kind as the conservative 'changed' framing", () => {
    const items = projectRecentlyLearned(
      mem({
        facts: { role: "founder" },
        factHistory: [{ key: "role", previousValue: "student", replacedAt: new Date("2026-06-21T00:00:00Z") }]
      })
    );
    expect(items[0]?.kind).toBe("changed");
  });

  it("reports currentValue undefined when the learned fact was since forgotten", () => {
    const items = projectRecentlyLearned(
      mem({
        facts: {},
        factHistory: [{ key: "pet", previousValue: "cat", replacedAt: new Date("2026-06-21T00:00:00Z"), kind: "refine" }]
      })
    );
    expect(items[0]?.currentValue).toBeUndefined();
    expect(items[0]?.previousValue).toBe("cat");
  });
});

describe("renderRecentlyLearnedLines", () => {
  function item(over: Partial<RecentlyLearnedItem>): RecentlyLearnedItem {
    return {
      key: "home_city",
      currentValue: "Busan",
      previousValue: "Seoul",
      replacedAt: new Date("2026-06-21T00:00:00Z"),
      kind: "contradict",
      source: 'updated from "Seoul" on 2026-06-21',
      ...over
    };
  }

  it("renders a held item as a humanised, citation-bearing line", () => {
    expect(renderRecentlyLearnedLines([item({})])).toEqual([
      'home city: Busan (updated from "Seoul" on 2026-06-21)'
    ]);
  });

  it("omits an item whose fact was since forgotten (currentValue undefined)", () => {
    const lines = renderRecentlyLearnedLines([
      item({ key: "pet", currentValue: undefined }),
      item({ key: "role", currentValue: "founder", source: 'updated from "student" on 2026-06-20' })
    ]);
    expect(lines).toEqual(['role: founder (updated from "student" on 2026-06-20)']);
  });

  it("preserves input order and humanises every key", () => {
    const lines = renderRecentlyLearnedLines([
      item({ key: "favorite_food", currentValue: "kimchi", source: "s1" }),
      item({ key: "home_city", currentValue: "Busan", source: "s2" })
    ]);
    expect(lines).toEqual(["favorite food: kimchi (s1)", "home city: Busan (s2)"]);
  });

  it("returns [] for no items", () => {
    expect(renderRecentlyLearnedLines([])).toEqual([]);
  });
});

describe("summarizeRecentlyLearned", () => {
  function item(over: Partial<RecentlyLearnedItem>): RecentlyLearnedItem {
    return {
      key: "home_city",
      currentValue: "Busan",
      previousValue: "Seoul",
      replacedAt: new Date("2026-06-21T00:00:00Z"),
      kind: "contradict",
      source: 'updated from "Seoul" on 2026-06-21',
      ...over
    };
  }

  it("returns undefined when nothing is currently surfaced", () => {
    expect(summarizeRecentlyLearned([])).toBeUndefined();
    // an item whose fact was forgotten is filtered out by the render layer
    expect(summarizeRecentlyLearned([item({ currentValue: undefined })])).toBeUndefined();
  });

  it("returns the single cited line with no count when there is exactly one", () => {
    expect(summarizeRecentlyLearned([item({})])).toBe('home city: Busan (updated from "Seoul" on 2026-06-21)');
  });

  it("returns the most-recent cited line plus a (+N more) count", () => {
    const out = summarizeRecentlyLearned([
      item({ key: "home_city", currentValue: "Busan", source: "s1" }),
      item({ key: "role", currentValue: "founder", source: "s2" }),
      item({ key: "pet", currentValue: "dog", source: "s3" })
    ]);
    expect(out).toBe("home city: Busan (s1) (+2 more)");
  });

  it("a forgotten fact does not inflate the (+N more) count", () => {
    const out = summarizeRecentlyLearned([
      item({ key: "home_city", currentValue: "Busan", source: "s1" }),
      item({ key: "pet", currentValue: undefined, source: "s2" }),
      item({ key: "role", currentValue: "founder", source: "s3" })
    ]);
    expect(out).toBe("home city: Busan (s1) (+1 more)");
  });
});
