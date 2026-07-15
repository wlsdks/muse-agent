/**
 * Self-followup firing engine — step 4 of
 * `docs/design/agent-self-followup.md`.
 *
 * Counterpart to `runDueReminders`: reads `~/.muse/followups.json`,
 * selects entries whose `status === "scheduled"` and
 * `scheduledFor <= now`, asks the model to compose the follow-up
 * message it promised, sends each one through the messaging
 * registry, and flips the entry to `fired`.
 *
 * Pure data-only function — `modelProvider`, `registry`, and `now`
 * are injected so tests run without env, real API keys, or a real
 * messenger. The `setInterval`-style daemon that drives this on
 * `MUSE_FOLLOWUP_TICK_MS` (default 60s) lives in `apps/api`
 * (`followup-tick.ts`), mirroring `reminder-tick.ts` / `proactive-tick.ts`.
 *
 * Why this exists separately from `reminder-firing-loop.ts`:
 *   - followups carry the *agent's own* prior commitment (summary +
 *     origin turn hash), not a user-authored reminder text;
 *   - synthesis is the primary path, not an opt-in Phase D; there's
 *     no raw-text fallback because a followup without composition
 *     is just a stale timestamp.
 *   - the store schema and lifecycle (`scheduled → fired | cancelled`)
 *     are owned by `personal-followups-store.ts`, not the reminder store.
 */

import type { MessagingProviderRegistry } from "@muse/messaging";
import { composeIdentityPrompt } from "@muse/prompts";

import { sendWithRetry } from "@muse/mcp-shared";
import {
  avoidedSourceKeys,
  compareFollowupsByScheduledFor,
  markFollowupFired,
  readFollowups,
  readTrustLedger,
  withProcessLock,
  type PersistedFollowup
} from "@muse/stores";
import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { ProactiveModelProviderLike } from "./proactive-notice-loop.js";

export interface RunDueFollowupsOptions {
  readonly file: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /** Required — followups synthesize their delivery message. */
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
  readonly now?: () => Date;
  /**
   * Cap per tick so a long-stalled daemon catching up on a week's
   * worth of missed followups doesn't burn the model budget or
   * spam the messenger in one burst. Default 5.
   */
  readonly maxPerTick?: number;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Within budget, a due followup still delivers exactly as before; over
   * budget, the send is skipped and the composed text lands in the digest
   * queue instead — the followup is still marked `fired` either way, so a
   * suppressed one is never re-synthesized and re-attempted next tick.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
}

export interface RunDueFollowupsSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedFollowup[];
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held";
}

const DEFAULT_MAX_PER_TICK = 5;

export const FOLLOWUP_SYSTEM_PROMPT = composeIdentityPrompt(
  `Earlier you told
the user you would follow up at a specific time, and that time has
now arrived. Compose the single short message you said you would
send (one or two sentences, ≤ 240 chars):
- Open with the followup itself — no greetings, no "as I promised".
- Concrete, useful, present tense. If a question is the right
  followup, ask it directly.
- If your prior promise was vague ("I'll check in"), make the
  check-in concrete — pick the most useful thing to actually say
  given the summary, don't echo the vagueness.

No emojis, no markdown, no lists, no JSON. Plain text only.`
);

/**
 * Fire due followups. The whole select→send→mark section runs under the
 * cross-process `withProcessLock` (`${options.file}.firing.lock`, the same
 * generalized lock reminder + checkin firing use — `@muse/stores/digest-lock.ts`)
 * because the api daemon's tick (`followup-tick.ts`) and the CLI daemon's tick
 * (`commands-daemon-register.ts`) read the SAME followups file: `markFollowupFired`
 * is atomic per-item, not mutual exclusion, so without a real lock both can read a
 * followup as due and both deliver it before either marks it fired. A LIVE held
 * lock returns `outcome: "lock-held"` immediately with no send attempted; a broken
 * lock (non-contention fs error) fails OPEN — the tick still runs unlocked rather
 * than silently skipping followups.
 */
export async function runDueFollowups(options: RunDueFollowupsOptions): Promise<RunDueFollowupsSummary> {
  const lockPath = `${options.file}.firing.lock`;
  const lockOutcome = await withProcessLock(lockPath, () => runDueFollowupsUnderLock(options));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, due: 0, errors: [], fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.lockError !== undefined) {
    // Fail-open on a BROKEN lock (not contention): the tick still ran,
    // unlocked, so this degrades to the pre-lock duplicate-delivery risk
    // rather than silencing followups.
    return {
      ...lockOutcome.value,
      errors: [`followup-tick: lock acquisition failed, proceeding without lock: ${lockOutcome.lockError}`, ...lockOutcome.value.errors]
    };
  }
  return lockOutcome.value;
}

async function runDueFollowupsUnderLock(options: RunDueFollowupsOptions): Promise<RunDueFollowupsSummary> {
  const now = options.now ?? (() => new Date());
  // `??` does NOT catch NaN/Infinity: a non-numeric env knob
  // (MUSE_FOLLOWUP_MAX_PER_TICK="5x" → Number(...) → NaN) would make
  // `Math.max(1, NaN)` → NaN, and `.slice(0, NaN)` drops every due
  // followup — silently firing zero forever. Fall back to the default
  // for non-finite values, matching the scheduler's clampInterval guard.
  const requested = Number.isFinite(options.maxPerTick) ? Math.trunc(options.maxPerTick!) : DEFAULT_MAX_PER_TICK;
  const max = Math.max(1, requested);
  const all = await readFollowups(options.file);
  const cutoffMs = now().getTime();
  // Sort soonest-scheduledFor-first (= most-overdue-first for past times) BEFORE the
  // per-tick cap, so when a backlog exceeds maxPerTick the genuinely most-overdue
  // commitments win the budget instead of an arbitrary file-order slice starving them.
  const due = all
    .filter((entry) => entry.status === "scheduled" && Date.parse(entry.scheduledFor) <= cutoffMs)
    .sort(compareFollowupsByScheduledFor)
    .slice(0, max);

  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }

  const errors: string[] = [];
  const fired: PersistedFollowup[] = [];
  let delivered = 0;

  const avoidedSources = options.interruptionBudget?.trustLedgerFile
    ? avoidedSourceKeys(await readTrustLedger(options.interruptionBudget.trustLedgerFile).catch(() => []))
    : undefined;

  for (const followup of due) {
    try {
      const text = await synthesizeFollowupText(followup, options);
      if (text.length === 0) {
        errors.push(`${followup.id}: synthesis returned empty text`);
        continue;
      }
      // Retry wraps only the send — synthesis above already ran
      // once, so a transient 5xx doesn't re-invoke the model.
      const deliver = (): Promise<void> => sendWithRetry(options.registry, options.providerId, {
        destination: options.destination,
        text
      }).then(() => undefined);
      let digested = false;
      if (options.interruptionBudget) {
        const budget = options.interruptionBudget;
        const result = await applyInterruptionBudget({
          avoidedSources,
          caps: resolveInterruptionBudgetCaps(budget),
          deliver,
          digestFile: budget.digestFile,
          errorLogger: (message) => errors.push(`${followup.id}: ${message}`),
          ...(budget.lastDeliveryFile ? { lastDeliveryFile: budget.lastDeliveryFile } : {}),
          ledgerFile: budget.ledgerFile,
          now: now(),
          source: "followup",
          sourceId: followup.id,
          sourceKey: `followup:${followup.id}`,
          text,
          title: followup.summary
        });
        digested = result.outcome !== "delivered";
      } else {
        await deliver();
      }
      // Marked fired either way: a suppressed followup must not be
      // re-synthesized and re-attempted next tick just because the
      // budget held it back from sending.
      const firedAtIso = now().toISOString();
      const patched = await markFollowupFired(options.file, followup.id, firedAtIso);
      if (patched) {
        fired.push(patched);
      }
      if (!digested) {
        delivered += 1;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${followup.id}: ${message}`);
    }
  }

  return { delivered, due: due.length, errors, fired };
}

async function synthesizeFollowupText(
  followup: PersistedFollowup,
  options: RunDueFollowupsOptions
): Promise<string> {
  const factSheet = [
    `kind: self-followup`,
    `committed summary: ${followup.summary}`,
    `scheduled for: ${followup.scheduledFor}`,
    `now firing.`
  ].join("\n");
  const result = await options.modelProvider.generate({
    maxOutputTokens: 200,
    messages: [
      { content: FOLLOWUP_SYSTEM_PROMPT, role: "system" },
      { content: factSheet, role: "user" }
    ],
    model: options.model,
    temperature: 0.4
  });
  return result.output.trim();
}
