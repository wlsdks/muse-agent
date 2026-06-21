import { describe, expect, it } from "vitest";
import type { UserMemory } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactSupersession } from "./index.js";
import { FileUserMemoryStore } from "./memory-user-store-file.js";
import { InMemoryUserMemoryStore } from "./memory-user-store.js";
import { formatLearnedConfirmation, projectRecentlyLearned, renderRecentlyLearnedLines, selectNewSupersessions, summarizeRecentlyLearned, type RecentlyLearnedItem } from "./recently-learned.js";

describe("formatLearnedConfirmation", () => {
  const e = (key: string, prev: string, kind?: "refine" | "contradict", scope?: "fact" | "preference"): FactSupersession => ({
    key,
    previousValue: prev,
    replacedAt: new Date("2026-06-21T00:00:00Z"),
    ...(kind ? { kind } : {}),
    ...(scope ? { scope } : {})
  });

  it("returns undefined when there is nothing confirmable", () => {
    expect(formatLearnedConfirmation([], { facts: {} })).toBeUndefined();
    // a learned key whose value was since removed → skipped (no current value to confirm)
    expect(formatLearnedConfirmation([e("pet", "cat")], { facts: {} })).toBeUndefined();
  });

  it("acknowledges a changed fact, citing the prior value", () => {
    expect(formatLearnedConfirmation([e("home_city", "Seoul", "contradict")], { facts: { home_city: "Busan" } })).toBe(
      '📝 Got it — home city is now "Busan" (changed from "Seoul").'
    );
  });

  it("resolves a preference-scoped learning's current value from preferences", () => {
    expect(
      formatLearnedConfirmation([e("reply_style", "brief", "refine", "preference")], {
        facts: {},
        preferences: { reply_style: "detailed" }
      })
    ).toBe('📝 Got it — reply style is now "detailed" (refined from "brief").');
  });

  it("joins multiple learnings", () => {
    expect(
      formatLearnedConfirmation([e("home_city", "Seoul", "contradict"), e("role", "student", "contradict")], {
        facts: { home_city: "Busan", role: "founder" }
      })
    ).toBe('📝 Got it — home city is now "Busan" (changed from "Seoul"); role is now "founder" (changed from "student").');
  });
});

describe("selectNewSupersessions", () => {
  const e = (key: string, prev: string, ms: number, scope?: "fact" | "preference"): FactSupersession => ({
    key,
    previousValue: prev,
    replacedAt: new Date(ms),
    ...(scope ? { scope } : {})
  });

  it("returns the entries present in after but absent from before", () => {
    const a = e("home_city", "Seoul", 1000);
    const b = e("role", "student", 2000);
    expect(selectNewSupersessions([a], [a, b])).toEqual([b]);
  });

  it("returns [] when nothing new was recorded", () => {
    const a = e("home_city", "Seoul", 1000);
    expect(selectNewSupersessions([a], [a])).toEqual([]);
    expect(selectNewSupersessions([a], [])).toEqual([]);
  });

  it("stays correct when the capped history evicted an old entry (content identity, not position)", () => {
    const a = e("a", "1", 1000);
    const b = e("b", "2", 2000);
    const c = e("c", "3", 3000);
    // before=[a,b]; after=[b,c] — `a` was evicted at the cap, `c` is the new learning.
    expect(selectNewSupersessions([a, b], [b, c])).toEqual([c]);
  });

  it("distinguishes same-key entries by previousValue + timestamp", () => {
    const first = e("home_city", "Seoul", 1000);
    const second = e("home_city", "Busan", 2000);
    expect(selectNewSupersessions([first], [first, second])).toEqual([second]);
  });
});

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
      source: 'changed from "Seoul" on 2026-06-21'
    });
  });

  it("labels the citation verb by how the value changed (refined / changed / updated)", () => {
    const source = (kind?: "refine" | "contradict"): string | undefined =>
      projectRecentlyLearned({
        facts: { k: "new" },
        factHistory: [{ key: "k", previousValue: "old", replacedAt: new Date("2026-06-21T00:00:00Z"), ...(kind ? { kind } : {}) }]
      })[0]?.source;
    expect(source("refine")).toBe('refined from "old" on 2026-06-21');
    expect(source("contradict")).toBe('changed from "old" on 2026-06-21');
    expect(source(undefined)).toBe('updated from "old" on 2026-06-21'); // legacy/absent → conservative
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

  it("excludes learnings older than sinceMs (so a surface can say 'recently' truthfully)", () => {
    const memory = mem({
      facts: { home_city: "Busan", role: "founder" },
      factHistory: [
        { key: "role", previousValue: "student", replacedAt: new Date("2026-01-01T00:00:00Z"), kind: "contradict" },
        { key: "home_city", previousValue: "Seoul", replacedAt: new Date("2026-06-20T00:00:00Z"), kind: "contradict" }
      ]
    });
    const sinceMs = new Date("2026-06-01T00:00:00Z").getTime();
    const items = projectRecentlyLearned(memory, { sinceMs });
    expect(items.map((i) => i.key)).toEqual(["home_city"]); // role (Jan) is outside the window
    // no bound → both appear
    expect(projectRecentlyLearned(memory).map((i) => i.key)).toEqual(["home_city", "role"]);
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

  it("resolves a preference-scoped learning's current value from the preferences store", () => {
    const items = projectRecentlyLearned({
      facts: {},
      preferences: { reply_style: "detailed" },
      factHistory: [
        { key: "reply_style", previousValue: "brief", replacedAt: new Date("2026-06-21T00:00:00Z"), kind: "contradict", scope: "preference" }
      ]
    });
    expect(items[0]).toMatchObject({ key: "reply_style", currentValue: "detailed", previousValue: "brief" });
  });

  it("surfaces a CHANGED preference end-to-end via the store (not just facts)", () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertPreference("u", "reply_style", "brief");
    const memory = store.upsertPreference("u", "reply_style", "detailed");
    const items = projectRecentlyLearned(memory);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "reply_style", currentValue: "detailed", previousValue: "brief" });
  });

  it("surfaces a changed preference after a File-store write→read round-trip (scope persists to disk)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-rl-")), "user-memory.json");
    const writer = new FileUserMemoryStore({ file });
    await writer.upsertPreference("u", "reply_style", "brief");
    await writer.upsertPreference("u", "reply_style", "detailed");
    // A fresh instance forces a read from disk — where the "preference" scope must
    // have survived serialization (the bug fire-7's ④b judge caught: without it, the
    // entry resolves from facts on reload and silently disappears).
    const reader = new FileUserMemoryStore({ file });
    const memory = await reader.findByUserId("u");
    if (!memory) {
      throw new Error("expected the user memory to load from disk");
    }
    const items = projectRecentlyLearned(memory);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "reply_style", currentValue: "detailed", previousValue: "brief" });
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
