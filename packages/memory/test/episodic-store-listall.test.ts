import { describe, expect, it } from "vitest";

import { InMemoryConversationSummaryStore } from "../src/memory-conversation-summary-store.js";

describe("InMemoryConversationSummaryStore.listAll", () => {
  const earlier = new Date("2026-05-08T00:00:00.000Z");
  const middle = new Date("2026-05-09T00:00:00.000Z");
  const newest = new Date("2026-05-10T00:00:00.000Z");

  function makeStore() {
    const store = new InMemoryConversationSummaryStore({ now: () => newest });
    store.save({
      narrative: "u1 oldest",
      sessionId: "s-1",
      summarizedUpToIndex: 1,
      updatedAt: earlier,
      userId: "u1"
    });
    store.save({
      narrative: "u1 middle",
      sessionId: "s-2",
      summarizedUpToIndex: 1,
      updatedAt: middle,
      userId: "u1"
    });
    store.save({
      narrative: "u2 newest",
      sessionId: "s-3",
      summarizedUpToIndex: 1,
      updatedAt: newest,
      userId: "u2"
    });
    return store;
  }

  it("returns everything newest-first when no filter is supplied", () => {
    const store = makeStore();
    const all = store.listAll();
    expect(all.map((entry) => entry.sessionId)).toEqual(["s-3", "s-2", "s-1"]);
  });

  it("filters by userId", () => {
    const store = makeStore();
    const u1 = store.listAll({ userId: "u1" });
    expect(u1.map((entry) => entry.sessionId)).toEqual(["s-2", "s-1"]);
  });

  it("respects the limit option", () => {
    const store = makeStore();
    expect(store.listAll({ limit: 1 }).map((entry) => entry.sessionId)).toEqual(["s-3"]);
  });
});
