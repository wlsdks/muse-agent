import type { JsonObject, JsonValue } from "@muse/shared";
import { recordTimeParseWeakness, recordWeakness } from "@muse/stores";
import {
  compareRemindersByDueAt,
  resolveReminderRef,
  serializeReminderForModel,
  type PersistedReminder
} from "@muse/stores";

/**
 * Non-tool-definition reminder server logic lifted out of
 * `loopback-reminders.ts` — ref resolution → tool-error shaping, firedAt
 * validation, list/search pagination + serialization, and the time-parse
 * weakness ledger write. `loopback-reminders.ts` keeps the MCP tool surface
 * itself (name/description/schema/execute wiring, byte-stable for
 * tool-calling) and re-exports the symbols below so its import sites stay
 * unchanged.
 */

export type ReminderRefLookup =
  | { readonly ok: true; readonly reminder: PersistedReminder }
  | { readonly ok: false; readonly response: JsonObject };

/**
 * `snooze` / `fire` / `clear` all resolve their `id` arg (id-or-word) the
 * same way and shape the same ambiguous/not-found tool error — dedupe that
 * shape here so all three stay in lockstep.
 */
export function resolveReminderRefOrError(
  reminders: readonly PersistedReminder[],
  ref: string
): ReminderRefLookup {
  const resolution = resolveReminderRef(reminders, ref);
  if (resolution.status === "ambiguous") {
    return {
      ok: false,
      response: {
        error: `"${ref}" matches multiple reminders — say which one`,
        candidates: resolution.candidates.map((r) => ({ id: r.id, text: r.text }))
      }
    };
  }
  if (resolution.status !== "resolved") {
    return { ok: false, response: { error: `reminder not found: ${ref}` } };
  }
  return { ok: true, reminder: resolution.reminder };
}

/**
 * `fire`'s optional `firedAt` — an explicit ISO-8601 timestamp for a delayed
 * log entry, or the current time when omitted.
 */
export function parseFiredAt(firedAtRaw: string | undefined, now: () => Date): string | Error {
  if (!firedAtRaw || firedAtRaw.length === 0) {
    return now().toISOString();
  }
  const parsed = new Date(firedAtRaw);
  if (Number.isNaN(parsed.getTime())) {
    return new Error(`firedAt must be a parseable ISO-8601 timestamp (got ${JSON.stringify(firedAtRaw)})`);
  }
  return parsed.toISOString();
}

/**
 * `list` / `search` both sort by dueAt, cap at `maxListEntries`, and
 * serialize for the model — only their upstream filter differs.
 */
export function serializeSortedReminders(
  filtered: readonly PersistedReminder[],
  maxListEntries: number,
  now: () => Date
): { reminders: JsonValue; shown: number; total: number } {
  const sorted = [...filtered].sort(compareRemindersByDueAt);
  const shownList = sorted.slice(0, maxListEntries);
  return {
    reminders: [...shownList.map((reminder) => serializeReminderForModel(reminder, now))],
    shown: shownList.length,
    total: sorted.length
  };
}

/**
 * `add` and `snooze` both record the same time-parse weakness when the
 * deterministic dueAt parser fails, so a recurring misread surfaces
 * (whetstone). Fail-soft — a ledger write must never surface as a tool
 * error.
 */
export async function recordDueAtParseWeakness(dueAtRaw: string, weaknessesFile: string | undefined): Promise<void> {
  if (!weaknessesFile) {
    return;
  }
  try {
    await recordTimeParseWeakness(dueAtRaw, true, { recordWeakness, weaknessesFile });
  } catch { /* ledger write must never surface as a tool error */ }
}
