/**
 * On-exit proactive notice (DS-10) — turn a background process finishing
 * into a one-shot "your job '<label>' finished" heads-up.
 *
 * Muse's background-process registry (`@muse/stores`) already records a
 * spawned process moving to `exited` / `failed` (both while Muse is up, via
 * the child's `onExit` hook, AND across a restart, via
 * `reconcileBackgroundProcesses` marking a dead-while-down PID `exited`).
 * This loop RIDES that existing exit signal — it does not spawn or watch
 * anything — so a single poll covers the in-process and the crash-restart
 * cases uniformly.
 *
 * Design choice vs. a new scheduler `on-exit` kind: the exit signal already
 * lands in the store, and `@muse/stores` cannot depend on the notice broker
 * (that is a layering inversion). So the natural, least-invasive home is a
 * poll here — mirroring every other `runDue*` proactive trigger — rather
 * than extending the cron schema or coupling the store layer to delivery.
 *
 * Fail-closed one-shot (the openclaw on-exit pattern): the process id is
 * persisted to the notified sidecar BEFORE the notice is delivered, so a
 * crash-restart between "delivered" and "persisted" can never re-fire an
 * already-notified exit. The trade-off is at-most-once: a crash in the tiny
 * window after persisting drops that one notice rather than double-sending —
 * the correct bias for an unasked push.
 */

import { promises as fs } from "node:fs";

import type { MessagingProviderRegistry } from "@muse/messaging";
import { sendWithRetry } from "@muse/mcp-shared";
import { redactSecretsInText } from "@muse/shared";
import { readBackgroundProcesses, type BackgroundProcessRecord } from "@muse/stores";

import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";

/** Terminal states that warrant a heads-up. `killed` is user-initiated
 *  (they ran `muse bg stop`) so it is deliberately excluded — the user
 *  already knows it stopped. */
const NOTIFY_STATUSES: ReadonlySet<string> = new Set(["exited", "failed"]);

export interface BackgroundExitNotifiedSidecar {
  readonly notifiedIds: readonly string[];
}

/** Read the one-shot sidecar. Missing / corrupt degrades to empty, never throws. */
export async function readBackgroundExitNotified(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackgroundExitNotifiedSidecar>;
    if (Array.isArray(parsed.notifiedIds)) {
      return new Set(parsed.notifiedIds.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    /* corrupt → treat as none notified (fail-open read; the fail-CLOSED
       guarantee is the write-before-deliver ordering below) */
  }
  return new Set();
}

async function writeBackgroundExitNotified(file: string, ids: ReadonlySet<string>): Promise<void> {
  const payload: BackgroundExitNotifiedSidecar = { notifiedIds: [...ids] };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Short, redaction-safe label for a background process (its command, capped). */
export function backgroundJobLabel(record: BackgroundProcessRecord): string {
  const command = record.command.trim();
  const firstLine = command.split("\n")[0] ?? command;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/** One-line notice text for a finished background job. */
export function backgroundExitNoticeText(record: BackgroundProcessRecord): string {
  const label = backgroundJobLabel(record);
  if (record.status === "failed") {
    const code = typeof record.exitCode === "number" ? ` (exit code ${record.exitCode.toString()})` : "";
    return `⚠️ background job '${label}' failed${code}`;
  }
  const code = typeof record.exitCode === "number" ? ` — exit code ${record.exitCode.toString()}` : "";
  return `✅ background job '${label}' finished${code}`;
}

export interface RunDueBackgroundExitNoticesOptions {
  /** Background-process registry file (`~/.muse/background-processes.json`). */
  readonly storeFile: string;
  /**
   * One-shot sidecar tracking which exited process ids have already been
   * notified. Persisted BEFORE delivery so a restart cannot double-fire.
   */
  readonly notifiedFile: string;
  /**
   * Notice broker — fans the heads-up to live chat-stream subscribers,
   * mirroring the proactive-notice loop's broker fan-out.
   */
  readonly broker?: AgentInitiatedNoticeBrokerLike;
  readonly brokerUserId?: string;
  /** Optional messaging delivery (Telegram / Discord / log) for the notice. */
  readonly messagingRegistry?: MessagingProviderRegistry;
  readonly providerId?: string;
  readonly destination?: string;
  /** Injectable clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Gates only the `messagingRegistry` leg — the broker fan-out (live
   * chat-stream subscribers) is unaffected. Within budget, the messaging
   * send still happens exactly as before; over budget, it's skipped and the
   * notice text lands in the digest queue instead. The one-shot
   * `notifiedFile` mark already happens BEFORE any delivery attempt, so a
   * suppressed exit is never re-notified regardless.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
}

export interface RunDueBackgroundExitNoticesSummary {
  /** Terminal, not-yet-notified records found this tick. */
  readonly pending: number;
  /** Notices actually delivered this tick. */
  readonly notified: number;
  /** One string per delivery failure (the id stays marked to preserve at-most-once). */
  readonly errors: readonly string[];
}

/**
 * Poll the background registry and fire a one-shot notice for each newly
 * finished (exited/failed) process. Reads are fail-open; the one-shot
 * guarantee is the persist-before-deliver ordering. A record already in the
 * notified sidecar is skipped, so repeated ticks — and a restart — fire each
 * real exit exactly once.
 */
export async function runDueBackgroundExitNotices(
  options: RunDueBackgroundExitNoticesOptions
): Promise<RunDueBackgroundExitNoticesSummary> {
  const now = options.now ?? (() => new Date());
  const records = await readBackgroundProcesses(options.storeFile);
  const notified = new Set(await readBackgroundExitNotified(options.notifiedFile));

  const pending = records.filter(
    (record) => NOTIFY_STATUSES.has(record.status) && !notified.has(record.id)
  );
  if (pending.length === 0) {
    return { errors: [], notified: 0, pending: 0 };
  }

  const errors: string[] = [];
  let delivered = 0;

  for (const record of pending) {
    // Fail-closed one-shot: mark BEFORE delivery and persist immediately, so
    // a crash before the next write cannot re-fire this exit on restart.
    notified.add(record.id);
    try {
      await writeBackgroundExitNotified(options.notifiedFile, notified);
    } catch (cause) {
      // Could not persist the mark → do NOT deliver (delivering now would
      // risk a double-fire after restart). Roll back the in-memory mark and
      // record the error; a later tick retries.
      notified.delete(record.id);
      errors.push(`${record.id}: sidecar write failed: ${describe(cause)}`);
      continue;
    }

    const text = redactSecretsInText(backgroundExitNoticeText(record));
    const generatedAt = now().toISOString();
    try {
      let anySink = false;
      let digested = false;
      if (options.broker && options.brokerUserId) {
        options.broker.publish(options.brokerUserId, {
          generatedAt,
          kind: "background_process_exited",
          sourceId: record.id,
          text
        });
        anySink = true;
      }
      if (options.messagingRegistry && options.providerId && options.destination) {
        const messagingRegistry = options.messagingRegistry;
        const providerId = options.providerId;
        const destination = options.destination;
        const deliver = (): Promise<void> => sendWithRetry(messagingRegistry, providerId, { destination, text }).then(() => undefined);
        if (options.interruptionBudget) {
          const budget = options.interruptionBudget;
          const result = await applyInterruptionBudget({
            caps: resolveInterruptionBudgetCaps(budget),
            deliver,
            digestFile: budget.digestFile,
            errorLogger: (message) => errors.push(`${record.id}: ${message}`),
            ledgerFile: budget.ledgerFile,
            now: now(),
            source: "background-exit",
            sourceId: record.id,
            text
          });
          if (result.outcome === "digested") {
            digested = true;
          } else {
            anySink = true;
          }
        } else {
          await deliver();
          anySink = true;
        }
      }
      if (anySink) {
        delivered += 1;
      } else if (!digested) {
        errors.push(`${record.id}: no delivery sink configured`);
      }
    } catch (cause) {
      // At-most-once: the id stays marked (no re-fire), the failure is surfaced.
      errors.push(`${record.id}: ${describe(cause)}`);
    }
  }

  return { errors, notified: delivered, pending: pending.length };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
