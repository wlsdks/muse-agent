import { CalendarProviderError } from "./errors.js";

import type { CalendarEvent, CalendarEventLocator } from "./types.js";

const PREFIX = "cev1_";
const MAX_EVENT_ID_LENGTH = 1_024;
const MAX_REFERENCE_LENGTH = 2_048;

function assertLocator(locator: CalendarEventLocator): void {
  if (typeof locator.eventId !== "string"
    || locator.eventId.length === 0
    || locator.eventId.length > MAX_EVENT_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(locator.eventId)) {
    throw new Error("calendar event locator has an invalid event id");
  }
  if (typeof locator.startsAt !== "string"
    || !Number.isFinite(Date.parse(locator.startsAt))
    || new Date(locator.startsAt).toISOString() !== locator.startsAt) {
    throw new Error("calendar event locator has a non-canonical start instant");
  }
}

/** Stable, copyable Continuity identity; separate from provider mutation IDs. */
export function encodeCalendarEventReference(event: Pick<CalendarEvent, "id" | "providerEventId" | "startsAt">): string {
  const locator = { eventId: event.providerEventId ?? event.id, startsAt: event.startsAt.toISOString() };
  assertLocator(locator);
  return `${PREFIX}${Buffer.from(JSON.stringify([locator.eventId, locator.startsAt]), "utf8").toString("base64url")}`;
}

/** Strict canonical decoder. Alternate JSON/base64 spellings are rejected. */
export function decodeCalendarEventReference(reference: string): CalendarEventLocator {
  if (typeof reference !== "string" || reference.length > MAX_REFERENCE_LENGTH || !reference.startsWith(PREFIX)) {
    throw new Error("calendar event reference must be a bounded cev1 reference");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(reference.slice(PREFIX.length), "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("calendar event reference is malformed");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
    throw new Error("calendar event reference is malformed");
  }
  const locator = { eventId: parsed[0], startsAt: parsed[1] };
  assertLocator(locator);
  if (encodeCalendarEventReference({ id: locator.eventId, startsAt: new Date(locator.startsAt) }) !== reference) {
    throw new Error("calendar event reference is not canonical");
  }
  return locator;
}

/** Select exactly one provider result. Never substitutes a nearby event. */
export function selectExactCalendarEvent(
  events: readonly CalendarEvent[],
  locator: CalendarEventLocator,
  providerId: string
): CalendarEvent | undefined {
  const matches = events.filter((event) => event.providerId === providerId
    && (event.providerEventId ?? event.id) === locator.eventId
    && event.startsAt.toISOString() === locator.startsAt);
  if (matches.length > 1) {
    throw new CalendarProviderError(providerId, "AMBIGUOUS_EVENT", `Calendar event reference is ambiguous: ${locator.eventId}`);
  }
  return matches[0];
}
