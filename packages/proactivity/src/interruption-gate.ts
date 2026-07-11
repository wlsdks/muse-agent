/**
 * The interruption-budget seam every UNASKED notice loop wraps its outbound
 * send in (`pattern-firing-loop`, `ambient-notice-loop`, `followup-firing-loop`,
 * `background-exit-notice-loop`, `commitment-checkin`). Placed AFTER each
 * loop's own quiet-hours / dedupe / veto gating, immediately around the
 * actual send: within budget → deliver + record in the ledger; over budget →
 * queue to the digest instead of sending (`packages/stores`'
 * `withinInterruptionBudget` / `appendInterruptionDelivery` / `appendDigestItem`).
 *
 * `avoidedSources` is the channel-veto skip: a source the trust ledger
 * recorded as `vetoed` never sends AND never digests — no `deliver()` call,
 * no digest-queue append, complete silence (checked before the budget lookup,
 * so a vetoed source doesn't even spend budget capacity). The match is exact
 * OR kind-level (`isVetoed`, `./veto-key.js`) — a veto recorded at just the
 * kind (e.g. "followup", for a one-shot id that never recurs) silences every
 * future notice from that loop, not only the exact instance. Callers resolve
 * this Set from `proactive-trust-ledger`'s `avoidedSourceKeys` fresh per tick;
 * this module stays a pure consumer of the already-resolved Set, matching its
 * existing job (interruption-budget + digest I/O only).
 *
 * `lastDeliveryFile` + `sourceKey` + `title` are the sidecar the channel-veto
 * REPLY handler later reads to resolve "what did Muse just send me": on a
 * `delivered` OR `digested` outcome (never on `skipped` — nothing new reached
 * the user) the notice's `sourceKey` is appended to `last-proactive-delivery-
 * store`. `sourceKey` defaults to `source` when a caller doesn't pass one
 * (back-compat placeholder — not ledger-specific enough for a real veto, but
 * keeps the sidecar populated for callers mid-migration).
 *
 * Fail-open by design: a ledger-read error is treated as within budget (never
 * gags a delivery), and a ledger-append error after a successful deliver still
 * reports "delivered" (the send already happened) — both are logged, never
 * thrown. A digest-append failure on the suppressed path is the one accepted
 * lossy edge: the budget already said "don't send this", so falling back to
 * delivery would defeat the cap — the item is dropped and the failure is
 * logged loudly rather than silently. The last-delivery append is fail-open
 * too — a write error there must never block a real send.
 */

import {
  appendDigestItem,
  appendInterruptionDelivery,
  appendLastProactiveDelivery,
  readInterruptionLedger,
  withinInterruptionBudget,
  type InterruptionBudgetCaps
} from "@muse/stores";

import { isVetoed } from "./veto-key.js";

/** The opt-in wiring shape every gated loop's options carry. Absent → the
 *  loop's send is ungated (back-compat, byte-identical to pre-budget behavior). */
export interface InterruptionBudgetWiring {
  readonly ledgerFile: string;
  readonly digestFile: string;
  /** `<= 0` (or unset) disables that window — matches `withinInterruptionBudget`. */
  readonly hourlyCap?: number;
  readonly dailyCap?: number;
  /** Trust-ledger file a loop re-reads once per tick to resolve its avoided-
   *  source Set (channel-veto). Absent → no veto filtering (back-compat). */
  readonly trustLedgerFile?: string;
  /** Sidecar recording each notice's most recent delivered/digested outcome,
   *  read later by the channel-veto reply handler. Absent → not tracked. */
  readonly lastDeliveryFile?: string;
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
  /** Learned-avoidance set (trust-ledger `vetoed` sources) resolved by the
   *  caller. A match here short-circuits BEFORE the budget lookup: no send,
   *  no digest, `{outcome: "skipped"}`. */
  readonly avoidedSources?: ReadonlySet<string>;
  /** When set, a `delivered` or `digested` outcome appends to the
   *  last-proactive-delivery sidecar (`packages/stores`). */
  readonly lastDeliveryFile?: string;
  /** The ledger-compatible avoidance unit (`${kind}:${id}`) checked against
   *  `avoidedSources` and recorded to `lastDeliveryFile`. Defaults to
   *  `source` when unset — callers with a real per-notice id should pass one. */
  readonly sourceKey?: string;
  /** Human label recorded alongside the last-delivery entry, for a later
   *  veto confirmation message. */
  readonly title?: string;
}

export interface ApplyInterruptionBudgetResult {
  readonly outcome: "delivered" | "digested" | "skipped";
}

/**
 * Consult the avoided-source set, then the ledger: vetoed → skip entirely
 * (no send, no digest); within budget → deliver then record the delivery;
 * over budget → queue to the digest (never deliver). A throw from `deliver`
 * propagates to the caller uncaught.
 */
export async function applyInterruptionBudget(
  options: ApplyInterruptionBudgetOptions
): Promise<ApplyInterruptionBudgetResult> {
  const key = options.sourceKey ?? options.source;

  if (isVetoed(options.avoidedSources, key)) {
    return { outcome: "skipped" };
  }

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
    await recordLastDelivery(options, key, "delivered");
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
  await recordLastDelivery(options, key, "digested");
  return { outcome: "digested" };
}

async function recordLastDelivery(
  options: ApplyInterruptionBudgetOptions,
  key: string,
  outcome: "delivered" | "digested"
): Promise<void> {
  if (!options.lastDeliveryFile) return;
  try {
    await appendLastProactiveDelivery(options.lastDeliveryFile, {
      at: options.now,
      outcome,
      sourceKey: key,
      ...(options.title !== undefined ? { title: options.title } : {})
    });
  } catch (cause) {
    options.errorLogger?.(`interruption-budget: last-delivery append failed: ${describe(cause)}`);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
