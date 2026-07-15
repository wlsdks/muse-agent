/**
 * Read-only HTTP surface for Muse's accountability / autonomy stores —
 * the file-based logs the CLI exposes (`muse actions|objectives|
 * contacts`) but the web could not reach:
 *
 *   - GET /api/objectives           — standing objectives (?status filter)
 *   - GET /api/actions              — autonomous-action log (?userId, ?limit)
 *   - GET /api/contacts             — resolved contacts
 *   - GET /api/vetoes               — learned avoidances (?userId)
 *
 * Read-only by design: undo / cancel / clear stay on the CLI + agent
 * paths so this surface introduces no new state-changing action (see
 * outbound-safety.md). The stores are the same `@muse/mcp` modules the
 * CLI reads, so the web and CLI never diverge.
 */

import { randomUUID } from "node:crypto";

import { addContact, queryActionLog, queryContacts, queryVetoes, readObjectives, removeContact, serializeActionLogEntry, serializeContact, serializeObjective, serializeVeto, type Contact } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface AccountabilityRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly actionLogFile: string;
  readonly objectivesFile: string;
  readonly contactsFile: string;
  readonly vetoesFile: string;
}

function readString(request: { query?: unknown }, key: string): string {
  const query = (request.query as Record<string, unknown> | undefined) ?? {};
  const value = query[key];
  return typeof value === "string" ? value.trim() : "";
}

function readLimit(request: { query?: unknown }, fallback: number): number {
  const raw = readString(request, "limit");
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

export function registerAccountabilityRoutes(server: FastifyInstance, gate: AccountabilityRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/objectives", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const status = readString(request, "status");
    const all = await readObjectives(gate.objectivesFile);
    const filtered = status ? all.filter((o) => o.status === status) : all;
    return { objectives: filtered.map(serializeObjective), total: filtered.length };
  });

  server.get("/api/actions", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const userId = readString(request, "userId");
    const limit = readLimit(request, 100);
    const all = await queryActionLog(gate.actionLogFile, userId ? { userId } : {});
    // Most recent first — the log is append-order on disk.
    const ordered = [...all].sort((a, b) => b.when.localeCompare(a.when)).slice(0, limit);
    return { actions: ordered.map(serializeActionLogEntry), total: all.length };
  });

  server.get("/api/contacts", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const all = await queryContacts(gate.contactsFile);
    return { contacts: all.map(serializeContact), total: all.length };
  });

  // Contacts are local data (not an outbound-to-human action), so
  // user-initiated add/remove is safe here. Objectives/vetoes/actions
  // stay read-only — their mutations are autonomy governance.
  server.post("/api/contacts", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const body = (request.body as Partial<Contact> | undefined) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0) {
      return reply.status(400).send({ error: "name is required" });
    }
    const contact: Contact = {
      id: randomUUID(),
      name,
      ...(typeof body.email === "string" && body.email.trim() ? { email: body.email.trim() } : {}),
      ...(typeof body.handle === "string" && body.handle.trim() ? { handle: body.handle.trim() } : {}),
      ...(typeof body.phone === "string" && body.phone.trim() ? { phone: body.phone.trim() } : {})
    };
    await addContact(gate.contactsFile, contact);
    return serializeContact(contact);
  });

  server.delete("/api/contacts/:id", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const { id } = request.params as { id: string };
    const removed = await removeContact(gate.contactsFile, id);
    return { id, removed };
  });

  server.get("/api/vetoes", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const userId = readString(request, "userId");
    const all = await queryVetoes(gate.vetoesFile, userId ? { userId } : {});
    const ordered = [...all].sort((a, b) => b.vetoedAt.localeCompare(a.vetoedAt));
    return { total: ordered.length, vetoes: ordered.map(serializeVeto) };
  });
}
