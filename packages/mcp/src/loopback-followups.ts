import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import {
  cancelFollowup,
  compareFollowupsByScheduledFor,
  readFollowups,
  readFollowupStatusFilter,
  resolveFollowupRef,
  serializeFollowup,
  snoozeFollowup
} from "./personal-followups-store.js";
import { parseReminderDueAt } from "./personal-reminders-store.js";

/**
 * `muse.followup` loopback MCP server — gives the agent
 * introspection + control over its own self-captured follow-up
 * promises (`~/.muse/followups.json`).
 *
 * Intentionally NO `add` / `fire` tools:
 *
 *   - Capture is *automatic* — the runtime hook detects time-bound
 *     promises in assistant turns and writes them with the linkage
 *     fields (`originRunId`, `originTurnHash`) that a manually-added
 *     entry would lack. Exposing `add` to the LLM would invite
 *     stale, ungrounded commitments.
 *   - Firing is daemon-only (`apps/api/src/followup-tick.ts`). The
 *     LLM doesn't deliver followups; the messaging sink does.
 *
 * So the surface is just: see the queue, snooze it, cancel it.
 * Use cases: "I changed my mind, drop that 3pm check-in", "push
 * the report follow-up to tomorrow morning instead".
 */
export interface FollowupsMcpServerOptions {
  readonly file: string;
  readonly now?: () => Date;
  readonly maxListEntries?: number;
}

export function createFollowupsMcpServer(options: FollowupsMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));

  return {
    description:
      "Self-captured follow-up promises. Read + cancel + snooze; capture is automatic, firing is daemon-only.",
    name: "muse.followup",
    tools: [
      {
        description:
          "List followups the agent has promised. `status` filter: 'scheduled' (default), 'fired', 'cancelled', or 'all'. " +
          "Sorted by scheduledFor ascending up to `" + maxListEntries.toString() + "` entries. " +
          "Use 'scheduled' to see what's still pending; 'all' to look back at history when the user says " +
          "'did you follow up on that?'. " +
          "Use when the user asks to SEE the agent's own pending follow-up commitments ('what are you supposed to check back on?', '팔로업 목록 보여줘'). " +
          "NOT when the user wants their personal to-do list (use muse.tasks.list) or their reminders/alerts (use muse.reminders.list) — a followup is a thread the agent auto-captured; a task and a reminder are things the USER explicitly added.",
        execute: async (args): Promise<JsonObject> => {
          const status = readFollowupStatusFilter(readString(args, "status"));
          const all = await readFollowups(file);
          const filtered = status === "all" ? all : all.filter((entry) => entry.status === status);
          const sorted = [...filtered]
            .sort(compareFollowupsByScheduledFor)
            .slice(0, maxListEntries);
          return {
            followups: sorted.map(serializeFollowup) as JsonValue,
            status,
            total: sorted.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            status: { enum: ["scheduled", "fired", "cancelled", "all"], type: "string" }
          },
          type: "object"
        },
        domain: "tasks",
        name: "list",
        risk: "read"
      },
      {
        description:
          "Cancel a scheduled followup. Only works on entries with status='scheduled' — already-fired or " +
          "already-cancelled entries return an error rather than silently no-op. `reason` is recorded on " +
          "the entry (default 'agent-cancelled'). " +
          "Use when the user wants to DROP one of the agent's auto-captured follow-up commitments ('cancel that check-in you promised', '팔로업 취소해줘', 'never mind the budget follow-up'). You do NOT need to list first — pass a distinct word from the followup in `id` and Muse resolves it. " +
          "NOT when the user wants to delete a task they added themselves (use muse.tasks.delete) or clear a timed reminder (use muse.reminders.clear) — followups are agent-originated threads, not user-entered items.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          // Resolve a word/id REFERENCE → the followup, so cancelling is one-shot
          // (no prior list). Ambiguous returns candidates; never cancel on a guess.
          const resolution = resolveFollowupRef(await readFollowups(file), ref);
          if (resolution.status === "ambiguous") {
            return { error: `"${ref}" matches multiple followups — say which one`, candidates: resolution.candidates.map((entry) => ({ id: entry.id, summary: entry.summary })) as JsonValue };
          }
          if (resolution.status === "not-found") {
            return { error: `no followup matches "${ref}"` };
          }
          const id = resolution.followup.id;
          const reason = readString(args, "reason")?.trim() || "agent-cancelled";
          try {
            const patched = await cancelFollowup(file, id, reason);
            if (!patched) {
              // Differentiate "not found" from "wrong status" so the LLM can
              // adjust — e.g. apologise that it already fired and ask if the
              // user wants a fresh one instead.
              const all = await readFollowups(file);
              const existing = all.find((entry) => entry.id === id);
              if (!existing) {
                return { error: `followup not found: ${id}` };
              }
              return { error: `followup ${id} is already ${existing.status}; only scheduled followups can be cancelled` };
            }
            return { followup: serializeFollowup(patched) as JsonValue };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The followup's id (from `list`) OR a distinct word from its summary — copy it EXACTLY as worded, in its own language (e.g. 'budget', '약'). An ambiguous word returns the matching candidates instead of guessing.", type: "string" },
            reason: { description: "Short reason recorded on the entry. Default 'agent-cancelled'.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        groundedArgs: ["reason"],
        domain: "tasks",
        name: "cancel",
        risk: "write"
      },
      {
        description:
          "Push a scheduled followup's `scheduledFor` to a new time. `scheduledFor` accepts the same " +
          "grammar as `muse.reminders.snooze` — either ISO-8601 or relative ('in 2 hours', 'tomorrow at 9am', " +
          "'2시간 뒤'). Lifecycle-guarded: only scheduled entries can be snoozed; resurrecting fired or " +
          "cancelled entries would be a surprise. " +
          "Use when the user wants to DELAY one of the agent's follow-up commitments to a later time ('push that follow-up to tomorrow', '팔로업 내일로 미뤄줘', 'delay the budget check-in'). You do NOT need to list first — pass a distinct word from the followup in `id` and Muse resolves it. " +
          "NOT when the user wants to snooze a reminder they set themselves (use muse.reminders.snooze) or reschedule a task (use muse.tasks.update) — this only moves agent-captured followups.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const resolution = resolveFollowupRef(await readFollowups(file), ref);
          if (resolution.status === "ambiguous") {
            return { error: `"${ref}" matches multiple followups — say which one`, candidates: resolution.candidates.map((entry) => ({ id: entry.id, summary: entry.summary })) as JsonValue };
          }
          if (resolution.status === "not-found") {
            return { error: `no followup matches "${ref}"` };
          }
          const id = resolution.followup.id;
          const whenRaw = readString(args, "scheduledFor")?.trim();
          if (!whenRaw) {
            return { error: "scheduledFor is required" };
          }
          const parsed = parseReminderDueAt(whenRaw, now);
          if (parsed instanceof Error) {
            return { error: parsed.message };
          }
          try {
            const patched = await snoozeFollowup(file, id, parsed);
            if (!patched) {
              const all = await readFollowups(file);
              const existing = all.find((entry) => entry.id === id);
              if (!existing) {
                return { error: `followup not found: ${id}` };
              }
              return { error: `followup ${id} is already ${existing.status}; only scheduled followups can be snoozed` };
            }
            return { followup: serializeFollowup(patched) as JsonValue };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The followup's id (from `list`) OR a distinct word from its summary — copy it EXACTLY as worded, in its own language (e.g. 'budget', '약'). An ambiguous word returns the matching candidates instead of guessing.", type: "string" },
            scheduledFor: {
              description: "New target time. ISO-8601 or relative phrase ('in 2 hours', 'tomorrow at 9am').",
              type: "string"
            }
          },
          required: ["id", "scheduledFor"],
          type: "object"
        },
        domain: "tasks",
        name: "snooze",
        risk: "write"
      }
    ]
  };
}
