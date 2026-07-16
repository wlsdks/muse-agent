import { randomUUID } from "node:crypto";

import { assertNoSecretInPersistedFields, type JsonObject, type JsonValue, isErrorLike } from "@muse/shared";

import { errorMessage, readString } from "@muse/mcp";
import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "@muse/mcp";
import { readReminderHistory } from "@muse/stores";
import {
  filterReminders,
  fireReminder,
  parseReminderDueAt,
  mutateReminders,
  readReminders,
  readReminderStatusFilter,
  serializeReminderForModel,
  snoozeReminder,
  type PersistedReminder
} from "@muse/stores";
import { reconcileSnoozeDueAt, resolveRecurrenceForAdd, resolveSnoozeAnchor } from "./reminder-recurrence.js";
import {
  parseFiredAt,
  recordDueAtParseWeakness,
  resolveReminderRefOrError,
  serializeSortedReminders
} from "./reminders-server-helpers.js";

export { reconcileSnoozeDueAt, resolveRecurrenceForAdd, resolveSnoozeAnchor } from "./reminder-recurrence.js";
export {
  parseFiredAt,
  recordDueAtParseWeakness,
  resolveReminderRefOrError,
  serializeSortedReminders,
  type ReminderRefLookup
} from "./reminders-server-helpers.js";

/**
 * `muse.reminders` loopback MCP server — passive personal
 * reminders. The agent can:
 *
 *   - `muse.reminders.add` (write) — schedule a one-shot reminder
 *     ("내일 6시에 우유 사라고 알려줘"), backed by the same
 *     `~/.muse/reminders.json` the CLI / REST surface uses.
 *   - `muse.reminders.list` (read) — show / list the user's reminders
 *     (status filter, due-soonest first); status:'due' fetches the set
 *     the user should see right now (pending && dueAt ≤ now), so the LLM
 *     can proactively surface them when answering anything time-shaped.

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
/**
 * One-way create-only mirror of a newly-added reminder into an external
 * surface (Apple Reminders.app). Injected by the wiring layer so
 * @muse/domain-tools stays free of any macOS dependency. Fail-soft: a
 * rejected/failed mirror NEVER fails the Muse write — the returned `warning`
 * is surfaced in the tool result instead.
 */
export type ReminderMirror = (
  reminder: { readonly text: string; readonly dueAt: string }
) => Promise<{ readonly mirrored: boolean; readonly warning?: string }>;

export interface RemindersMcpServerOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly maxListEntries?: number;
  /**
   * When set, a successful `add` also mirrors the reminder into Apple
   * Reminders (injected — see {@link ReminderMirror}). Omitted ⇒ no mirror,
   * behaviour unchanged.
   */
  readonly mirror?: ReminderMirror;
  /**
   * When set, the `history` tool is registered so the agent can audit
   * recent delivery attempts. Backed by the same file the firing
   * daemon writes via `appendReminderHistory`. When omitted, the
   * tool simply doesn't appear — same pattern as the messaging
   * MCP server's optional `pollNow` / `pollAll`.
   */
  readonly historyFile?: string;
  /**
   * When set, a `dueAt` phrase the deterministic parser CAN'T resolve records a
   * `time-parse` weakness here — the agent-path sibling of the CLI `calendar add/edit`
   * producer. Omitted ⇒ no whetstone signal (back-compat).
   */
  readonly weaknessesFile?: string;
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
    keywords: ["reminder", "알림", "리마인더", "history", "기록", "지난"],
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
          "Add a reminder (one-shot, or recurring with `recurrence`). `text` is the reminder body. `dueAt` accepts either an ISO-8601 timestamp " +
          "OR a relative phrase. English: 'tomorrow', 'tomorrow 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', " +
          "'next Monday', 'next Monday at 9am'. Korean: '내일', '내일 오후 6시', '30분 후', '3일 뒤', " +
          "'다음 주 월요일', '다음 주 월요일 오후 3시 반'. The server resolves the phrase against the current local time, " +
          "so pass the user's natural-language input directly (in their own language). Reminders surface in `muse today` once dueAt " +
          "has passed. " +
          "Optional `recurrence`: 'daily', 'weekly', 'monthly', or 'yearly' makes it repeat (re-arms to the next occurrence each time it fires) — use for 'every day' / 'every Monday' / 'on the 1st of every month' (rent, bills, subscriptions) / 'every year' (anniversaries, annual renewals); omit for a one-time reminder. A monthly 31st (or a yearly Feb 29) lands on the last valid day of shorter months/years. " +
          "Reminders fire on the user's configured channel. " +
          "When you confirm the reminder back to the user, state the time using the result's `dueAtLocal` field (the due time in the user's local timezone, e.g. 'Thu, Jun 5, 2026, 3:00 PM (tomorrow)') — NEVER the raw ISO `dueAt`, which is in UTC and will read back the wrong hour. " +
          "USE WHEN the user asks to be REMINDED / alerted at a time ('내일 9시 회의 리마인더 추가해줘', 'remind me to call mom at 6pm', '알림 맞춰줘'); " +
          "you MUST call this to actually create it — never just reply that it was set. NOT for a plain to-do with no alert time (use the tasks `add` tool).",
        keywords: ["reminder", "리마인더", "리마인드", "알림", "remind", "remind me", "notify", "알려줘", "맞춰줘", "추가", "add", "등록"],
        execute: async (args): Promise<JsonObject> => {
          const text = readString(args, "text")?.trim();
          if (!text) {
            return { error: "text is required" };
          }
          const guard = assertNoSecretInPersistedFields({ text });
          if (!guard.safe) {
            return { blocked: true, error: guard.notice, kinds: guard.kinds as JsonValue };
          }
          const dueAtRaw = readString(args, "dueAt")?.trim();
          if (!dueAtRaw) {
            return { error: "dueAt is required" };
          }
          const parsed = parseReminderDueAt(dueAtRaw, now);
          if (isErrorLike(parsed)) {
            // Whetstone (agent-path sibling of `calendar add`): the
            // deterministic parser couldn't resolve this dueAt phrase — record the
            // time-parse weakness so a recurring misread surfaces. Fail-soft.
            await recordDueAtParseWeakness(dueAtRaw, options.weaknessesFile);
            return { error: parsed.message };
          }
          const { recurrence, note: recurrenceNote } = resolveRecurrenceForAdd(dueAtRaw, readString(args, "recurrence"));
          // `via` is deliberately NOT model-settable: the chat model can't ground
          // a delivery destination and was observed FABRICATING one (a made-up
          // telegram chat id), which would mis-route the reminder. Reminders fire
          // on the user's configured default route; per-reminder overrides stay a
          // programmatic-only path (parseReminderVia + the store field).
          const created: PersistedReminder = {
            createdAt: now().toISOString(),
            dueAt: parsed,
            id: idFactory(),
            status: "pending",
            text,
            ...(recurrence ? { recurrence } : {})
          };
          try {
            await mutateReminders(file, (current) => [...current, created]);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          // Best-effort Apple-Reminders mirror. Fail-soft: it must NEVER turn a
          // successful Muse write into a tool error — a failure surfaces as a
          // visible `mirrorNote` in the result, nothing more.
          let mirrorNote: string | undefined;
          if (options.mirror) {
            try {
              const outcome = await options.mirror({ text: created.text, dueAt: created.dueAt });
              if (outcome.warning) {
                mirrorNote = outcome.warning;
              }
            } catch (error) {
              mirrorNote = `Apple Reminders mirror failed: ${errorMessage(error)}`;
            }
          }
          return {
            reminder: serializeReminderForModel(created, now) as JsonValue,
            ...(recurrenceNote ? { note: recurrenceNote } : {}),
            ...(mirrorNote ? { mirrorNote } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: {
              description: "ISO-8601 timestamp or relative phrase — English ('tomorrow 6pm', 'in 3 hours', 'next Monday') or Korean ('내일 오후 6시', '3일 뒤', '다음 주 월요일').",
              type: "string"
            },
            recurrence: {
              description: "Optional repeat cadence: 'daily', 'weekly', 'monthly', or 'yearly'. Omit for a one-time reminder. e.g. 'every Monday' → 'weekly', 'pay rent monthly' → 'monthly', 'our anniversary every year' → 'yearly'.",
              enum: ["daily", "weekly", "monthly", "yearly"],
              type: "string"
            },
            text: { description: "Reminder body shown back to the user when due.", type: "string" }
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
          "Show / list the user's reminders, due-soonest first. `status` filter: 'pending' (default, " +
          "not-yet-fired), 'fired', 'all', or 'due' (overdue or now-or-earlier pending). Returns up to `" +
          maxListEntries.toString() +
          "` entries with the TRUE total. Use when the user asks to SEE their reminders ('내 리마인더 보여줘', " +
          "'리마인더 목록', 'what reminders do I have'); pass status:'due' for 'what should I be reminded about now'. " +
          "NOT for calendar events (use the calendar tool) or todo tasks (use the tasks tool).",
        keywords: ["reminder", "reminders", "리마인더", "리마인드", "알림", "목록", "보여줘", "list", "show", "remind"],
        execute: async (args): Promise<JsonObject> => {
          const status = readReminderStatusFilter(readString(args, "status"));
          const reminders = await readReminders(file);
          const filtered = filterReminders(reminders, status, now);
          const result = serializeSortedReminders(filtered, maxListEntries, now);
          return { reminders: result.reminders, shown: result.shown, status, total: result.total };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            status: { description: "Filter: 'pending' (not yet fired), 'fired', 'due' (now), or 'all'.", enum: ["pending", "fired", "all", "due"], type: "string" }
          },
          type: "object"
        },
        domain: "tasks",
        name: "list",
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
          const matches = scoped.filter((reminder) => reminder.text.toLowerCase().includes(needle));
          const result = serializeSortedReminders(matches, maxListEntries, now);
          return { query, reminders: result.reminders, shown: result.shown, status, total: result.total };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            query: { description: "Substring to grep for (case-insensitive).", type: "string" },
            status: { description: "Filter: 'pending' (not yet fired), 'fired', 'due' (now), or 'all'.", enum: ["pending", "fired", "all", "due"], type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "tasks",
        name: "search",
        keywords: ["reminder", "알림", "리마인더", "search", "찾아", "검색"],
        risk: "read"
      },
      {
        description:
          "Reschedule a reminder (push it back / move it). `id` selects the reminder — pass its id " +
          "OR a distinct word from its text ('dentist'); `dueAt` accepts the same ISO-8601-or-relative " +
          "grammar as `add` ('in 30 minutes', 'tomorrow at 9am', '5pm tomorrow'). " +
          "If `dueAt` is omitted, defaults to a 10-minute snooze from now. " +
          "Status is reset to 'pending' so a fired reminder can be revived. Returns the updated reminder.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const reminders = await readReminders(file);
          const lookup = resolveReminderRefOrError(reminders, ref);
          if (!lookup.ok) {
            return lookup.response;
          }
          const index = reminders.findIndex((reminder) => reminder.id === lookup.reminder.id);
          const dueAtRaw = readString(args, "dueAt")?.trim();
          let nextDueAt: string;
          if (dueAtRaw && dueAtRaw.length > 0) {
            const existingDue = new Date(reminders[index]!.dueAt);
            const haveExisting = !Number.isNaN(existingDue.getTime());
            const anchor = resolveSnoozeAnchor(dueAtRaw, existingDue, haveExisting, now);
            const parsed = parseReminderDueAt(dueAtRaw, anchor);
            if (isErrorLike(parsed)) {
              // Whetstone (in-file sibling of `add`): a snooze/reschedule dueAt the
              // deterministic parser can't resolve is the same time-parse signal. Fail-soft.
              await recordDueAtParseWeakness(dueAtRaw, options.weaknessesFile);
              return { error: parsed.message };
            }
            nextDueAt = reconcileSnoozeDueAt(dueAtRaw, parsed, existingDue, haveExisting);
          } else {
            // Default snooze: 10 minutes from now. The LLM can still
            // override with an explicit phrase when the user is more
            // specific ("snooze 30 mins", "until tomorrow morning").
            nextDueAt = new Date(now().getTime() + 10 * 60_000).toISOString();
          }
          let snoozed: PersistedReminder | undefined;
          try {
            await mutateReminders(file, (current) => {
              const next = snoozeReminder(current, lookup.reminder.id, nextDueAt);
              if (!next) return current;
              snoozed = next.find((reminder) => reminder.id === lookup.reminder.id);
              return next;
            });
          } catch (error) {
            return { error: errorMessage(error) };
          }
          if (!snoozed) {
            return { error: `reminder not found: ${lookup.reminder.id}` };
          }
          return { reminder: serializeReminderForModel(snoozed, now) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: {
              description: "New due moment in the user's own words — a TIME alone ('오후 6시' keeps the date), a DATE alone ('다음 주 월요일' keeps the current time), or BOTH ('월요일 오전 9시'). Also accepts an offset ('in 30 minutes') or ISO. Pass the user's exact phrase; do NOT ask for a time they didn't give. Omit for a 10-minute snooze.",
              type: "string"
            },
            id: { description: "The reminder's id (from `due` / `search`) OR a distinct word from its text — copy it EXACTLY as the reminder is worded, in its own language; do NOT translate (e.g. 'dentist', '약', '운동'). An ambiguous word returns the matching candidates instead of guessing.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        keywords: ["reminder", "리마인더", "리마인드", "알림", "remind", "snooze", "postpone", "reschedule", "move", "change", "미뤄", "미루", "연기", "늦춰", "뒤로", "나중에", "옮겨", "바꿔", "변경"],
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
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const firedAtRaw = readString(args, "firedAt")?.trim();
          const firedAt = parseFiredAt(firedAtRaw, now);
          if (isErrorLike(firedAt)) {
            return { error: firedAt.message };
          }
          const reminders = await readReminders(file);
          const lookup = resolveReminderRefOrError(reminders, ref);
          if (!lookup.ok) {
            return lookup.response;
          }
          const next = fireReminder(reminders, lookup.reminder.id, firedAt);
          if (!next) {
            return { error: `reminder not found: ${ref}` };
          }
          try {
            await mutateReminders(file, (current) => fireReminder(current, lookup.reminder.id, firedAt) ?? current);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          const fired = next.find((reminder) => reminder.id === lookup.reminder.id) as PersistedReminder;
          return { reminder: serializeReminderForModel(fired, now) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            firedAt: {
              description: "Optional ISO-8601 timestamp; defaults to now.",
              type: "string"
            },
            id: { description: "The reminder's id (from `due` / `search`) OR a distinct word from its text — copy it EXACTLY as the reminder is worded, in its own language; do NOT translate (e.g. 'dentist', '약', '운동'). An ambiguous word returns candidates.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        name: "fire",
        risk: "write"
      },
      {
        description: "Remove a reminder. `id` is its id OR a distinct word from its text ('dentist'). Returns `{ removed: true, id }` on success, candidates on an ambiguous word, or an error if no match.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const reminders = await readReminders(file);
          const lookup = resolveReminderRefOrError(reminders, ref);
          if (!lookup.ok) {
            return lookup.response;
          }
          try {
            await mutateReminders(file, (current) => current.filter((reminder) => reminder.id !== lookup.reminder.id));
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { id: lookup.reminder.id, removed: true };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The reminder's id (from `due` / `search`) OR a distinct word from its text — copy it EXACTLY as the reminder is worded, in its own language; do NOT translate (e.g. 'dentist', '약', '운동'). An ambiguous word returns candidates.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        keywords: ["reminder", "리마인더", "리마인드", "알림", "remind", "clear", "delete", "remove", "cancel", "삭제", "지워", "제거", "취소", "없애"],
        domain: "tasks",
        name: "clear",
        risk: "write"
      }
    ]
  };
}
