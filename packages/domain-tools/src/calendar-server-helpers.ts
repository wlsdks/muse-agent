import type { CalendarEvent, CalendarProviderRegistry } from "@muse/calendar";
import { formatDueLocal, isoDateHeadRoundTrips, resolveRelativeTimePhrase } from "@muse/mcp-shared";
import { errorMessage } from "@muse/mcp";
import type { JsonObject, JsonValue } from "@muse/shared";

/**
 * Non-tool-definition calendar logic lifted out of `loopback-calendar.ts` —
 * the event-ref resolver, serialize/format helpers, and time-anchoring
 * parser. `loopback-calendar.ts` keeps the MCP tool surface itself
 * (name/description/schema/execute wiring, byte-stable for tool-calling)
 * and re-exports the symbols below so its import sites stay unchanged.
 */

export interface EventRefLike {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAt: Date;
  // The resolved events come from `listEvents` (full CalendarEvents), so this is
  // present at runtime; optional only so hand-built test fixtures stay valid.
  readonly endsAt?: Date;
}

export type EventRefResolution =
  | { readonly status: "resolved"; readonly event: EventRefLike }
  | { readonly status: "ambiguous"; readonly candidates: readonly EventRefLike[] }
  | { readonly status: "not-found" };

/**
 * Resolve a calendar event the agent named — its exact id OR a distinct word
 * from its title ('dentist') — so `update` / `delete` work in ONE shot instead
 * of forcing the small model to chain list → find-id → act. Exact-id wins;
 * otherwise a case-insensitive title-substring match: a unique hit resolves, two+
 * return the candidates (never guess), zero is not-found. Pure (mirrors
 * resolveReminderRef / resolveTaskRef).
 */
export function resolveEventByRef(events: readonly EventRefLike[], ref: string): EventRefResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const byId = events.find((event) => event.id === trimmed);
  if (byId) {
    return { event: byId, status: "resolved" };
  }
  const lower = trimmed.toLowerCase();
  const byTitle = events.filter((event) => event.title.toLowerCase().includes(lower));
  if (byTitle.length === 1) {
    return { event: byTitle[0]!, status: "resolved" };
  }
  if (byTitle.length > 1) {
    return { candidates: byTitle, status: "ambiguous" };
  }
  return { status: "not-found" };
}

// List a generous window and resolve the agent's event ref (id OR title word)
// so update/delete don't force a list→find-id→act chain. Returns the matched
// event, or an error payload (ambiguous → candidates with local times).
export async function resolveEventForAction(
  registry: CalendarProviderRegistry,
  ref: string,
  providerId: string | undefined
): Promise<{ readonly event: EventRefLike } | { readonly error: string; readonly candidates?: JsonValue }> {
  const from = new Date(Date.now() - 30 * 86_400_000);
  const to = new Date(Date.now() + 365 * 86_400_000);
  let events;
  try {
    events = await registry.listEvents({ from, to }, providerId);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  const resolution = resolveEventByRef(events, ref);
  if (resolution.status === "ambiguous") {
    return {
      candidates: resolution.candidates.map((event) => ({ id: event.id, startsAtLocal: eventLocal(event.startsAt, false), title: event.title })) as JsonValue,
      error: `"${ref}" matches multiple events — say which one`
    };
  }
  if (resolution.status !== "resolved") {
    return { error: `event not found: ${ref}` };
  }
  return { event: resolution.event };
}

// The local-timezone rendering the chat model should echo. An all-day event
// has no meaningful clock time (its startsAt is local midnight), so show the
// date only — otherwise `formatDueLocal` would read it back as "12:00 AM".
export function eventLocal(when: Date, allDay: boolean): string {
  return allDay
    ? when.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" })
    : formatDueLocal(when.toISOString());
}

export function serializeEvent(event: CalendarEvent): JsonObject {
  return {
    allDay: event.allDay,
    endsAtIso: event.endsAt.toISOString(),
    endsAtLocal: eventLocal(event.endsAt, event.allDay),
    id: event.id,
    providerId: event.providerId,
    startsAtIso: event.startsAt.toISOString(),
    startsAtLocal: eventLocal(event.startsAt, event.allDay),
    title: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
    ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] as JsonValue } : {}),
    ...(event.url ? { url: event.url } : {})
  };
}

export function parseIsoDate(value: string | undefined, anchor: () => Date = () => new Date()): Date | undefined {
  if (!value) {
    return undefined;
  }
  const dateHead = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateHead) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      // `new Date("2026-02-30")` silently rolls over to Mar 2 — accepting it would
      // schedule the event ~2 days off. A real date round-trips its Y-M-D through
      // Date.UTC unchanged; a rolled-over one does not. Mirrors parseTaskDueAt.
      if (isoDateHeadRoundTrips(Number(dateHead[1]), Number(dateHead[2]), Number(dateHead[3]))) {
        return parsed;
      }
      return undefined;
    }
  }
  return resolveRelativeTimePhrase(value, anchor);
}
