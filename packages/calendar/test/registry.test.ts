import { describe, expect, it } from "vitest";

import { CalendarProviderError } from "../src/errors.js";
import { CalendarProviderRegistry, compareCalendarEvents } from "../src/registry.js";
import type { CalendarEvent, CalendarEventInput, CalendarProvider, CalendarRange } from "../src/types.js";

// Direct coverage for the calendar provider registry (untested module). Two
// behaviors are load-bearing:
//   - FAIL-SOFT fan-out: a failing remote provider (gcal/CalDAV 401, 5xx) must
//     be SWALLOWED so the local provider still yields events, with the failure
//     surfaced via diagnostics + onProviderError (daily-reliability hardening).
//   - HALLUCINATED-SENTINEL routing: the local Qwen invents provider ids like
//     "default"/"primary" (tool-calling.md); those (and blank) must resolve to
//     the primary provider, while a concrete unknown id still errors rather than
//     silently writing to the wrong calendar.

const ev = (id: string, providerId: string, startMs: number): CalendarEvent =>
  ({ allDay: false, endsAt: new Date(startMs + 1_000), id, providerId, startsAt: new Date(startMs), title: id });

const fakeProvider = (
  id: string,
  opts: { events?: readonly CalendarEvent[]; fail?: string } = {}
): CalendarProvider & { created: CalendarEventInput[] } => {
  const created: CalendarEventInput[] = [];
  return {
    created,
    createEvent: async (input: CalendarEventInput) => { created.push(input); return { ...ev(`${id}-new`, id, 0), ...input, id: `${id}-new`, providerId: id }; },
    deleteEvent: async () => undefined,
    describe: () => ({ credentials: [], description: "", displayName: id, id, local: id === "local" }),
    id,
    listEvents: async () => { if (opts.fail) throw new Error(opts.fail); return opts.events ?? []; },
    updateEvent: async (eventId: string) => ev(eventId, id, 0)
  } as CalendarProvider & { created: CalendarEventInput[] };
};

const RANGE: CalendarRange = { from: new Date(0), to: new Date(99_999) };

describe("CalendarProviderRegistry — registration & lookup", () => {
  it("registers, lists, describes, reports has(), and exposes the first provider as primary", () => {
    const registry = new CalendarProviderRegistry([fakeProvider("local"), fakeProvider("google")]);
    expect(registry.list().map((p) => p.id)).toEqual(["local", "google"]);
    expect(registry.describe().map((d) => d.id)).toEqual(["local", "google"]);
    expect(registry.has("google")).toBe(true);
    expect(registry.has("nope")).toBe(false);
    expect(registry.primary()?.id).toBe("local");
  });

  it("routes exact lookup only to the explicitly required capable provider", async () => {
    const local = fakeProvider("local");
    const exact = {
      ...fakeProvider("gcal"),
      resolveExactEvent: async ({ eventId, startsAt }: { eventId: string; startsAt: string }) =>
        ev(eventId, "gcal", Date.parse(startsAt))
    };
    const registry = new CalendarProviderRegistry([local, exact]);
    await expect(registry.resolveExactEvent("gcal", { eventId: "g1", startsAt: "1970-01-01T00:00:01.000Z" }))
      .resolves.toMatchObject({ id: "g1", providerId: "gcal" });
    expect(() => registry.resolveExactEvent("missing", { eventId: "g1", startsAt: "1970-01-01T00:00:01.000Z" }))
      .toThrow(/not registered/u);
    expect(() => registry.resolveExactEvent("local", { eventId: "g1", startsAt: "1970-01-01T00:00:01.000Z" }))
      .toThrow(/does not support exact lookup/u);
  });

  it("require() throws PROVIDER_NOT_FOUND with a registered-ids hint", () => {
    const registry = new CalendarProviderRegistry([fakeProvider("local")]);
    try {
      registry.require("google");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarProviderError);
      expect((error as CalendarProviderError).code).toBe("PROVIDER_NOT_FOUND");
      expect((error as Error).message).toContain("registered: local");
    }
  });
});

describe("CalendarProviderRegistry — listEvents fan-out", () => {
  it("concatenates every provider's events and sorts them (default, no providerId)", () => {
    const local = fakeProvider("local", { events: [ev("l1", "local", 2_000), ev("l2", "local", 1_000)] });
    const registry = new CalendarProviderRegistry([local]);
    return registry.listEvents(RANGE).then((events) => {
      expect(events.map((e) => e.id)).toEqual(["l2", "l1"]); // sorted by startsAt
    });
  });

  it("scopes to a single provider (unsorted, provider's own order) when a providerId is given", async () => {
    const local = fakeProvider("local", { events: [ev("l1", "local", 2_000), ev("l2", "local", 1_000)] });
    const registry = new CalendarProviderRegistry([local]);
    expect((await registry.listEvents(RANGE, "local")).map((e) => e.id)).toEqual(["l1", "l2"]);
  });

  it("is FAIL-SOFT: a failing provider is swallowed so plain listEvents still yields the rest", async () => {
    const local = fakeProvider("local", { events: [ev("l1", "local", 1_000)] });
    const google = fakeProvider("google", { fail: "401 unauthorized" });
    const registry = new CalendarProviderRegistry([local, google]);
    expect((await registry.listEvents(RANGE)).map((e) => e.id)).toEqual(["l1"]); // google's failure didn't break the list
  });

  it("surfaces a swallowed failure via diagnostics + onProviderError (once per list call)", async () => {
    const local = fakeProvider("local", { events: [ev("l1", "local", 1_000)] });
    const google = fakeProvider("google", { fail: "401 unauthorized" });
    const seen: string[] = [];
    const registry = new CalendarProviderRegistry([local, google], { onProviderError: (id, m) => seen.push(`${id}:${m}`) });
    const diag = await registry.listEventsWithDiagnostics(RANGE);
    expect(diag.events.map((e) => e.id)).toEqual(["l1"]);
    expect(diag.failedProviders).toEqual([{ message: "401 unauthorized", providerId: "google" }]);
    expect(seen).toEqual(["google:401 unauthorized"]); // one call → one callback
  });
});

describe("CalendarProviderRegistry — mutation routing & hallucinated sentinels", () => {
  it("routes createEvent to the PRIMARY for a sentinel id ('default'/'primary'), blank, or undefined", async () => {
    const registry = new CalendarProviderRegistry([fakeProvider("local"), fakeProvider("google")]);
    const input: CalendarEventInput = { endsAt: new Date(1), startsAt: new Date(0), title: "x" };
    for (const sentinel of ["default", "PRIMARY", "  ", undefined] as const) {
      expect((await registry.createEvent(sentinel, input)).providerId).toBe("local");
    }
  });

  it("still routes a concrete known id, and errors on a concrete UNKNOWN id (never silently writes to the wrong calendar)", async () => {
    const registry = new CalendarProviderRegistry([fakeProvider("local"), fakeProvider("google")]);
    const input: CalendarEventInput = { endsAt: new Date(1), startsAt: new Date(0), title: "x" };
    expect((await registry.createEvent("google", input)).providerId).toBe("google");
    // NOTE: the resolution error is thrown SYNCHRONOUSLY (the method returns the
    // provider's promise but require() throws before that) — assert the real
    // contract with toThrow, not .rejects. (Sync/async-reject inconsistency
    // recorded in the README Rejected ledger as a noted footgun, not fixed.)
    expect(() => registry.createEvent("gcal-typo", input)).toThrow(/not registered/u);
  });

  it("throws NO_PROVIDERS (synchronously) when creating with no providers registered", () => {
    const registry = new CalendarProviderRegistry([]);
    expect(() => registry.createEvent("default", { endsAt: new Date(1), startsAt: new Date(0), title: "x" }))
      .toThrow(/No calendar provider is registered/u);
  });

  it("routes update/delete to the required provider, throwing synchronously for an unknown provider", async () => {
    const registry = new CalendarProviderRegistry([fakeProvider("local")]);
    expect((await registry.updateEvent("local", "e1", { title: "renamed" })).providerId).toBe("local");
    await expect(registry.deleteEvent("local", "e1")).resolves.toBeUndefined();
    expect(() => registry.deleteEvent("google", "e1")).toThrow(/not registered/u);
  });
});

describe("compareCalendarEvents", () => {
  it("orders by startsAt, then providerId, then id", () => {
    expect(compareCalendarEvents(ev("a", "p", 1_000), ev("b", "p", 2_000))).toBeLessThan(0); // earlier start first
    expect(compareCalendarEvents(ev("a", "z", 1_000), ev("a", "a", 1_000))).toBeGreaterThan(0); // same start → providerId
    expect(compareCalendarEvents(ev("b", "p", 1_000), ev("a", "p", 1_000))).toBeGreaterThan(0); // same start+provider → id
  });
});
