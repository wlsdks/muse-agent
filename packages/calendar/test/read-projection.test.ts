import { describe, expect, it } from "vitest";

import {
  projectCalendarRead,
  type CalendarReadEvent,
  type CalendarReadProjectionRequest
} from "../src/index.js";

const RANGE = {
  from: new Date("2026-08-01T09:00:00.000Z"),
  to: new Date("2026-08-01T13:00:00.000Z")
};

function event(over: Partial<CalendarReadEvent> = {}): CalendarReadEvent {
  return {
    allDay: false,
    attendees: ["private@example.com"],
    endsAt: new Date("2026-08-01T11:00:00.000Z"),
    id: "event_private",
    location: "Private clinic",
    notes: "Sensitive appointment details",
    providerId: "local",
    raw: { secret: "RAW_PRIVATE_SECRET" },
    startsAt: new Date("2026-08-01T10:00:00.000Z"),
    title: "Private appointment",
    url: "https://calendar.invalid/private",
    ...over
  };
}

function request(
  over: Partial<CalendarReadProjectionRequest> = {}
): CalendarReadProjectionRequest {
  return {
    authority: {
      grantedBy: "owner",
      id: "calendar-read-01",
      providerId: "local",
      scope: "availability-only"
    },
    events: [event()],
    providerId: "local",
    range: RANGE,
    ...over
  };
}

describe("projectCalendarRead", () => {
  it("projects availability without leaking event details", () => {
    const input = request();
    const before = JSON.stringify(input);
    const first = projectCalendarRead(input);
    const second = projectCalendarRead(input);
    const bytes = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first).toEqual({
      authority: {
        eventDetails: "none",
        providerFallback: "forbidden"
      },
      busy: [{
        endsAt: "2026-08-01T11:00:00.000Z",
        startsAt: "2026-08-01T10:00:00.000Z"
      }],
      free: [
        {
          endsAt: "2026-08-01T10:00:00.000Z",
          startsAt: "2026-08-01T09:00:00.000Z"
        },
        {
          endsAt: "2026-08-01T13:00:00.000Z",
          startsAt: "2026-08-01T11:00:00.000Z"
        }
      ],
      providerId: "local",
      scope: "availability-only",
      status: "ok"
    });
    for (const secret of [
      "event_private",
      "Private appointment",
      "private@example.com",
      "Private clinic",
      "Sensitive appointment details",
      "RAW_PRIVATE_SECRET",
      "calendar.invalid"
    ]) {
      expect(bytes).not.toContain(secret);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.status === "ok" && Object.isFrozen(first.busy)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("exposes bounded event details only with exact detail authority", () => {
    const result = projectCalendarRead(request({
      authority: {
        grantedBy: "owner",
        id: "calendar-detail-01",
        providerId: "local",
        scope: "event-details"
      }
    }));

    expect(result).toMatchObject({
      authority: {
        eventDetails: "explicit-owner",
        providerFallback: "forbidden"
      },
      events: [{
        attendees: ["private@example.com"],
        eventId: "event_private",
        location: "Private clinic",
        notes: "Sensitive appointment details",
        title: "Private appointment"
      }],
      providerId: "local",
      scope: "event-details",
      status: "ok"
    });
    expect(JSON.stringify(result)).not.toContain("RAW_PRIVATE_SECRET");
  });

  it("fails closed on provider drift and hidden or symbol authority fields", () => {
    expect(projectCalendarRead(request({
      events: [event({ providerId: "google" })]
    }))).toMatchObject({
      reason: "provider-mismatch",
      status: "denied"
    });
    expect(projectCalendarRead(request({
      authority: {
        grantedBy: "owner",
        id: "calendar-read-01",
        providerId: "google",
        scope: "availability-only"
      }
    }))).toMatchObject({
      reason: "provider-mismatch",
      status: "denied"
    });

    const hidden = request();
    Object.defineProperty(hidden.authority, "fallbackProviderId", {
      enumerable: false,
      value: "google"
    });
    expect(projectCalendarRead(hidden)).toMatchObject({
      reason: "invalid-input",
      status: "denied"
    });

    const symbol = request();
    (symbol.authority as CalendarReadProjectionRequest["authority"] & {
      [key: symbol]: unknown;
    })[Symbol("detailPermission")] = true;
    expect(projectCalendarRead(symbol)).toMatchObject({
      reason: "invalid-input",
      status: "denied"
    });

    const inheritedAuthority = Object.assign(
      Object.create({ detailPermission: true }) as CalendarReadProjectionRequest["authority"],
      request().authority
    );
    expect(projectCalendarRead(request({ authority: inheritedAuthority }))).toMatchObject({
      reason: "invalid-input",
      status: "denied"
    });

    const hiddenRequired = request();
    Object.defineProperty(hiddenRequired.authority, "scope", {
      configurable: true,
      enumerable: false,
      value: "event-details"
    });
    expect(projectCalendarRead(hiddenRequired)).toMatchObject({
      reason: "invalid-input",
      status: "denied"
    });

    let getterReads = 0;
    const escalatingAuthority = {
      grantedBy: "owner",
      id: "calendar-read-01",
      providerId: "local"
    } as unknown as CalendarReadProjectionRequest["authority"];
    Object.defineProperty(escalatingAuthority, "scope", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? "availability-only" : "event-details";
      }
    });
    const escalating = projectCalendarRead(request({
      authority: escalatingAuthority
    }));
    expect(escalating).toMatchObject({
      reason: "invalid-input",
      status: "denied"
    });
    expect(getterReads).toBe(0);
    expect(JSON.stringify(escalating)).not.toContain("Private appointment");
  });
});
