import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProviderRegistry
} from "@muse/calendar";
import type { JsonObject, JsonValue } from "@muse/shared";

import { readBoolean, readString, readStringArray, errorMessage } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";

/**
 * `muse.calendar` loopback MCP server.
 *
 * Lifted out of `loopback.ts` to keep the calendar tool surface and
 * its private serialize / arg-parse helpers in one cohesive module.
 * Same public surface as before: `CalendarMcpServerOptions` +
 * `createCalendarMcpServer`. Both symbols are re-exported from
 * `loopback.ts` so consumers (`packages/mcp/src/index.ts`,
 * autoconfigure, the existing tests) keep working without
 * import-site edits.
 */

export interface CalendarMcpServerOptions {
  readonly registry: CalendarProviderRegistry;
}

export function createCalendarMcpServer(options: CalendarMcpServerOptions): LoopbackMcpServer {
  const { registry } = options;

  return {
    description: "Personal calendar (provider-neutral: local file, Google Calendar, CalDAV, macOS).",
    name: "muse.calendar",
    tools: [
      {
        description:
          "List configured calendar providers (id, displayName, local). " +
          "Use `providerId` from this list to target a specific provider in other muse.calendar.* calls.",
        execute: async (): Promise<JsonObject> => ({
          providers: registry.describe().map((info) => ({
            description: info.description,
            displayName: info.displayName,
            id: info.id,
            local: info.local
          })) as JsonValue
        }),
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        domain: "calendar",
        name: "providers",
        risk: "read"
      },
      {
        description:
          "List events between `fromIso` and `toIso` (ISO 8601 timestamps). " +
          "If `providerId` is omitted, fans out across all providers. " +
          "Defaults: from = now, to = +30 days.",
        execute: async (args): Promise<JsonObject> => {
          const fromIso = readString(args, "fromIso");
          const toIso = readString(args, "toIso");
          const providerId = readString(args, "providerId");
          const from = parseIsoDate(fromIso) ?? new Date();
          const to = parseIsoDate(toIso) ?? new Date(from.getTime() + 30 * 86_400_000);
          try {
            const events = await registry.listEvents({ from, to }, providerId);
            return {
              events: events.map(serializeEvent) as JsonValue,
              total: events.length
            };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            fromIso: { description: "ISO 8601 start (default: now)", type: "string" },
            providerId: { description: "Specific provider id (default: all)", type: "string" },
            toIso: { description: "ISO 8601 end (default: now + 30 days)", type: "string" }
          },
          type: "object"
        },
        domain: "calendar",
        name: "list",
        risk: "read"
      },
      {
        description:
          "Create a new calendar event. `startsAtIso` is required; `endsAtIso` defaults to startsAt + 60 minutes. " +
          "Both fields accept either an ISO-8601 timestamp OR a relative phrase. " +
          "English: 'tomorrow 3pm', 'today at 14:30', 'in 2 hours', 'next Friday', 'next Monday at 9am'. " +
          "Korean: '내일 오후 3시', '오늘 14시 30분', '2시간 후', '다음 주 금요일', '다음 주 월요일 오전 9시'. " +
          "Pass the user's natural-language phrase directly (in their own language) — the server resolves it against the current local time. " +
          "If `providerId` is omitted, the primary (first registered) provider is used.",
        execute: async (args): Promise<JsonObject> => {
          const title = readString(args, "title")?.trim();
          const startsAtIso = readString(args, "startsAtIso");
          const endsAtIso = readString(args, "endsAtIso");
          const providerId = readString(args, "providerId");
          if (!title) {
            return { error: "title is required" };
          }
          const startsAt = parseIsoDate(startsAtIso);
          if (!startsAt) {
            return { error: "startsAtIso must be a valid ISO 8601 timestamp" };
          }
          const endsAt = parseIsoDate(endsAtIso) ?? new Date(startsAt.getTime() + 60 * 60_000);
          const allDay = readBoolean(args, "allDay") ?? false;
          const location = readString(args, "location") ?? undefined;
          const notes = readString(args, "notes") ?? undefined;
          const tags = readStringArray(args, "tags") ?? undefined;
          const input: CalendarEventInput = {
            allDay,
            endsAt,
            startsAt,
            title,
            ...(location ? { location } : {}),
            ...(notes ? { notes } : {}),
            ...(tags ? { tags } : {})
          };
          try {
            const created = await registry.createEvent(providerId, input);
            return { event: serializeEvent(created) as JsonValue };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            allDay: { type: "boolean" },
            endsAtIso: { type: "string" },
            location: { type: "string" },
            notes: { type: "string" },
            providerId: { type: "string" },
            startsAtIso: { type: "string" },
            tags: { items: { type: "string" }, type: "array" },
            title: { type: "string" }
          },
          required: ["title", "startsAtIso"],
          type: "object"
        },
        domain: "calendar",
        name: "add",
        risk: "write"
      },
      {
        description:
          "Update an existing calendar event by id (and providerId). Pass only the fields you want to change.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const id = readString(args, "id");
          if (!providerId || !id) {
            return { error: "providerId and id are required" };
          }
          const update: CalendarEventUpdate = {
            ...(readString(args, "title") ? { title: readString(args, "title")! } : {}),
            ...(readString(args, "startsAtIso") ? { startsAt: parseIsoDate(readString(args, "startsAtIso")!)! } : {}),
            ...(readString(args, "endsAtIso") ? { endsAt: parseIsoDate(readString(args, "endsAtIso")!)! } : {}),
            ...(readBoolean(args, "allDay") !== undefined ? { allDay: readBoolean(args, "allDay") } : {}),
            ...("location" in args ? { location: readString(args, "location") ?? null } : {}),
            ...("notes" in args ? { notes: readString(args, "notes") ?? null } : {})
          };
          try {
            const updated = await registry.updateEvent(providerId, id, update);
            return { event: serializeEvent(updated) as JsonValue };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            allDay: { type: "boolean" },
            endsAtIso: { type: "string" },
            id: { type: "string" },
            location: { type: "string" },
            notes: { type: "string" },
            providerId: { type: "string" },
            startsAtIso: { type: "string" },
            title: { type: "string" }
          },
          required: ["providerId", "id"],
          type: "object"
        },
        domain: "calendar",
        name: "update",
        risk: "write"
      },
      {
        description: "Delete a calendar event by providerId + id.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const id = readString(args, "id");
          if (!providerId || !id) {
            return { error: "providerId and id are required" };
          }
          try {
            await registry.deleteEvent(providerId, id);
            return { deleted: true, id, providerId };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            providerId: { type: "string" }
          },
          required: ["providerId", "id"],
          type: "object"
        },
        domain: "calendar",
        name: "delete",
        risk: "write"
      }
    ]
  };
}

function serializeEvent(event: CalendarEvent): JsonObject {
  return {
    allDay: event.allDay,
    endsAtIso: event.endsAt.toISOString(),
    id: event.id,
    providerId: event.providerId,
    startsAtIso: event.startsAt.toISOString(),
    title: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
    ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] as JsonValue } : {}),
    ...(event.url ? { url: event.url } : {})
  };
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return resolveRelativeTimePhrase(value, () => new Date());
}
