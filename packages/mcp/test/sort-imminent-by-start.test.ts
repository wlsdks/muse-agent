import { describe, expect, it } from "vitest";

import { sortImminentByStart } from "@muse/proactivity";

const at = (iso: string) => new Date(iso);

describe("sortImminentByStart", () => {
  it("orders soonest-first regardless of collection order", () => {
    // Mirrors the real bug: a calendar event (collected first) 9 min out vs a
    // task (collected later) due in 2 min — the task must interrupt first.
    const items = [
      { id: "cal", startsAt: at("2026-05-27T12:09:00.000Z") },
      { id: "task", startsAt: at("2026-05-27T12:02:00.000Z") }
    ];
    expect(sortImminentByStart(items).map((i) => i.id)).toEqual(["task", "cal"]);
  });

  it("is stable for equal start times (keeps collection order)", () => {
    const t = "2026-05-27T12:00:00.000Z";
    const items = [
      { id: "a", startsAt: at(t) },
      { id: "b", startsAt: at(t) },
      { id: "c", startsAt: at(t) }
    ];
    expect(sortImminentByStart(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts non-finite / invalid start times last, deterministically", () => {
    const items = [
      { id: "bad", startsAt: new Date("not-a-date") },
      { id: "soon", startsAt: at("2026-05-27T12:01:00.000Z") },
      { id: "later", startsAt: at("2026-05-27T12:05:00.000Z") }
    ];
    expect(sortImminentByStart(items).map((i) => i.id)).toEqual(["soon", "later", "bad"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { id: "x", startsAt: at("2026-05-27T12:05:00.000Z") },
      { id: "y", startsAt: at("2026-05-27T12:01:00.000Z") }
    ];
    sortImminentByStart(items);
    expect(items.map((i) => i.id)).toEqual(["x", "y"]);
  });
});
