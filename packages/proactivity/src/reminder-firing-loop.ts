import type { MessagingProviderRegistry } from "@muse/messaging";
import { composeIdentityPrompt } from "@muse/prompts";
import { errorMessage } from "@muse/shared";

import { sendWithRetry } from "@muse/mcp-shared";
import { appendReminderHistory, withRequiredProcessLock } from "@muse/stores";
import {
  filterReminders,
  fireReminder,
  mutateReminders,
  type PersistedReminder
} from "@muse/stores";
import type {
  ProactiveActivitySource,
  ProactiveAgentRuntimeLike
} from "./proactive-notice-loop.js";
import { isRecentProactiveActivity } from "./presence.js";

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
 *
 * The whole select→send→mark section runs under the cross-process
 * `withProcessLock` (`${options.file}.firing.lock`, generalized from the
 * digest flush's `withDigestLock` — `@muse/stores/digest-lock.ts`) because the
 * api daemon's tick and the CLI daemon's tick read the SAME reminders
 * file: without a real lock both can read a reminder as due and both
 * deliver it before either marks it fired. A LIVE held lock returns
 * `outcome: "lock-held"` immediately with no send attempted; a broken
 * lock (non-contention fs error) fails OPEN — the tick still runs
 * unlocked rather than silently skipping reminders.
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
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held" | "lock-error";
}

export async function runDueReminders(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const lockPath = `${options.file}.firing.lock`;
  const lockOutcome = await withRequiredProcessLock(lockPath, () => runDueRemindersUnderLock(options));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, due: 0, errors: [], fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.kind === "lock-error") {
    return { delivered: 0, due: 0, errors: [`reminder-tick: lock acquisition failed: ${lockOutcome.error}`], fired: [], outcome: "lock-error" };
  }
  return lockOutcome.value;
}

async function runDueRemindersUnderLock(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const now = options.now ?? (() => new Date());
  let summary: RunDueRemindersSummary = { delivered: 0, due: 0, errors: [], fired: [] };
  await mutateReminders(options.file, async (all) => {
    const due = filterReminders(all, "due", now);
    if (due.length === 0) return all;

    const errors: string[] = [];
    let delivered = 0;
    const fired: PersistedReminder[] = [];
    let next: readonly PersistedReminder[] = all;
    const phaseDActive = isActiveSessionWindow(now(), options);

    for (const reminder of due) {
      const providerId = reminder.via?.providerId ?? options.providerId;
      const destination = reminder.via?.destination ?? options.destination;
      const deliveredText = phaseDActive
        ? await synthesizeReminderText(reminder, options).catch((cause) => {
            const message = errorMessage(cause);
            errors.push(`${reminder.id} synthesis: ${message}`);
            return reminder.text;
          })
        : reminder.text;
      try {
        await sendWithRetry(options.registry, providerId, { destination, text: deliveredText });
        const firedAtIso = now().toISOString();
        const updated = fireReminder(next, reminder.id, firedAtIso);
        const justFired = updated?.find((entry) => entry.id === reminder.id);
        if (updated) next = updated;
        if (justFired) fired.push(justFired);
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
        const message = errorMessage(cause);
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
    summary = { delivered, due: due.length, errors, fired };
    return next;
  });
  return summary;
}

function isActiveSessionWindow(now: Date, options: RunDueRemindersOptions): boolean {
  if (!options.agentRuntime || !options.agentModel || !options.activitySource) {
    return false;
  }
  return isRecentProactiveActivity(
    options.activitySource.lastActivityMs(),
    now.getTime(),
    options.activeSessionWindowMs
  );
}

export const REMINDER_PHASE_D_SYSTEM_PROMPT = composeIdentityPrompt(
  `A reminder the
user set earlier just came due. Compose a single short heads-up
(one or two sentences, ≤ 200 chars) that:
- Names the reminder text and signals it's now (not later)
- Suggests ONE concrete next step the user can take, when an
  obvious one fits the reminder. Skip the suggestion if nothing
  obvious — never invent context.

No emojis, no markdown, no lists, no JSON. Plain text only.`
);

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
    // Machine-authored fact sheet, not a human turn — keeps the
    // register/brevity personalization layer off (it would truncate this).
    metadata: { internalTurn: true },
    messages: [
      { content: REMINDER_PHASE_D_SYSTEM_PROMPT, role: "system" },
      { content: factSheet, role: "user" }
    ],
    model: options.agentModel
  });
  const reply = result.response.output.trim();
  return reply.length > 0 ? reply : reminder.text;
}
