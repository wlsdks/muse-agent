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
});
