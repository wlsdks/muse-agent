import { describe, expect, it } from "vitest";

import { InMemoryContextReferenceStore } from "../src/context-reference-store.js";

function clock(start: number): { now: () => Date; advance: (ms: number) => void } {
  let t = start;
  return { advance: (ms) => { t += ms; }, now: () => new Date(t) };
}

describe("InMemoryContextReferenceStore", () => {
  it("round-trips put → get and rejects an empty id", () => {
    const store = new InMemoryContextReferenceStore();
    const ref = store.put({ content: "big blob", id: "r1", source: "muse.fs.read" });
    expect(ref.createdAt).toBeInstanceOf(Date);
    expect(store.get("r1")).toMatchObject({ content: "big blob", id: "r1", source: "muse.fs.read" });
    expect(store.get("missing")).toBeUndefined();
    expect(() => store.put({ content: "x", id: "  " })).toThrow(/non-empty id/u);
  });

  it("lazily expires an entry on get once past the TTL and deletes it", () => {
    const c = clock(1_000_000);
    const store = new InMemoryContextReferenceStore({ now: c.now, ttlMs: 1_000 });
    store.put({ content: "blob", id: "r1" });
    c.advance(999);
    expect(store.get("r1")).toBeDefined(); // still inside TTL
    c.advance(2); // now 1001ms old (>= ttl)
    expect(store.get("r1")).toBeUndefined();
    // The expired entry is actually removed, not just hidden.
    expect(store.list().some((e) => e.id === "r1")).toBe(false);
  });

  it("ttlMs:0 disables expiry entirely", () => {
    const c = clock(0);
    const store = new InMemoryContextReferenceStore({ now: c.now, ttlMs: 0 });
    store.put({ content: "blob", id: "r1" });
    c.advance(10 * 60 * 60 * 1000); // 10 hours later
    expect(store.get("r1")).toBeDefined();
    expect(store.pruneExpired()).toBe(0);
  });

  it("pruneExpired removes only expired entries, returns the count, and is idempotent", () => {
    const c = clock(0);
    const store = new InMemoryContextReferenceStore({ now: c.now, ttlMs: 100 });
    store.put({ content: "old", id: "old" });
    c.advance(80);
    store.put({ content: "fresh", id: "fresh" });
    c.advance(30); // old is 110ms (expired), fresh is 30ms (alive)
    expect(store.pruneExpired()).toBe(1);
    expect(store.get("fresh")).toBeDefined();
    expect(store.get("old")).toBeUndefined();
    expect(store.pruneExpired()).toBe(0); // idempotent
  });

  it("evicts the OLDEST entries first when over maxEntries", () => {
    const c = clock(0);
    const store = new InMemoryContextReferenceStore({ maxEntries: 3, now: c.now, ttlMs: 0 });
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.put({ content: id, id });
      c.advance(1);
    }
    const kept = store.list().map((e) => e.id).sort();
    expect(kept).toEqual(["c", "d", "e"]); // a, b (oldest two) evicted
    expect(store.get("a")).toBeUndefined();
    expect(store.get("e")).toBeDefined();
  });

  it("delete reports whether an entry existed", () => {
    const store = new InMemoryContextReferenceStore({ ttlMs: 0 });
    store.put({ content: "x", id: "r1" });
    expect(store.delete("r1")).toBe(true);
    expect(store.delete("r1")).toBe(false);
    expect(store.get("r1")).toBeUndefined();
  });

  it("constructor finite-guards ttlMs and maxEntries against NaN / Infinity (a corrupt option must not silently break the store)", () => {
    // Pre-fix: `options.ttlMs ?? DEFAULT_TTL_MS` doesn't catch NaN
    // (NaN is not nullish), then `Math.max(0, NaN) === NaN`. The
    // `now - createdAt >= NaN` guard in isExpired returns false
    // forever — every entry becomes permanent. Same threat on
    // `maxEntries: NaN`: in evictIfOverCap, `size <= NaN` is false
    // → enters the eviction code, `overflow = size - NaN = NaN`,
    // and the `ids.length >= NaN` break condition never trips →
    // ALL keys get pushed to the deletion list → every put silently
    // empties the store of every prior entry.

    // ttlMs: NaN must fall to the documented 30-min default — entries
    // DO expire past the cap, not become permanent.
    const c = clock(0);
    const nanTtlStore = new InMemoryContextReferenceStore({ now: c.now, ttlMs: Number.NaN });
    nanTtlStore.put({ content: "fresh", id: "r1" });
    c.advance(30 * 60 * 1_000 + 1);
    expect(nanTtlStore.get("r1"), "ttlMs:NaN must fall to the 30-min default → entry expires past the cap").toBeUndefined();

    // ttlMs: Infinity also falls to the default.
    const c2 = clock(0);
    const infTtlStore = new InMemoryContextReferenceStore({ now: c2.now, ttlMs: Number.POSITIVE_INFINITY });
    infTtlStore.put({ content: "fresh", id: "r2" });
    c2.advance(30 * 60 * 1_000 + 1);
    expect(infTtlStore.get("r2")).toBeUndefined();

    // maxEntries: NaN must fall to the 1000 default — multiple puts
    // accumulate normally instead of the cache being silently emptied
    // by the broken overflow loop on every put.
    const c3 = clock(0);
    const nanMaxStore = new InMemoryContextReferenceStore({ maxEntries: Number.NaN, now: c3.now, ttlMs: 60_000 });
    nanMaxStore.put({ content: "a", id: "r1" });
    nanMaxStore.put({ content: "b", id: "r2" });
    nanMaxStore.put({ content: "c", id: "r3" });
    expect(
      nanMaxStore.list().length,
      "maxEntries:NaN must fall to the default; all three puts should remain (pre-fix the eviction loop drained the store on each put)"
    ).toBe(3);
  });
});
