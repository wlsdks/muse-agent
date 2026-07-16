import { isErrorLike } from "@muse/shared";
/**
 * `/api/reminders/*` routes — passive personal reminders.
 *
 * `muse today` and the CLI surface them when their dueAt has
 * passed; the daemon flips status to "fired" and routes through
 * the messaging registry.
 *
 * Endpoints:
 *   - GET    /api/reminders        list (status filter: pending|fired|all|due)
 *   - POST   /api/reminders        create with text + dueAt (ISO or relative)
 *   - DELETE /api/reminders/:id    remove
 */

import { randomUUID } from "node:crypto";

import { compareRemindersByDueAt, filterReminders, fireReminder, mutateReminders, parseReminderDueAt, parseReminderVia, readReminders, readReminderHistory, readReminderStatusFilter, serializeReminder, snoozeReminder, type PersistedReminder, type ReminderRecurrence } from "@muse/stores";
import { mirrorReminderToApple } from "@muse/macos";
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
    if (isErrorLike(parsed)) {
      return reply.status(400).send({ code: "INVALID_REMINDER_DUE_AT", message: parsed.message });
    }
    if (body?.recurrence !== undefined && body.recurrence !== "daily" && body.recurrence !== "weekly" && body.recurrence !== "monthly" && body.recurrence !== "yearly") {
      return reply.status(400).send({ code: "INVALID_REMINDER_RECURRENCE", message: "recurrence must be 'daily', 'weekly', 'monthly', or 'yearly'" });
    }
    const recurrence = body?.recurrence as ReminderRecurrence | undefined;
    const viaResult = parseReminderVia(body?.via);
    if (isErrorLike(viaResult)) {
      return reply.status(400).send({ code: "INVALID_REMINDER_VIA", message: viaResult.message });
    }
    const via = viaResult;
    const created: PersistedReminder = {
      createdAt: new Date().toISOString(),
      dueAt: parsed,
      id: `rem_${randomUUID()}`,
      status: "pending",
      text,
      ...(recurrence ? { recurrence } : {}),
      ...(via ? { via } : {})
    };
    await mutateReminders(remindersFile, (current) => [...current, created]);
    // Opt-in Apple Reminders mirror (MUSE_APPLE_REMINDERS_MIRROR). Self-gated +
    // fail-soft: it never fails the create — a miss returns `mirrorWarning` so
    // the caller (CLI / web) can surface it.
    const mirror = await mirrorReminderToApple({ text: created.text, dueAt: created.dueAt });
    return reply.status(201).send({
      ...serializeReminder(created),
      ...(mirror.warning ? { mirrorWarning: mirror.warning } : {})
    });
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
      if (isErrorLike(parsed)) {
        return reply.status(400).send({ code: "INVALID_REMINDER_DUE_AT", message: parsed.message });
      }
      nextDueAt = parsed;
    } else {
      nextDueAt = new Date(Date.now() + 10 * 60_000).toISOString();
    }
    let snoozed: PersistedReminder | undefined;
    await mutateReminders(remindersFile, (current) => {
      const next = snoozeReminder(current, id, nextDueAt);
      if (!next) return current;
      snoozed = next.find((reminder) => reminder.id === id);
      return next;
    });
    if (!snoozed) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
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
    let fired: PersistedReminder | undefined;
    await mutateReminders(remindersFile, (current) => {
      const next = fireReminder(current, id, firedAt);
      if (!next) return current;
      fired = next.find((reminder) => reminder.id === id);
      return next;
    });
    if (!fired) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
    return reply.status(200).send(serializeReminder(fired));
  });

  server.delete("/api/reminders/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    let removed = false;
    await mutateReminders(remindersFile, (current) => {
      const next = current.filter((reminder) => reminder.id !== id);
      removed = next.length !== current.length;
      return next;
    });
    if (!removed) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
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
