import {
  decodeCalendarEventReference,
  encodeCalendarEventReference,
  type CalendarEvent,
  type CalendarProviderRegistry
} from "@muse/calendar";

import { AttunementStoreError } from "./attunement-store.js";
import { calendarProviderId } from "./types.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver, ResolvedArtifact } from "./types.js";

function rawCalendarProviderId(providerId: string): string | undefined {
  return providerId.startsWith("calendar:") ? providerId.slice("calendar:".length) : undefined;
}

function bounded(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function projectCalendarEvent(event: CalendarEvent, artifactId: string, providerId: string, role: "context" | "next-step"): ResolvedArtifact | undefined {
  const title = bounded(event.title);
  if (!title
    || event.providerId !== rawCalendarProviderId(providerId)
    || !Number.isFinite(event.startsAt.getTime())
    || !Number.isFinite(event.endsAt.getTime())
    || event.endsAt.getTime() < event.startsAt.getTime()) return undefined;
  const location = bounded(event.location);
  const summary = bounded(event.notes);
  return {
    artifactId,
    artifactType: "calendar-event",
    providerId,
    role,
    calendarAllDay: event.allDay,
    calendarEndsAt: event.endsAt.toISOString(),
    ...(location ? { calendarLocation: location } : {}),
    calendarStartsAt: event.startsAt.toISOString(),
    ...(summary ? { summary } : {}),
    title
  };
}

/** Runtime registration + exact occurrence validation; never selects a primary provider. */
export function createCalendarArtifactValidator(registry: CalendarProviderRegistry): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType !== "calendar-event") throw new AttunementStoreError("calendar validation requires a calendar-event");
    const rawProviderId = rawCalendarProviderId(providerId);
    if (!rawProviderId || calendarProviderId(rawProviderId) !== providerId || !registry.has(rawProviderId)) {
      throw new AttunementStoreError(`calendar provider is not registered: ${rawProviderId ?? providerId}`);
    }
    let locator;
    try {
      locator = decodeCalendarEventReference(artifactId);
    } catch {
      throw new AttunementStoreError("calendar event reference is invalid");
    }
    const event = await registry.resolveExactEvent(rawProviderId, locator);
    if (!event || !projectCalendarEvent(event, artifactId, providerId, "context")) {
      throw new AttunementStoreError(`calendar event is unavailable: ${artifactId}`);
    }
    return { artifactId: encodeCalendarEventReference(event), artifactType, providerId };
  };
}

/** Resolve one already-linked calendar occurrence; removed providers are unavailable, not corrupt state. */
export function createCalendarExactArtifactResolver(registry: CalendarProviderRegistry): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType !== "calendar-event") return undefined;
    const rawProviderId = rawCalendarProviderId(link.providerId);
    if (!rawProviderId || !registry.has(rawProviderId)) return undefined;
    const locator = decodeCalendarEventReference(link.artifactId);
    const event = await registry.resolveExactEvent(rawProviderId, locator);
    return event ? projectCalendarEvent(event, link.artifactId, link.providerId, link.role) : undefined;
  };
}
