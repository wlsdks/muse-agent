import type { MessagingProviderRegistry } from "@muse/messaging";

import { sendWithRetry } from "@muse/mcp-shared";
import { appendReminderHistory } from "@muse/stores";
import {
  filterReminders,
  fireReminder,
  mutateReminders,
  readReminders,
  type PersistedReminder
} from "@muse/stores";
import type {
  ProactiveActivitySource,
  ProactiveAgentRuntimeLike
} from "./proactive-notice-loop.js";

/**
 * Phase B firing engine — see `docs/design/reminder-firing.md`.
 *
 * Reads due reminders, fans out to the messaging registry, marks
 * each delivered one as fired, and persists the new state with one
 * atomic write. Pure code path: no LLM, no daemon. The CLI's
 * `muse remind run` calls it directly; a follow-up iter wires it
 * into a scheduler tick so the same engine runs every minute
 * without the user invoking it.
 *
 * The function is data-only — `registry` and `now` are injected so
 * tests can supply fakes without touching env or the real
 * messenger APIs.
 */

export interface RunDueRemindersOptions {
  readonly file: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly now?: () => Date;
  /**
   * When set, every delivery attempt (success or failure) is
   * appended to this file via `appendReminderHistory`. Records the
   * resolved providerId/destination so the user can audit "did the
   * 9am reminder actually land?" weeks later — even if the source
   * reminder has since been cleared.
   */
  readonly historyFile?: string;
  /**
   * Phase D (mirrors proactive surfacing) — when all three are set
   * AND the activity source reports activity within
   * `activeSessionWindowMs`, the firing loop spawns a one-shot
   * agent run with a JARVIS-style synthesis prompt and uses the
   * LLM reply as the delivered message instead of the raw
   * `reminder.text`. Falls back to the flat text on missing wires,
   * stale window, empty reply, or synthesis error (the failure is
   * recorded in `summary.errors` but the reminder still fires with
   * the original text so the user never misses a beat).
   */
  readonly agentRuntime?: ProactiveAgentRuntimeLike;
  readonly agentModel?: string;
  readonly activitySource?: ProactiveActivitySource;
  /** Default 5 minutes (300_000 ms). */
  readonly activeSessionWindowMs?: number;
}

export interface RunDueRemindersSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedReminder[];
}

export async function runDueReminders(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const now = options.now ?? (() => new Date());
  const all = await readReminders(options.file);
  const due = filterReminders(all, "due", now);

  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }

  const errors: string[] = [];
  let delivered = 0;
  const fired: PersistedReminder[] = [];

  // Phase D — decide once whether the active-session window allows
  // agent-synthesized notices for this tick. All three pieces must
  // be wired AND the activity tracker must report something within
  // the window. Mirrors the proactive-tick gate so a shared
  // activity tracker unlocks both daemons in lockstep.
  const phaseDActive = isActiveSessionWindow(now(), options);

  for (const reminder of due) {
    // Phase C: per-reminder routing wins when set; the loop's
    // defaults are the fallback when the reminder doesn't
    // declare a destination. Resolved before the try so the
    // history record can attribute the failure to the same
    // resolved destination on the failure path.
    const providerId = reminder.via?.providerId ?? options.providerId;
    const destination = reminder.via?.destination ?? options.destination;
    const deliveredText = phaseDActive
      ? await synthesizeReminderText(reminder, options).catch((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          errors.push(`${reminder.id} synthesis: ${message}`);
          return reminder.text;
        })
      : reminder.text;
    try {
      await sendWithRetry(options.registry, providerId, {
        destination,
        text: deliveredText
      });
      const firedAtIso = now().toISOString();
      // Persist per-delivery under the cross-process lock, RE-READING the
      // current file inside it: the loop's in-memory `next` doesn't include a
      // reminder a chat `add` wrote after this tick started, so a plain write
      // would clobber it (the reported daemon-vs-chat lost-write). Marking THIS
      // reminder fired by id merges with concurrent adds instead.
      let justFired: PersistedReminder | undefined;
      await mutateReminders(options.file, (current) => {
        const updated = fireReminder(current, reminder.id, firedAtIso);
        if (!updated) return current;
        justFired = updated.find((entry) => entry.id === reminder.id);
        return updated;
      });
      if (justFired) {
        fired.push(justFired);
      }
      delivered += 1;
      if (options.historyFile) {
        await appendReminderHistory(options.historyFile, {
          destination,
          firedAtIso,
          providerId,
          reminderId: reminder.id,
          status: "delivered",
          text: deliveredText
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${reminder.id}: ${message}`);
      if (options.historyFile) {
        await appendReminderHistory(options.historyFile, {
          destination,
          error: message,
          firedAtIso: now().toISOString(),
          providerId,
          reminderId: reminder.id,
          status: "failed",
          text: deliveredText
        });
      }
    }
  }

  // No trailing batch write — the per-delivery writeReminders
  // above already persisted every status flip.

  return { delivered, due: due.length, errors, fired };
}

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60_000;

function isActiveSessionWindow(now: Date, options: RunDueRemindersOptions): boolean {
  if (!options.agentRuntime || !options.agentModel || !options.activitySource) {
    return false;
  }
  const lastMs = options.activitySource.lastActivityMs();
  if (lastMs === undefined) {
    return false;
  }
  const window = options.activeSessionWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  return now.getTime() - lastMs <= window;
}

const REMINDER_PHASE_D_SYSTEM_PROMPT =
  `You are Muse, the user's JARVIS-style assistant. A reminder the
user set earlier just came due. Compose a single short heads-up
(one or two sentences, ≤ 200 chars) that:
- Names the reminder text and signals it's now (not later)
- Suggests ONE concrete next step the user can take, when an
  obvious one fits the reminder. Skip the suggestion if nothing
  obvious — never invent context.

No emojis, no markdown, no lists, no JSON. Plain text only.`;

async function synthesizeReminderText(
  reminder: PersistedReminder,
  options: RunDueRemindersOptions
): Promise<string> {
  if (!options.agentRuntime || !options.agentModel) {
    return reminder.text;
  }
  const dueLine = reminder.dueAt ? `due at: ${reminder.dueAt}` : `due: now`;
  const factSheet = [
    `kind: reminder`,
    `reminder text: ${reminder.text}`,
    dueLine
  ].join("\n");
  const result = await options.agentRuntime.run({
    messages: [
      { content: REMINDER_PHASE_D_SYSTEM_PROMPT, role: "system" },
      { content: factSheet, role: "user" }
    ],
    model: options.agentModel
  });
  const reply = result.response.output.trim();
  return reply.length > 0 ? reply : reminder.text;
}
