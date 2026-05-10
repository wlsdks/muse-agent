import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import {
  filterReminders,
  parseReminderDueAt,
  readReminders,
  readReminderStatusFilter,
  serializeReminder,
  writeReminders,
  type PersistedReminder
} from "./personal-reminders-store.js";

/**
 * `muse.reminders` loopback MCP server — passive personal
 * reminders. The agent can:
 *
 *   - `muse.reminders.add` (write) — schedule a one-shot reminder
 *     ("내일 6시에 우유 사라고 알려줘"), backed by the same
 *     `~/.muse/reminders.json` the CLI / REST surface uses.
 *   - `muse.reminders.due` (read) — list reminders the user should
 *     see right now (status=pending && dueAt ≤ now), so the LLM can
 *     proactively surface them when answering anything time-shaped.
 *   - `muse.reminders.clear` (write) — drop a reminder by id.
 *
 * Active firing through messaging is a follow-up iter — this server
 * is read/write storage only. The reminder appears in `muse today`
 * automatically once dueAt has passed.
 */
export interface RemindersMcpServerOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly maxListEntries?: number;
}

export function createRemindersMcpServer(options: RemindersMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const idFactory = options.idFactory ?? (() => `rem_${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));

  return {
    description:
      "Personal reminders (passive — surfaced in `muse today`). Single JSON file, loopback MCP.",
    name: "muse.reminders",
    tools: [
      {
        description:
          "Add a one-shot reminder. `text` is the reminder body. `dueAt` accepts either an ISO-8601 timestamp " +
          "OR a relative phrase: 'tomorrow', 'tomorrow at 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', " +
          "'next Monday', 'next Monday at 9am'. The server resolves the phrase against the current local time, " +
          "so pass the user's natural-language input directly. Reminders surface in `muse today` once dueAt " +
          "has passed.",
        execute: async (args): Promise<JsonObject> => {
          const text = readString(args, "text")?.trim();
          if (!text) {
            return { error: "text is required" };
          }
          const dueAtRaw = readString(args, "dueAt")?.trim();
          if (!dueAtRaw) {
            return { error: "dueAt is required" };
          }
          const parsed = parseReminderDueAt(dueAtRaw, now);
          if (parsed instanceof Error) {
            return { error: parsed.message };
          }
          const reminders = await readReminders(file);
          const created: PersistedReminder = {
            createdAt: now().toISOString(),
            dueAt: parsed,
            id: idFactory(),
            status: "pending",
            text
          };
          try {
            await writeReminders(file, [...reminders, created]);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { reminder: serializeReminder(created) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: {
              description: "ISO-8601 timestamp or relative phrase ('tomorrow at 6pm', 'in 3 hours', 'next Monday').",
              type: "string"
            },
            text: { description: "Reminder body shown back to the user when due.", type: "string" }
          },
          required: ["text", "dueAt"],
          type: "object"
        },
        name: "add",
        risk: "write"
      },
      {
        description:
          "List reminders. `status` filter: 'pending' (default), 'fired', 'all', or 'due' " +
          "(overdue or now-or-earlier pending). Newest first up to `" +
          maxListEntries.toString() +
          "` entries. Use 'due' to fetch the set the user should be reminded about right now.",
        execute: async (args): Promise<JsonObject> => {
          const status = readReminderStatusFilter(readString(args, "status"));
          const reminders = await readReminders(file);
          const filtered = filterReminders(reminders, status, now);
          const sorted = [...filtered]
            .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
            .slice(0, maxListEntries);
          return {
            reminders: sorted.map(serializeReminder) as JsonValue,
            status,
            total: sorted.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            status: { enum: ["pending", "fired", "all", "due"], type: "string" }
          },
          type: "object"
        },
        name: "due",
        risk: "read"
      },
      {
        description: "Remove a reminder by id. Returns `{ removed: true, id }` on success or an error if no match.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          const reminders = await readReminders(file);
          const next = reminders.filter((reminder) => reminder.id !== id);
          if (next.length === reminders.length) {
            return { error: `reminder not found: ${id}` };
          }
          try {
            await writeReminders(file, next);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { id, removed: true };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        name: "clear",
        risk: "write"
      }
    ]
  };
}
