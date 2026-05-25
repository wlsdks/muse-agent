import { describe, expect, it } from "vitest";

import { searchMemoryEntries } from "./commands-memory.js";

const facts = { name: "Jin", city: "Seoul", role: "engineer" };
const prefs = { reply_style: "concise", language: "Korean" };

describe("searchMemoryEntries — search across remembered facts & preferences", () => {
  it("matches on the key (case-insensitive) and labels the source", () => {
    const hits = searchMemoryEntries(facts, prefs, "CITY");
    expect(hits).toEqual([{ source: "fact", key: "city", value: "Seoul" }]);
  });

  it("matches on the value (case-insensitive)", () => {
    const hits = searchMemoryEntries(facts, prefs, "korean");
    expect(hits).toEqual([{ source: "preference", key: "language", value: "Korean" }]);
  });

  it("returns every match across both maps, facts before preferences", () => {
    const hits = searchMemoryEntries({ a: "concise note" }, { b: "concise" }, "concise");
    expect(hits.map((h) => h.source)).toEqual(["fact", "preference"]);
  });

  it("returns nothing for a blank query or no match", () => {
    expect(searchMemoryEntries(facts, prefs, "   ")).toEqual([]);
    expect(searchMemoryEntries(facts, prefs, "zzz")).toEqual([]);
  });
});
