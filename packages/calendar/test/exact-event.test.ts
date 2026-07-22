import { describe, expect, it } from "vitest";

import {
  CalendarProviderError,
  decodeCalendarEventReference,
  encodeCalendarEventReference,
  selectExactCalendarEvent,
  type CalendarEvent
} from "../src/index.js";

function event(input: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    endsAt: new Date("2026-07-22T10:00:00.000Z"),
    id: "series/opaque-id",
    providerId: "local",
    startsAt: new Date("2026-07-22T09:00:00.000Z"),
    title: "Dentist",
    ...input
  };
}

describe("calendar event Continuity references", () => {
  it("round-trips one provider event id and exact occurrence start canonically", () => {
    const reference = encodeCalendarEventReference(event());
    expect(reference).toMatch(/^cev1_[A-Za-z0-9_-]+$/u);
    expect(decodeCalendarEventReference(reference)).toEqual({
      eventId: "series/opaque-id",
      startsAt: "2026-07-22T09:00:00.000Z"
    });
    expect(encodeCalendarEventReference(event())).toBe(reference);
  });

  it("gives adjacent occurrences distinct identities without changing event ids", () => {
    const first = event();
    const second = event({ startsAt: new Date("2026-07-29T09:00:00.000Z") });
    expect(first.id).toBe(second.id);
    expect(encodeCalendarEventReference(first)).not.toBe(encodeCalendarEventReference(second));
  });

  it("uses the raw provider mutation id for a list-suffixed occurrence", () => {
    const occurrence = event({ id: "series/opaque-id-2", providerEventId: "series/opaque-id" });
    expect(decodeCalendarEventReference(encodeCalendarEventReference(occurrence))).toEqual({
      eventId: "series/opaque-id",
      startsAt: "2026-07-22T09:00:00.000Z"
    });
    expect(selectExactCalendarEvent([occurrence], { eventId: "series/opaque-id", startsAt: "2026-07-22T09:00:00.000Z" }, "local"))
      .toBe(occurrence);
  });

  it.each([
    "",
    "cev1_not-json",
    `cev1_${Buffer.from(JSON.stringify(["id", "2026-07-22T09:00:00Z"])).toString("base64url")}`,
    `cev1_${Buffer.from(JSON.stringify(["", "2026-07-22T09:00:00.000Z"])).toString("base64url")}`,
    `cev1_${Buffer.from(JSON.stringify(["id", "bad"])).toString("base64url")}`,
    `cev1_${Buffer.from(JSON.stringify(["id", "2026-07-22T09:00:00.000Z", "extra"])).toString("base64url")}`
  ])("rejects malformed or non-canonical reference %s", (reference) => {
    expect(() => decodeCalendarEventReference(reference)).toThrow();
  });

  it("selects only the exact provider/id/start and fails closed on duplicates", () => {
    const target = event();
    const locator = decodeCalendarEventReference(encodeCalendarEventReference(target));
    expect(selectExactCalendarEvent([
      event({ providerId: "gcal" }),
      event({ id: "other" }),
      event({ startsAt: new Date("2026-07-22T09:01:00.000Z") }),
      target
    ], locator, "local")).toBe(target);
    expect(selectExactCalendarEvent([], locator, "local")).toBeUndefined();
    expect(() => selectExactCalendarEvent([target, { ...target }], locator, "local"))
      .toThrowError(CalendarProviderError);
  });
});
