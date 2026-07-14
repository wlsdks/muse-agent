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

import { compareRemindersByDueAt, filterReminders, fireReminder, parseReminderDueAt, parseReminderVia, readReminders, readReminderHistory, readReminderStatusFilter, serializeReminder, writeReminders, type PersistedReminder, type ReminderRecurrence } from "@muse/stores";
import { mirrorReminderToApple } from "@muse/macos";
import type { FastifyInstance } from "fastify";

import { readBodyString, readQueryString, readRouteParam, toBody } from "./compat-parsers.js";
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

const RECURRENCE_VALUES = ["daily", "weekly", "monthly", "yearly"] as const;

function parseReminderRecurrence(value: unknown): ReminderRecurrence | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const candidate = value.trim().toLowerCase();
  switch (candidate) {
    case RECURRENCE_VALUES[0]:
      return "daily";
    case RECURRENCE_VALUES[1]:
      return "weekly";
    case RECURRENCE_VALUES[2]:
      return "monthly";
    case RECURRENCE_VALUES[3]:
      return "yearly";
    default:
      return undefined;
  }
}

export function registerRemindersRoutes(server: FastifyInstance, gate: RemindersRoutesGate): void {
  const { remindersFile } = gate;

  server.get("/api/reminders", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readReminderStatusFilter(readQueryString(request, "status"));
    const reminders = await readReminders(remindersFile);
    const filtered = filterReminders(reminders, status, () => new Date());
    const sorted = [...filtered].sort(compareRemindersByDueAt);
    return { reminders: sorted.map(serializeReminder), status, total: sorted.length };
  });

  server.post("/api/reminders", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);
    const text = readBodyString(body, "text") ?? "";
    if (text.length === 0) {
      return reply.status(400).send({ code: "INVALID_REMINDER", message: "text must be a non-empty string" });
    }
    const dueAtRaw = readBodyString(body, "dueAt") ?? "";
    if (dueAtRaw.length === 0) {
      return reply.status(400).send({ code: "INVALID_REMINDER", message: "dueAt is required" });
    }
    const parsed = parseReminderDueAt(dueAtRaw, () => new Date());
    if (parsed instanceof Error) {
      return reply.status(400).send({ code: "INVALID_REMINDER_DUE_AT", message: parsed.message });
    }
    const recurrence = parseReminderRecurrence(body.recurrence);
    if (body.recurrence !== undefined && recurrence === undefined) {
      return reply.status(400).send({ code: "INVALID_REMINDER_RECURRENCE", message: "recurrence must be 'daily', 'weekly', 'monthly', or 'yearly'" });
    }
    const viaResult = parseReminderVia(body.via);
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
    // Opt-in Apple Reminders mirror (MUSE_APPLE_REMINDERS_MIRROR). Self-gated +
    // fail-soft: it never fails the create — a miss returns `mirrorWarning` so
    // the caller (CLI / web) can surface it.
    const mirror = await mirrorReminderToApple({ text: created.text, dueAt: created.dueAt });
    return reply.status(201).send({
      ...serializeReminder(created),
      ...(mirror.warning ? { mirrorWarning: mirror.warning } : {})
    });
  });

  server.post<{ Params: { readonly id: string } }>(
    "/api/reminders/:id/snooze",
    async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (id === undefined) {
      return reply.status(400).send({ code: "INVALID_REMINDER_ID", message: "id is required" });
    }
    const body = toBody(request.body);
    let nextDueAt: string;
    const dueAtRaw = readBodyString(body, "dueAt") ?? "";
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

  server.post<{ Params: { readonly id: string } }>(
    "/api/reminders/:id/fire",
    async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (id === undefined) {
      return reply.status(400).send({ code: "INVALID_REMINDER_ID", message: "id is required" });
    }
    const body = toBody(request.body);
    let firedAt: string;
    const firedAtRaw = readBodyString(body, "firedAt") ?? "";
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
    const fired = next.find((reminder) => reminder.id === id);
    if (!fired) {
      return reply.status(404).send({ code: "REMINDER_NOT_FOUND", message: `reminder not found: ${id}` });
    }
    return reply.status(200).send(serializeReminder(fired));
  });

  server.delete<{ Params: { readonly id: string } }>(
    "/api/reminders/:id",
    async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (id === undefined) {
      return reply.status(400).send({ code: "INVALID_REMINDER_ID", message: "id is required" });
    }
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
      const limit = parseHistoryLimit(readQueryString(request, "limit"), 500);
      const entries = await readReminderHistory(historyFile, limit);
      return { entries, total: entries.length };
    });
  }
}
