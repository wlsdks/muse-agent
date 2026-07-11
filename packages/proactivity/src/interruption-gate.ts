/**
 * The interruption-budget seam every UNASKED notice loop wraps its outbound
 * send in (`pattern-firing-loop`, `ambient-notice-loop`, `followup-firing-loop`,
 * `background-exit-notice-loop`, `commitment-checkin`). Placed AFTER each
 * loop's own quiet-hours / dedupe / veto gating, immediately around the
 * actual send: within budget → deliver + record in the ledger; over budget →
 * queue to the digest instead of sending (`packages/stores`'
 * `withinInterruptionBudget` / `appendInterruptionDelivery` / `appendDigestItem`).
 *
 * Fail-open by design: a ledger-read error is treated as within budget (never
 * gags a delivery), and a ledger-append error after a successful deliver still
 * reports "delivered" (the send already happened) — both are logged, never
 * thrown. A digest-append failure on the suppressed path is the one accepted
 * lossy edge: the budget already said "don't send this", so falling back to
 * delivery would defeat the cap — the item is dropped and the failure is
 * logged loudly rather than silently.
 */

import {
  appendDigestItem,
  appendInterruptionDelivery,
  readInterruptionLedger,
  withinInterruptionBudget,
  type InterruptionBudgetCaps
} from "@muse/stores";

/** The opt-in wiring shape every gated loop's options carry. Absent → the
 *  loop's send is ungated (back-compat, byte-identical to pre-budget behavior). */
export interface InterruptionBudgetWiring {
  readonly ledgerFile: string;
  readonly digestFile: string;
  /** `<= 0` (or unset) disables that window — matches `withinInterruptionBudget`. */
  readonly hourlyCap?: number;
  readonly dailyCap?: number;
}

export function resolveInterruptionBudgetCaps(wiring: InterruptionBudgetWiring): InterruptionBudgetCaps {
  return { dailyCap: wiring.dailyCap ?? 0, hourlyCap: wiring.hourlyCap ?? 0 };
}

export interface ApplyInterruptionBudgetOptions {
  readonly ledgerFile: string;
  readonly digestFile: string;
  readonly caps: InterruptionBudgetCaps;
  readonly now: Date;
  /** The firing loop, e.g. "pattern-firing", "ambient-notice". */
  readonly source: string;
  /** The notice text — compiled verbatim into the digest when suppressed. */
  readonly text: string;
  readonly sourceId?: string;
  /** Performs the actual send. A throw here propagates uncaught — a real
   *  delivery failure is the caller's own concern, not the budget's. */
  readonly deliver: () => Promise<void>;
  readonly errorLogger?: (message: string) => void;
}

export interface ApplyInterruptionBudgetResult {
  readonly outcome: "delivered" | "digested";
}

/**
 * Consult the ledger; within budget → deliver then record the delivery;
 * over budget → queue to the digest (never deliver). A throw from `deliver`
 * propagates to the caller uncaught.
 */
export async function applyInterruptionBudget(
  options: ApplyInterruptionBudgetOptions
): Promise<ApplyInterruptionBudgetResult> {
  let withinBudget: boolean;
  try {
    const entries = await readInterruptionLedger(options.ledgerFile);
    withinBudget = withinInterruptionBudget(entries, options.now, options.caps);
  } catch (cause) {
    options.errorLogger?.(`interruption-budget: ledger read failed, delivering: ${describe(cause)}`);
    withinBudget = true;
  }

  if (withinBudget) {
    await options.deliver();
    try {
      await appendInterruptionDelivery(options.ledgerFile, { at: options.now, source: options.source });
    } catch (cause) {
      options.errorLogger?.(`interruption-budget: ledger append failed (delivery already sent): ${describe(cause)}`);
    }
    return { outcome: "delivered" };
  }

  try {
    await appendDigestItem(options.digestFile, {
      at: options.now,
      source: options.source,
      text: options.text,
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {})
    });
  } catch (cause) {
    options.errorLogger?.(`interruption-budget: digest append failed, notice lost: ${describe(cause)}`);
  }
  return { outcome: "digested" };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
