import type { CalendarEvent, CalendarRange } from "./types.js";

const REQUEST_KEYS = ["authority", "events", "providerId", "range"] as const;
const AUTHORITY_KEYS = ["grantedBy", "id", "providerId", "scope"] as const;
const RANGE_KEYS = ["from", "to"] as const;
const AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export interface CalendarReadAuthority {
  readonly grantedBy: "owner";
  readonly id: string;
  readonly providerId: string;
  readonly scope: "availability-only" | "event-details";
}

export interface CalendarReadEvent extends CalendarEvent {
  readonly attendees?: readonly string[];
}

export interface CalendarReadProjectionRequest {
  readonly authority: CalendarReadAuthority;
  readonly events: readonly CalendarReadEvent[];
  readonly providerId: string;
  readonly range: CalendarRange;
}

export type CalendarReadProjection =
  | {
      readonly authority: {
        readonly eventDetails: "none";
        readonly providerFallback: "forbidden";
      };
      readonly reason: "invalid-input" | "provider-mismatch";
      readonly status: "denied";
    }
  | {
      readonly authority: {
        readonly eventDetails: "none";
        readonly providerFallback: "forbidden";
      };
      readonly busy: readonly CalendarAvailabilityInterval[];
      readonly free: readonly CalendarAvailabilityInterval[];
      readonly providerId: string;
      readonly scope: "availability-only";
      readonly status: "ok";
    }
  | {
      readonly authority: {
        readonly eventDetails: "explicit-owner";
        readonly providerFallback: "forbidden";
      };
      readonly events: readonly CalendarEventDetailProjection[];
      readonly providerId: string;
      readonly scope: "event-details";
      readonly status: "ok";
    };

export interface CalendarAvailabilityInterval {
  readonly endsAt: string;
  readonly startsAt: string;
}

export interface CalendarEventDetailProjection {
  readonly allDay: boolean;
  readonly attendees?: readonly string[];
  readonly endsAt: string;
  readonly eventId: string;
  readonly location?: string;
  readonly notes?: string;
  readonly startsAt: string;
  readonly tags?: readonly string[];
  readonly title: string;
  readonly url?: string;
}

/**
 * Project one already-fetched, exact-provider snapshot according to a bounded
 * read authority. This function never selects or calls another provider.
 */
export function projectCalendarRead(
  request: CalendarReadProjectionRequest
): CalendarReadProjection {
  if (!isCalendarReadRequest(request)) return denied("invalid-input");
  const authorizedProviderId = request.authority.providerId;
  const scope = request.authority.scope;
  const providerId = request.providerId;
  const events = [...request.events];
  const range = {
    from: new Date(request.range.from.getTime()),
    to: new Date(request.range.to.getTime())
  };
  if (
    authorizedProviderId !== providerId
    || events.some((event) => event.providerId !== providerId)
  ) return denied("provider-mismatch");

  if (scope === "availability-only") {
    const rangeStart = range.from.getTime();
    const rangeEnd = range.to.getTime();
    const busy = mergeIntervals(events.flatMap((event): CalendarAvailabilityInterval[] => {
      const startsAt = Math.max(rangeStart, event.startsAt.getTime());
      const endsAt = Math.min(rangeEnd, event.endsAt.getTime());
      return startsAt < endsAt
        ? [{ endsAt: new Date(endsAt).toISOString(), startsAt: new Date(startsAt).toISOString() }]
        : [];
    }));
    return Object.freeze({
      authority: Object.freeze({
        eventDetails: "none",
        providerFallback: "forbidden"
      }),
      busy,
      free: freeIntervals(busy, range),
      providerId,
      scope: "availability-only",
      status: "ok"
    });
  }

  const detailEvents = events
    .filter((event) =>
      event.startsAt.getTime() < range.to.getTime()
      && event.endsAt.getTime() > range.from.getTime()
    )
    .sort((left, right) =>
      left.startsAt.getTime() - right.startsAt.getTime()
      || left.id.localeCompare(right.id)
    )
    .map((event): CalendarEventDetailProjection => Object.freeze({
      allDay: event.allDay,
      ...(event.attendees
        ? { attendees: Object.freeze([...event.attendees]) }
        : {}),
      endsAt: event.endsAt.toISOString(),
      eventId: event.id,
      ...(event.location ? { location: event.location } : {}),
      ...(event.notes ? { notes: event.notes } : {}),
      startsAt: event.startsAt.toISOString(),
      ...(event.tags ? { tags: Object.freeze([...event.tags]) } : {}),
      title: event.title,
      ...(event.url ? { url: event.url } : {})
    }));
  return Object.freeze({
    authority: Object.freeze({
      eventDetails: "explicit-owner",
      providerFallback: "forbidden"
    }),
    events: Object.freeze(detailEvents),
    providerId,
    scope: "event-details",
    status: "ok"
  });
}

function denied(reason: "invalid-input" | "provider-mismatch"): CalendarReadProjection {
  return Object.freeze({
    authority: Object.freeze({
      eventDetails: "none",
      providerFallback: "forbidden"
    }),
    reason,
    status: "denied"
  });
}

function isCalendarReadRequest(value: unknown): value is CalendarReadProjectionRequest {
  if (!hasExactOwnKeys(value, REQUEST_KEYS)
    || !hasExactOwnKeys(value.authority, AUTHORITY_KEYS)
    || !hasExactOwnKeys(value.range, RANGE_KEYS)
    || value.authority.grantedBy !== "owner"
    || typeof value.authority.id !== "string"
    || !AUTHORITY_ID.test(value.authority.id)
    || !isProviderId(value.authority.providerId)
    || (value.authority.scope !== "availability-only"
      && value.authority.scope !== "event-details")
    || !isProviderId(value.providerId)
    || !Array.isArray(value.events)
    || !(value.range.from instanceof Date)
    || !(value.range.to instanceof Date)
    || !Number.isFinite(value.range.from.getTime())
    || !Number.isFinite(value.range.to.getTime())
    || value.range.from.getTime() >= value.range.to.getTime()
  ) return false;
  return value.events.every(isCalendarReadEvent);
}

function isCalendarReadEvent(value: unknown): value is CalendarReadEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CalendarReadEvent>;
  return typeof event.id === "string" && event.id.length > 0
    && isProviderId(event.providerId)
    && typeof event.title === "string"
    && event.title.length > 0
    && event.startsAt instanceof Date
    && event.endsAt instanceof Date
    && Number.isFinite(event.startsAt.getTime())
    && Number.isFinite(event.endsAt.getTime())
    && event.startsAt.getTime() < event.endsAt.getTime()
    && typeof event.allDay === "boolean"
    && (event.attendees === undefined
      || (Array.isArray(event.attendees)
        && event.attendees.every((attendee) => typeof attendee === "string")));
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function hasExactOwnKeys<T extends readonly string[]>(
  value: unknown,
  expected: T
): value is Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => {
      if (typeof key !== "string" || !expected.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
}

function mergeIntervals(
  intervals: readonly CalendarAvailabilityInterval[]
): readonly CalendarAvailabilityInterval[] {
  const ordered = [...intervals].sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt)
    || left.endsAt.localeCompare(right.endsAt)
  );
  const merged: Array<{ endsAt: string; startsAt: string }> = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval.startsAt > previous.endsAt) {
      merged.push({ ...interval });
    } else if (interval.endsAt > previous.endsAt) {
      previous.endsAt = interval.endsAt;
    }
  }
  return Object.freeze(merged.map((interval) => Object.freeze(interval)));
}

function freeIntervals(
  busy: readonly CalendarAvailabilityInterval[],
  range: CalendarRange
): readonly CalendarAvailabilityInterval[] {
  const free: CalendarAvailabilityInterval[] = [];
  let cursor = range.from.toISOString();
  const end = range.to.toISOString();
  for (const interval of busy) {
    if (cursor < interval.startsAt) {
      free.push(Object.freeze({ endsAt: interval.startsAt, startsAt: cursor }));
    }
    cursor = interval.endsAt;
  }
  if (cursor < end) free.push(Object.freeze({ endsAt: end, startsAt: cursor }));
  return Object.freeze(free);
}
