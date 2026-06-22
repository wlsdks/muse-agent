/**
 * `/api/reminders/*` routes — passive personal reminders.
 *
 * Reminders aren't actively fired in this iter (no daemon yet).
 * `muse today` and the CLI surface them when their dueAt has
 * passed; a future iter can flip status to "fired" and route
 * through the messaging registry.
 *
 * Endpoints:
 *   - GET    /api/reminders        list (status filter: pending|fired|all|due)
 *   - POST   /api/reminders        create with text + dueAt (ISO or relative)
 *   - DELETE /api/reminders/:id    remove
 */

import { randomUUID } from "node:crypto";

import { compareRemindersByDueAt, filterReminders, fireReminder, parseReminderDueAt, parseReminderVia, readReminders, readReminderHistory, readReminderStatusFilter, serializeReminder, writeReminders, type PersistedReminder, type ReminderRecurrence } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { parseHistoryLimit } from "./server-input-utils.js";
import type { ServerOptions } from "./server.js";

interface RemindersRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly remindersFile: string;
  /**
   * When set, `GET /api/reminders/history` is registered so the web
   * console can show the daemon's per-firing audit log. Without it,
   * the endpoint isn't exposed (404).
   */
  readonly reminderHistoryFile?: string;
}

export function registerRemindersRoutes(server: FastifyInstance, gate: RemindersRoutesGate): void {
  const { remindersFile } = gate;

  server.get("/api/reminders", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readReminderStatusFilter((request.query as { readonly status?: string } | undefined)?.status);
    const reminders = await readReminders(remindersFile);
    const filtered = filterReminders(reminders, status, () => new Date());
    const sorted = [...filtered].sort(compareRemindersByDueAt);
    return { reminders: sorted.map(serializeReminder), status, total: sorted.length };
  });

  server.post("/api/reminders", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = request.body as {
      readonly text?: unknown;
      readonly dueAt?: unknown;
      readonly via?: unknown;
      readonly recurrence?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return reply.status(400).send({ code: "INVALID_REMINDER", message: "text must be a non-empty string" });
    }
    const dueAtRaw = typeof body?.dueAt === "string" ? body.dueAt.trim() : "";
    if (dueAtRaw.length === 0) {
      return reply.status(400).send({ code: "INVALID_REMINDER", message: "dueAt is required" });
    }
    const parsed = parseReminderDueAt(dueAtRaw, () => new Date());
    if (parsed instanceof Error) {
      return reply.status(400).send({ code: "INVALID_REMINDER_DUE_AT", message: parsed.message });
    }
    if (body?.recurrence !== undefined && body.recurrence !== "daily" && body.recurrence !== "weekly" && body.recurrence !== "monthly" && body.recurrence !== "yearly") {
      return reply.status(400).send({ code: "INVALID_REMINDER_RECURRENCE", message: "recurrence must be 'daily', 'weekly', 'monthly', or 'yearly'" });
    }
    const recurrence = body?.recurrence as ReminderRecurrence | undefined;
    const viaResult = parseReminderVia(body?.via);
    if (viaResult instanceof Error) {
      return reply.status(400).send({ code: "INVALID_REMINDER_VIA", message: viaResult.message });
    }
    const via = viaResult;
    const reminders = await readReminders(remindersFile);
    const created: PersistedReminder = {
      createdAt: new Date().toISOString(),
      dueAt: parsed,
      id: `rem_${randomUUID()}`,
      status: "pending",
      text,
      ...(recurrence ? { recurrence } : {}),
      ...(via ? { via } : {})
    };
    await writeReminders(remindersFile, [...reminders, created]);
    return reply.status(201).send(serializeReminder(created));
  });

  server.post("/api/reminders/:id/snooze", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const body = request.body as { readonly dueAt?: unknown } | null;
    let nextDueAt: string;
    const dueAtRaw = typeof body?.dueAt === "string" ? body.dueAt.trim() : "";
    if (dueAtRaw.length > 0) {
      const parsed = parseReminderDueAt(dueAtRaw, () => new Date());
      if (parsed instanceof Error) {
        return reply.status(400).send({ code: "INVALID_REMINDER_DUE_AT", message: parsed.message });
      }
      nextDueAt = parsed;
    } else {
      nextDueAt = new Date(Date.now() + 10 * 60_000).toISOString();
    }
    const reminders = await readReminders(remindersFile);
    const index = reminders.findIndex((reminder) => reminder.id === id);
    if (index < 0) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
    const snoozed: PersistedReminder = { ...reminders[index]!, dueAt: nextDueAt, status: "pending" };
    const next = [...reminders];
    next[index] = snoozed;
    await writeReminders(remindersFile, next);
    return reply.status(200).send(serializeReminder(snoozed));
  });

  server.post("/api/reminders/:id/fire", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const body = request.body as { readonly firedAt?: unknown } | null;
    let firedAt: string;
    const firedAtRaw = typeof body?.firedAt === "string" ? body.firedAt.trim() : "";
    if (firedAtRaw.length > 0) {
      const parsed = new Date(firedAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        return reply.status(400).send({
          code: "INVALID_REMINDER_FIRED_AT",
          message: `firedAt must be a parseable ISO-8601 timestamp (got ${JSON.stringify(firedAtRaw)})`
        });
      }
      firedAt = parsed.toISOString();
    } else {
      firedAt = new Date().toISOString();
    }
    const reminders = await readReminders(remindersFile);
    const next = fireReminder(reminders, id, firedAt);
    if (!next) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
    await writeReminders(remindersFile, next);
    const fired = next.find((reminder) => reminder.id === id) as PersistedReminder;
    return reply.status(200).send(serializeReminder(fired));
  });

  server.delete("/api/reminders/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const reminders = await readReminders(remindersFile);
    const next = reminders.filter((reminder) => reminder.id !== id);
    if (next.length === reminders.length) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
    await writeReminders(remindersFile, next);
    return reply.status(204).send();
  });

  if (gate.reminderHistoryFile) {
    const historyFile = gate.reminderHistoryFile;
    server.get("/api/reminders/history", async (request, reply) => {
      if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
        return reply;
      }
      const query = (request.query as { readonly limit?: string } | undefined) ?? {};
      const limit = parseHistoryLimit(query.limit, 500);
      const entries = await readReminderHistory(historyFile, limit);
      return { entries, total: entries.length };
    });
  }
}
