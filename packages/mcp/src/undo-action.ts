/**
 * One-tap undo/veto of a logged autonomous action (P6-b2 — the
 * "undo + teach" half of the correction loop):
 *
 *   1. reverse the action where reversible (injected inverse —
 *      e.g. close the issue that was opened); irreversible actions
 *      skip this but still proceed,
 *   2. record a durable memory veto for that action class so the
 *      SAME trigger no longer auto-acts (the veto overrides prior
 *      consent in `performConsentedAction`),
 *   3. append an action-log entry for the undo itself, so the
 *      correction is as accountable as the original action.
 */

import { appendActionLog } from "@muse/stores";
import { recordVeto } from "@muse/stores";

export interface UndoLoggedActionOptions {
  readonly userId: string;
  readonly objectiveId: string;
  readonly scope: string;
  /** Id of the original logged action — cited in the undo entry. */
  readonly originalActionId: string;
  readonly vetoFile: string;
  readonly actionLogFile: string;
  readonly now?: () => Date;
  /**
   * The inverse action when reversible (returns a short detail).
   * Omit for an irreversible action — the veto is still recorded
   * so it cannot recur.
   */
  readonly reverse?: () => Promise<{ readonly detail: string }>;
  readonly reason?: string;
}

export interface UndoLoggedActionResult {
  readonly reversed: boolean;
  readonly vetoId: string;
}

export async function undoLoggedAction(options: UndoLoggedActionOptions): Promise<UndoLoggedActionResult> {
  const now = options.now ?? (() => new Date());
  const whenIso = now().toISOString();

  let reversed = false;
  let detail = "irreversible — veto recorded so it cannot recur";
  if (options.reverse) {
    detail = (await options.reverse()).detail;
    reversed = true;
  }

  const vetoId = `veto_${options.objectiveId}_${options.scope}`;
  await recordVeto(options.vetoFile, {
    id: vetoId,
    objectiveId: options.objectiveId,
    scope: options.scope,
    userId: options.userId,
    vetoedAt: whenIso,
    ...(options.reason ? { reason: options.reason } : {})
  });

  await appendActionLog(options.actionLogFile, {
    detail,
    id: `undo_${options.originalActionId}`,
    objectiveId: options.objectiveId,
    // The undo OPERATION succeeded (the veto is recorded);
    // `detail` says whether the external reversal also happened.
    result: "performed",
    userId: options.userId,
    what: `undo of action ${options.originalActionId}`,
    when: whenIso,
    why: options.reason ?? "user veto"
  });

  return { reversed, vetoId };
}
