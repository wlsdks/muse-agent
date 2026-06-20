import { describe, expect, it } from "vitest";

import {
  MAX_FACT_HISTORY_ENTRIES,
  appendFactHistory,
  collectFactSupersessions,
  mergeRecordTouchLast,
  normalizeMemoryKey,
} from "../src/memory-user-store.js";

const at = new Date("2026-01-01T00:00:00Z");

describe("normalizeMemoryKey", () => {
  it("splits camelCase, lowercases, and converts spaces/hyphens to underscores", () => {
    expect(normalizeMemoryKey("firstName")).toBe("first_name");
    expect(normalizeMemoryKey("favorite-color")).toBe("favorite_color");
    expect(normalizeMemoryKey("  Some Key!  ")).toBe("some_key");
    expect(normalizeMemoryKey("a--b  c")).toBe("a_b_c");
  });

  it("leaves an already-normalized key unchanged and keeps unicode letters", () => {
    expect(normalizeMemoryKey("already_snake")).toBe("already_snake");
    expect(normalizeMemoryKey("café Préféré")).toBe("café_préféré");
  });

  it("does not split a run of consecutive capitals (only a lower/digit→upper boundary)", () => {
    expect(normalizeMemoryKey("HTTPServer")).toBe("httpserver");
  });

  it("falls back to the trimmed original when normalization strips everything", () => {
    expect(normalizeMemoryKey("!!!")).toBe("!!!");
    expect(normalizeMemoryKey("  @@  ")).toBe("@@");
  });
});

describe("collectFactSupersessions", () => {
  it("records only the keys whose existing value actually changed", () => {
    expect(collectFactSupersessions({ city: "NYC", name: "Bob" }, { city: "LA", name: "Bob", pet: "cat" }, at)).toEqual([
      { key: "city", previousValue: "NYC", replacedAt: at, kind: "contradict" },
    ]);
  });

  it("records nothing for a first-seen key or an unchanged value", () => {
    expect(collectFactSupersessions({}, { city: "NYC" }, at)).toEqual([]);
    expect(collectFactSupersessions({ city: "NYC" }, { city: "NYC" }, at)).toEqual([]);
  });

  it("labels an ELABORATION (superset of tokens) as kind=refine", () => {
    expect(collectFactSupersessions({ home: "Seoul" }, { home: "Seoul, Gangnam-gu" }, at)).toEqual([
      { key: "home", previousValue: "Seoul", replacedAt: at, kind: "refine" },
    ]);
  });

  it("labels an unrelated value swap as kind=contradict", () => {
    expect(collectFactSupersessions({ home: "Seoul" }, { home: "Busan" }, at)).toEqual([
      { key: "home", previousValue: "Seoul", replacedAt: at, kind: "contradict" },
    ]);
  });

  it("labels a NARROWING (subset of tokens) as kind=refine too", () => {
    expect(collectFactSupersessions({ home: "Seoul, Gangnam-gu" }, { home: "Seoul" }, at)).toEqual([
      { key: "home", previousValue: "Seoul, Gangnam-gu", replacedAt: at, kind: "refine" },
    ]);
  });
});

describe("appendFactHistory", () => {
  it("returns the existing history unchanged when there are no additions", () => {
    const existing = [{ key: "k", previousValue: "v", replacedAt: at }];
    expect(appendFactHistory(existing, [])).toBe(existing);
  });

  it("appends additions and caps the history at MAX_FACT_HISTORY_ENTRIES (keeping the most recent)", () => {
    const additions = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, previousValue: "v", replacedAt: at }));
    const result = appendFactHistory(undefined, additions)!;
    expect(result).toHaveLength(MAX_FACT_HISTORY_ENTRIES);
    expect(result[0]?.key).toBe("k10"); // oldest 10 dropped
    expect(result[result.length - 1]?.key).toBe("k59");
  });
});

describe("mergeRecordTouchLast", () => {
  it("keeps untouched keys first, then re-appends patched/new keys so the touched ones move last", () => {
    expect(mergeRecordTouchLast({ a: "1", b: "2", c: "3" }, { b: "9", d: "4" })).toEqual({
      a: "1",
      c: "3",
      b: "9",
      d: "4",
    });
    expect(Object.keys(mergeRecordTouchLast({ a: "1", b: "2", c: "3" }, { b: "9", d: "4" }))).toEqual(["a", "c", "b", "d"]);
  });

  it("returns a copy of existing when the patch is empty", () => {
    expect(mergeRecordTouchLast({ a: "1" }, {})).toEqual({ a: "1" });
  });
});
