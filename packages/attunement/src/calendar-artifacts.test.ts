import { CalendarProviderRegistry, encodeCalendarEventReference, type CalendarEvent, type CalendarProvider } from "@muse/calendar";
import { describe, expect, it } from "vitest";

import { createCalendarArtifactValidator, createCalendarExactArtifactResolver } from "./calendar-artifacts.js";

const EVENT: CalendarEvent = {
  allDay: false,
  endsAt: new Date("2026-07-22T10:00:00.000Z"),
  id: "event/opaque",
  location: "  Dentist office  ",
  notes: "  Bring the referral letter  ",
  providerId: "gcal",
  raw: { attendees: ["must-not-leak"] },
  startsAt: new Date("2026-07-22T09:00:00.000Z"),
  title: "  Dentist appointment  "
};

function provider(event: CalendarEvent | undefined = EVENT): CalendarProvider & {
  resolveExactEvent(locator: { readonly eventId: string; readonly startsAt: string }): Promise<CalendarEvent | undefined>;
} {
  return {
    createEvent: async () => { throw new Error("not used"); },
    deleteEvent: async () => { throw new Error("not used"); },
    describe: () => ({ credentials: [], description: "", displayName: "Google", id: "gcal", local: false }),
    id: "gcal",
    listEvents: async () => [],
    resolveExactEvent: async (locator) => event?.id === locator.eventId && event.startsAt.toISOString() === locator.startsAt ? event : undefined,
    updateEvent: async () => { throw new Error("not used"); }
  };
}

const link = (artifactId: string) => ({
  artifactId,
  artifactType: "calendar-event" as const,
  linkedAt: "2026-07-22T00:00:00.000Z",
  linkedBy: "user" as const,
  providerId: "calendar:gcal",
  role: "context" as const,
  threadId: "thread_life"
});

describe("calendar Continuity artifact adapter", () => {
  it("validates one registered provider and projects only bounded canonical fields", async () => {
    const registry = new CalendarProviderRegistry([provider()]);
    const reference = encodeCalendarEventReference(EVENT);
    await expect(createCalendarArtifactValidator(registry)({ artifactId: reference, artifactType: "calendar-event", providerId: "calendar:gcal" }))
      .resolves.toEqual({ artifactId: reference, artifactType: "calendar-event", providerId: "calendar:gcal" });
    await expect(createCalendarExactArtifactResolver(registry)(link(reference))).resolves.toEqual({
      artifactId: reference,
      artifactType: "calendar-event",
      calendarAllDay: false,
      calendarEndsAt: "2026-07-22T10:00:00.000Z",
      calendarLocation: "Dentist office",
      calendarStartsAt: "2026-07-22T09:00:00.000Z",
      providerId: "calendar:gcal",
      role: "context",
      summary: "Bring the referral letter",
      title: "Dentist appointment"
    });
  });

  it("rejects unregistered/double-prefixed providers while removal resolves unavailable", async () => {
    const registry = new CalendarProviderRegistry([provider()]);
    const reference = encodeCalendarEventReference(EVENT);
    const validate = createCalendarArtifactValidator(registry);
    await expect(validate({ artifactId: reference, artifactType: "calendar-event", providerId: "calendar:missing" })).rejects.toThrow("not registered");
    await expect(validate({ artifactId: reference, artifactType: "calendar-event", providerId: "calendar:calendar:gcal" })).rejects.toThrow("not registered");
    await expect(createCalendarExactArtifactResolver(new CalendarProviderRegistry())(link(reference))).resolves.toBeUndefined();
  });
});
