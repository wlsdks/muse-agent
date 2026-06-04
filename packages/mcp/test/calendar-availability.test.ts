import { describe, expect, it } from "vitest";

import { computeAvailability, createCalendarMcpServer, type AvailabilityEventLike } from "../src/index.js";

const D = (iso: string) => new Date(iso);
function ev(title: string, startsAt: string, endsAt: string, allDay = false): AvailabilityEventLike {
  return { allDay, endsAt: D(endsAt), startsAt: D(startsAt), title };
}
const window9to17 = { from: D("2026-05-25T09:00:00Z"), to: D("2026-05-25T17:00:00Z") };

describe("computeAvailability — free/busy over a window", () => {
  it("an empty calendar is fully free — one slot spanning the window", () => {
    const r = computeAvailability([], window9to17);
    expect(r.fullyFree).toBe(true);
    expect(r.busy).toEqual([]);
    expect(r.free).toHaveLength(1);
    expect(r.free[0]!.startsAt.toISOString()).toBe("2026-05-25T09:00:00.000Z");
    expect(r.free[0]!.endsAt.toISOString()).toBe("2026-05-25T17:00:00.000Z");
  });

  it("one meeting splits the day into two free gaps and is NOT fully free", () => {
    const r = computeAvailability([ev("Standup", "2026-05-25T10:00:00Z", "2026-05-25T11:00:00Z")], window9to17);
    expect(r.fullyFree).toBe(false);
    expect(r.busy).toHaveLength(1);
    expect(r.free.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ["2026-05-25T09:00:00.000Z", "2026-05-25T10:00:00.000Z"],
      ["2026-05-25T11:00:00.000Z", "2026-05-25T17:00:00.000Z"]
    ]);
  });

  it("overlapping AND adjacent events merge into one busy block keeping every title", () => {
    const r = computeAvailability([
      ev("A", "2026-05-25T10:00:00Z", "2026-05-25T11:00:00Z"),
      ev("B", "2026-05-25T10:30:00Z", "2026-05-25T12:00:00Z"), // overlaps A
      ev("C", "2026-05-25T12:00:00Z", "2026-05-25T13:00:00Z")  // adjacent to B
    ], window9to17);
    expect(r.busy).toHaveLength(1);
    expect(r.busy[0]!.startsAt.toISOString()).toBe("2026-05-25T10:00:00.000Z");
    expect(r.busy[0]!.endsAt.toISOString()).toBe("2026-05-25T13:00:00.000Z");
    expect(r.busy[0]!.titles).toEqual(["A", "B", "C"]);
  });

  it("busy intervals are clamped to the window (an event spilling past the edges)", () => {
    const r = computeAvailability([ev("All morning", "2026-05-25T06:00:00Z", "2026-05-25T20:00:00Z")], window9to17);
    expect(r.fullyFree).toBe(false);
    expect(r.busy[0]!.startsAt.toISOString()).toBe("2026-05-25T09:00:00.000Z");
    expect(r.busy[0]!.endsAt.toISOString()).toBe("2026-05-25T17:00:00.000Z");
    expect(r.free).toEqual([]);
  });

  it("minFreeMinutes drops gaps shorter than the requested duration", () => {
    const r = computeAvailability([
      ev("A", "2026-05-25T09:20:00Z", "2026-05-25T10:00:00Z"), // leaves a 20-min gap before it
      ev("B", "2026-05-25T10:30:00Z", "2026-05-25T17:00:00Z")  // leaves a 30-min gap between A and B
    ], window9to17, { minFreeMinutes: 30 });
    // 09:00–09:20 (20m) dropped; 10:00–10:30 (30m) kept.
    expect(r.free.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ["2026-05-25T10:00:00.000Z", "2026-05-25T10:30:00.000Z"]
    ]);
  });

  it("an all-day event blocks the whole window", () => {
    const r = computeAvailability([ev("Holiday", "2026-05-25T00:00:00Z", "2026-05-26T00:00:00Z", true)], window9to17);
    expect(r.fullyFree).toBe(false);
    expect(r.free).toEqual([]);
  });

  it("a point-in-time check (1-hour window) reports free when nothing overlaps", () => {
    const r = computeAvailability(
      [ev("Lunch", "2026-05-25T12:00:00Z", "2026-05-25T13:00:00Z")],
      { from: D("2026-05-25T15:00:00Z"), to: D("2026-05-25T16:00:00Z") }
    );
    expect(r.fullyFree).toBe(true);
  });

  it("zero-length / inverted events and an invalid window are ignored safely", () => {
    expect(computeAvailability([ev("Bad", "2026-05-25T11:00:00Z", "2026-05-25T11:00:00Z")], window9to17).fullyFree).toBe(true);
    const invalid = computeAvailability([], { from: D("2026-05-25T17:00:00Z"), to: D("2026-05-25T09:00:00Z") });
    expect(invalid).toEqual({ busy: [], free: [], fullyFree: true });
  });
});

describe("muse.calendar.availability tool — over the registry", () => {
  function calendarServer(events: AvailabilityEventLike[]) {
    return createCalendarMcpServer({
      registry: {
        listEvents: async () => events.map((e, i) => ({ ...e, id: `e${i.toString()}`, providerId: "p" })),
        createEvent: async () => ({}),
        updateEvent: async () => ({}),
        deleteEvent: async () => undefined,
        describe: () => []
      } as never
    });
  }
  const tool = (events: AvailabilityEventLike[]) =>
    calendarServer(events).tools.find((t) => t.name === "availability")!;

  it("is exposed as a read tool in the calendar domain", () => {
    const def = tool([]);
    expect(def).toBeDefined();
    expect(def.risk).toBe("read");
    expect(def.domain).toBe("calendar");
  });

  it("answers 'am I free' from the registry's events", async () => {
    const out = await tool([ev("Mtg", "2026-05-25T10:00:00Z", "2026-05-25T11:00:00Z")])
      .execute({ fromIso: "2026-05-25T09:00:00Z", toIso: "2026-05-25T17:00:00Z" }) as { fullyFree: boolean; busy: unknown[]; free: unknown[] };
    expect(out.fullyFree).toBe(false);
    expect(out.busy).toHaveLength(1);
    expect(out.free).toHaveLength(2);
  });

  it("rejects a missing/invalid fromIso with a clear error", async () => {
    const out = await tool([]).execute({}) as { error?: string };
    expect(out.error).toContain("fromIso");
  });
});

describe("muse.calendar.conflicts tool — double-booking detection over the registry", () => {
  function calendarServer(events: AvailabilityEventLike[]) {
    return createCalendarMcpServer({
      registry: {
        listEvents: async () => events.map((e, i) => ({ ...e, id: `e${i.toString()}`, providerId: "p" })),
        createEvent: async () => ({}),
        updateEvent: async () => ({}),
        deleteEvent: async () => undefined,
        describe: () => []
      } as never
    });
  }
  const tool = (events: AvailabilityEventLike[]) =>
    calendarServer(events).tools.find((t) => t.name === "conflicts")!;

  it("is exposed as a read tool in the calendar domain", () => {
    const def = tool([]);
    expect(def).toBeDefined();
    expect(def.risk).toBe("read");
    expect(def.domain).toBe("calendar");
  });

  it("reports each overlapping PAIR with the overlap span; back-to-back events are NOT a conflict", async () => {
    const overlapping = await tool([
      ev("Design review", "2026-05-25T10:00:00Z", "2026-05-25T11:00:00Z"),
      ev("1:1 with Sam", "2026-05-25T10:30:00Z", "2026-05-25T11:30:00Z"), // overlaps 10:30–11:00
      ev("Lunch", "2026-05-25T12:00:00Z", "2026-05-25T13:00:00Z") // disjoint
    ]).execute({ fromIso: "2026-05-25T00:00:00Z", toIso: "2026-05-26T00:00:00Z" }) as {
      total: number;
      conflicts: { a: { title: string }; b: { title: string }; overlapStartsAtIso: string; overlapEndsAtIso: string }[];
    };
    expect(overlapping.total).toBe(1);
    expect([overlapping.conflicts[0]!.a.title, overlapping.conflicts[0]!.b.title].sort())
      .toEqual(["1:1 with Sam", "Design review"]);
    expect(overlapping.conflicts[0]!.overlapStartsAtIso).toBe("2026-05-25T10:30:00.000Z");
    expect(overlapping.conflicts[0]!.overlapEndsAtIso).toBe("2026-05-25T11:00:00.000Z");

    const clear = await tool([
      ev("A", "2026-05-25T10:00:00Z", "2026-05-25T11:00:00Z"),
      ev("B", "2026-05-25T11:00:00Z", "2026-05-25T12:00:00Z") // back-to-back, not overlapping
    ]).execute({ fromIso: "2026-05-25T00:00:00Z", toIso: "2026-05-26T00:00:00Z" }) as { total: number; conflicts: unknown[] };
    expect(clear.total).toBe(0);
    expect(clear.conflicts).toEqual([]);
  });

  it("defaults the window to now..+7d when fromIso/toIso are omitted (no error, unlike availability)", async () => {
    const out = await tool([]).execute({}) as { total: number; windowFromIso: string; windowToIso: string };
    expect(out.total).toBe(0);
    expect(typeof out.windowFromIso).toBe("string");
    expect(typeof out.windowToIso).toBe("string");
  });
});
