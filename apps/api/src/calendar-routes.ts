/**
 * `/api/calendar/*` routes — extracted from `server-routes.ts` so the
 * calendar surface (one of the personal-domain trio: notes / tasks /
 * calendar) lives in its own module.
 *
 * Public registrar `registerCalendarRoutes` is re-exported from
 * `server-routes.ts` so `server.ts` (and any future imports) keep
 * working through the existing `./server-routes.js` path.
 *
 * Endpoints:
 *   - GET    /api/calendar/providers — describe registered providers
 *   - GET    /api/calendar/events — list events in a date range,
 *     optionally scoped to a single provider
 *   - GET    /api/calendar/credentials — list provider ids with
 *     stored credentials (only when a credential store is configured)
 *   - PUT    /api/calendar/credentials/:providerId — save credentials
 *   - DELETE /api/calendar/credentials/:providerId — remove credentials
 */

import type { CalendarCredentialStore, CalendarProviderRegistry } from "@muse/calendar";
import type { ResolvedIntegrationEnvironment } from "@muse/autoconfigure";
import { errorMessage, type JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";
import { syncRemindersOnEventDelete } from "@muse/domain-tools";
import { resolveRemindersFile } from "@muse/autoconfigure";

interface CalendarRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly registry: CalendarProviderRegistry;
  readonly credentialStore?: CalendarCredentialStore;
  readonly integrationEnv: ResolvedIntegrationEnvironment;
}

const LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED = {
  code: "LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED",
  message: "Remote calendar and messaging integrations are disabled while MUSE_LOCAL_ONLY=true."
} as const;

export function registerCalendarRoutes(server: FastifyInstance, gate: CalendarRoutesGate): void {
  server.get("/api/calendar/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    return {
      enabled: gate.registry.list().map((provider) => provider.id),
      providers: gate.registry.describe()
    };
  });

  server.get("/api/calendar/events", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const query = request.query as { readonly fromIso?: string; readonly toIso?: string; readonly providerId?: string } | undefined;
    const fromResult = parseOptionalIsoQueryParam(query?.fromIso);
    if (fromResult.kind === "invalid") {
      return reply.status(400).send({
        code: "INVALID_FROM_ISO",
        message: `fromIso must be a parseable ISO timestamp (got '${fromResult.raw}')`
      });
    }
    const from = fromResult.kind === "explicit" ? fromResult.date : new Date();
    const toResult = parseOptionalIsoQueryParam(query?.toIso);
    if (toResult.kind === "invalid") {
      return reply.status(400).send({
        code: "INVALID_TO_ISO",
        message: `toIso must be a parseable ISO timestamp (got '${toResult.raw}')`
      });
    }
    const to = toResult.kind === "explicit" ? toResult.date : new Date(from.getTime() + 30 * 86_400_000);
    try {
      const events = await gate.registry.listEvents({ from, to }, query?.providerId);
      return {
        events: events.map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          id: event.id,
          location: event.location ?? null,
          notes: event.notes ?? null,
          providerId: event.providerId,
          startsAtIso: event.startsAt.toISOString(),
          tags: event.tags ?? [],
          title: event.title,
          url: event.url ?? null
        })),
        total: events.length
      };
    } catch (error) {
      return reply.status(502).send({ code: "CALENDAR_LIST_FAILED", message: errorMessage(error, "Calendar list failed") });
    }
  });

  // Writing to the user's OWN calendar is a state change but not an
  // outbound-to-human action (outbound-safety.md), so the user's
  // explicit create/delete is allowed directly here.
  server.post("/api/calendar/events", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = (request.body as {
      title?: string;
      startsAtIso?: string;
      endsAtIso?: string;
      allDay?: boolean;
      location?: string;
      notes?: string;
      providerId?: string;
    } | undefined) ?? {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const startsAt = body.startsAtIso ? new Date(body.startsAtIso) : new Date(NaN);
    const endsAt = body.endsAtIso ? new Date(body.endsAtIso) : new Date(NaN);
    if (title.length === 0) {
      return reply.status(400).send({ code: "INVALID_EVENT", message: "title is required" });
    }
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return reply.status(400).send({ code: "INVALID_EVENT", message: "startsAtIso and endsAtIso must be parseable ISO timestamps" });
    }
    try {
      const event = await gate.registry.createEvent(body.providerId, {
        endsAt,
        startsAt,
        title,
        ...(typeof body.allDay === "boolean" ? { allDay: body.allDay } : {}),
        ...(typeof body.location === "string" && body.location.trim() ? { location: body.location.trim() } : {}),
        ...(typeof body.notes === "string" && body.notes.trim() ? { notes: body.notes.trim() } : {})
      });
      return reply.status(201).send({
        allDay: event.allDay,
        endsAtIso: event.endsAt.toISOString(),
        id: event.id,
        location: event.location ?? null,
        notes: event.notes ?? null,
        providerId: event.providerId,
        startsAtIso: event.startsAt.toISOString(),
        tags: event.tags ?? [],
        title: event.title,
        url: event.url ?? null
      });
    } catch (error) {
      return reply.status(502).send({ code: "CALENDAR_CREATE_FAILED", message: errorMessage(error, "Calendar create failed") });
    }
  });

  server.delete("/api/calendar/events/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const providerId = (request.query as { providerId?: string } | undefined)?.providerId?.trim();
    if (!providerId) {
      return reply.status(400).send({ code: "PROVIDER_REQUIRED", message: "providerId query parameter is required to delete an event" });
    }
    try {
      await gate.registry.deleteEvent(providerId, id);
      // Lifecycle-link contract: a deleted event's linked reminders go with it
      // on EVERY surface (best-effort — a sync failure never fails the delete).
      await syncRemindersOnEventDelete(resolveRemindersFile(process.env as Record<string, string | undefined>), id);
      return reply.status(204).send();
    } catch (error) {
      return reply.status(502).send({ code: "CALENDAR_DELETE_FAILED", message: errorMessage(error, "Calendar delete failed") });
    }
  });

  if (!gate.credentialStore) {
    return;
  }
  const credentialStore = gate.credentialStore;

  server.get("/api/calendar/credentials", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const ids = await credentialStore.list();
    return { providers: ids };
  });

  server.put("/api/calendar/credentials/:providerId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const { providerId } = request.params as { readonly providerId: string };
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({
        code: "INVALID_CREDENTIAL_PAYLOAD",
        message: "Body must be a JSON object of credential key/value pairs"
      });
    }
    await credentialStore.save(providerId, body as JsonObject);
    return { providerId, saved: true };
  });

  server.delete("/api/calendar/credentials/:providerId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const { providerId } = request.params as { readonly providerId: string };
    await credentialStore.remove(providerId);
    return reply.status(204).send();
  });
}

export type OptionalIsoQueryResult =
  | { readonly kind: "absent" }
  | { readonly kind: "explicit"; readonly date: Date }
  | { readonly kind: "invalid"; readonly raw: string };

/**
 * Three-way classification for an optional ISO-string query param.
 * Distinguishes "absent" (caller didn't supply — fallback) from
 * "present but unparseable" (typo — 400) so the route can match the
 * `/api/history?sinceIso` pattern: silent fallback only when the
 * caller omitted the field, never when they typed something wrong.
 */
export function parseOptionalIsoQueryParam(raw: string | undefined): OptionalIsoQueryResult {
  if (raw === undefined || raw.trim().length === 0) {
    return { kind: "absent" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { kind: "invalid", raw };
  }
  return { date: parsed, kind: "explicit" };
}
