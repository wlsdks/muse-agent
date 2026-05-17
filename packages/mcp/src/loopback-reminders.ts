import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "./loopback.js";
import { readReminderHistory } from "./personal-reminder-history-store.js";
import {
  compareRemindersByDueAt,
  filterReminders,
  fireReminder,
  parseReminderDueAt,
  parseReminderVia,
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

 *   - `muse.reminders.search` (read) — substring grep across the
 *     reminder text. Defaults to status="all" so vague callbacks
 *     ("그 우유 뭐였지?") still find fired/old entries.
 *   - `muse.reminders.snooze` (write) — bump a reminder's dueAt
 *     forward (default 10 min) and reset status to pending.
 *   - `muse.reminders.fire` (write) — flip status pending → fired
 *     after the LLM has delivered the message itself (Phase A of
 *     `docs/design/reminder-firing.md`).
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
  /**
   * When set, the `history` tool is registered so the agent can audit
   * recent delivery attempts. Backed by the same file the firing
   * daemon writes via `appendReminderHistory`. When omitted, the
   * tool simply doesn't appear — same pattern as the messaging
   * MCP server's optional `pollNow` / `pollAll`.
   */
  readonly historyFile?: string;
}

export function createRemindersMcpServer(options: RemindersMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const idFactory = options.idFactory ?? (() => `rem_${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));
  const historyFile = options.historyFile;

  const historyTool: LoopbackMcpToolDefinition[] = historyFile ? [{
    description:
      "Audit recent reminder delivery attempts. Returns the daemon's per-firing log " +
      "(newest first) with `reminderId`, `text`, `providerId`, `destination`, `firedAtIso`, " +
      "`status` ('delivered' | 'failed'), and `error` on failure. Default limit 100, cap 500. " +
      "Use this to answer 'did the 9am reminder land?' / 'why didn't my Slack reminder fire?'.",
    execute: async (args): Promise<JsonObject> => {
      const limitRaw = args["limit"];
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(500, Math.trunc(limitRaw)))
        : undefined;
      try {
        const entries = await readReminderHistory(historyFile, limit);
        return {
          entries: entries as unknown as JsonValue,
          total: entries.length
        };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: {
          description: "Max entries to return (newest first). Default 100, cap 500.",
          type: "number"
        }
      },
      type: "object"
    },
    domain: "tasks",
    name: "history",
    risk: "read"
  }] : [];

  return {
    description:
      "Personal reminders (passive — surfaced in `muse today`). Single JSON file, loopback MCP.",
    name: "muse.reminders",
    tools: [
      ...historyTool,
      {
        description:
          "Add a one-shot reminder. `text` is the reminder body. `dueAt` accepts either an ISO-8601 timestamp " +
          "OR a relative phrase. English: 'tomorrow', 'tomorrow 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', " +
          "'next Monday', 'next Monday at 9am'. Korean: '내일', '내일 오후 6시', '30분 후', '3일 뒤', " +
          "'다음 주 월요일', '다음 주 월요일 오후 3시 반'. The server resolves the phrase against the current local time, " +
          "so pass the user's natural-language input directly (in their own language). Reminders surface in `muse today` once dueAt " +
          "has passed. " +
          "Optional `via: { providerId, destination }` overrides the firing daemon's default route per reminder " +
          "(\"send THIS one to Slack channel C123 instead of the user's usual Telegram\").",
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
          const viaResult = parseReminderVia(args["via"]);
          if (viaResult instanceof Error) {
            return { error: viaResult.message };
          }
          const via = viaResult;
          const reminders = await readReminders(file);
          const created: PersistedReminder = {
            createdAt: now().toISOString(),
            dueAt: parsed,
            id: idFactory(),
            status: "pending",
            text,
            ...(via ? { via } : {})
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
              description: "ISO-8601 timestamp or relative phrase — English ('tomorrow 6pm', 'in 3 hours', 'next Monday') or Korean ('내일 오후 6시', '3일 뒤', '다음 주 월요일').",
              type: "string"
            },
            text: { description: "Reminder body shown back to the user when due.", type: "string" },
            via: {
              additionalProperties: false,
              description:
                "Optional per-reminder routing override. Both fields required when set. " +
                "When omitted, the firing daemon's default provider/destination is used.",
              properties: {
                destination: { description: "Platform-native chat / channel / user id.", type: "string" },
                providerId: { description: "telegram | discord | slack | line", type: "string" }
              },
              required: ["providerId", "destination"],
              type: "object"
            }
          },
          required: ["text", "dueAt"],
          type: "object"
        },
        domain: "tasks",
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
            .sort(compareRemindersByDueAt)
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
        domain: "tasks",
        name: "due",
        risk: "read"
      },
      {
        description:
          "Substring search across reminder text (case-insensitive). `query` is required; `status` " +
          "defaults to 'all' (set 'pending' to skip already-fired ones). Returns up to `" +
          maxListEntries.toString() +
          "` matches sorted by dueAt. Use this when the user says 'remind me about that milk thing' " +
          "instead of giving a literal id.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim();
          if (!query) {
            return { error: "query is required" };
          }
          // Default search to "all" so the LLM can find fired/cleared
          // entries when the user vaguely refers back to them. Callers
          // who want a tighter scope pass `status: "pending"` etc.
          const statusRaw = readString(args, "status");
          const status = statusRaw ? readReminderStatusFilter(statusRaw) : "all";
          const needle = query.toLowerCase();
          const all = await readReminders(file);
          const scoped = filterReminders(all, status, now);
          const matches = scoped
            .filter((reminder) => reminder.text.toLowerCase().includes(needle))
            .sort(compareRemindersByDueAt)
            .slice(0, maxListEntries);
          return {
            query,
            reminders: matches.map(serializeReminder) as JsonValue,
            status,
            total: matches.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            query: { description: "Substring to grep for (case-insensitive).", type: "string" },
            status: { enum: ["pending", "fired", "all", "due"], type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "tasks",
        name: "search",
        risk: "read"
      },
      {
        description:
          "Bump a reminder's dueAt forward. `id` selects the reminder, `dueAt` accepts the same " +
          "ISO-8601-or-relative grammar as `add` ('in 30 minutes', 'tomorrow at 9am', etc.). " +
          "If `dueAt` is omitted, defaults to a 10-minute snooze from now. " +
          "Status is reset to 'pending' so a fired reminder can be revived. Returns the updated reminder.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          const dueAtRaw = readString(args, "dueAt")?.trim();
          let nextDueAt: string;
          if (dueAtRaw && dueAtRaw.length > 0) {
            const parsed = parseReminderDueAt(dueAtRaw, now);
            if (parsed instanceof Error) {
              return { error: parsed.message };
            }
            nextDueAt = parsed;
          } else {
            // Default snooze: 10 minutes from now. The LLM can still
            // override with an explicit phrase when the user is more
            // specific ("snooze 30 mins", "until tomorrow morning").
            nextDueAt = new Date(now().getTime() + 10 * 60_000).toISOString();
          }
          const reminders = await readReminders(file);
          const index = reminders.findIndex((reminder) => reminder.id === id);
          if (index < 0) {
            return { error: `reminder not found: ${id}` };
          }
          const snoozed: PersistedReminder = {
            ...reminders[index]!,
            dueAt: nextDueAt,
            status: "pending"
          };
          const next = [...reminders];
          next[index] = snoozed;
          try {
            await writeReminders(file, next);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { reminder: serializeReminder(snoozed) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: {
              description: "New due time. Same grammar as `add` (ISO or relative phrase). Omit for a 10-minute snooze.",
              type: "string"
            },
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        name: "snooze",
        risk: "write"
      },
      {
        description:
          "Mark a reminder as fired (delivered). Use this after you've sent the reminder text " +
          "through `muse.messaging.send` so it stops surfacing in `due`/`today`. `firedAt` defaults " +
          "to the current time; pass an explicit ISO-8601 if recording a delayed log entry. " +
          "Status flips pending → fired; `snooze` is the inverse if the user wants it back.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          const firedAtRaw = readString(args, "firedAt")?.trim();
          let firedAt: string;
          if (firedAtRaw && firedAtRaw.length > 0) {
            const parsed = new Date(firedAtRaw);
            if (Number.isNaN(parsed.getTime())) {
              return { error: `firedAt must be a parseable ISO-8601 timestamp (got ${JSON.stringify(firedAtRaw)})` };
            }
            firedAt = parsed.toISOString();
          } else {
            firedAt = now().toISOString();
          }
          const reminders = await readReminders(file);
          const next = fireReminder(reminders, id, firedAt);
          if (!next) {
            return { error: `reminder not found: ${id}` };
          }
          try {
            await writeReminders(file, next);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          const fired = next.find((reminder) => reminder.id === id) as PersistedReminder;
          return { reminder: serializeReminder(fired) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            firedAt: {
              description: "Optional ISO-8601 timestamp; defaults to now.",
              type: "string"
            },
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        name: "fire",
        risk: "write"
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
        domain: "tasks",
        name: "clear",
        risk: "write"
      }
    ]
  };
}
