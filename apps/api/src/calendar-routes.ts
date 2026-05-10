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
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface CalendarRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly registry: CalendarProviderRegistry;
  readonly credentialStore?: CalendarCredentialStore;
}

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
    const from = parseIsoOrDefault(query?.fromIso, new Date());
    const to = parseIsoOrDefault(query?.toIso, new Date(from.getTime() + 30 * 86_400_000));
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
      return reply.status(502).send({ code: "CALENDAR_LIST_FAILED", message: error instanceof Error ? error.message : String(error) });
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
    const ids = await credentialStore.list();
    return { providers: ids };
  });

  server.put("/api/calendar/credentials/:providerId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
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
    const { providerId } = request.params as { readonly providerId: string };
    await credentialStore.remove(providerId);
    return reply.status(204).send();
  });
}

function parseIsoOrDefault(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
