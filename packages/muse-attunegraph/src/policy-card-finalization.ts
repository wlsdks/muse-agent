import { Buffer } from "node:buffer";

export const ATTUNEGRAPH_POLICY_CARD_MAX_BYTES = 64 * 1024;

export type AttuneGraphPolicyCardBudgetSettlement<T> =
  | Readonly<{
      readonly status: "accepted";
      readonly value: T;
    }>
  | Readonly<{
      readonly status: "budget-exceeded";
    }>;

/**
 * Settle the final serialized-card byte budget before completing the result.
 *
 * This is an internal deterministic boundary, not a runtime extension hook.
 * It intentionally does not catch finalizer failures: the Policy Card
 * compiler's total public boundary owns unexpected-error reduction.
 */
export function settleAttuneGraphPolicyCardBudget<T>(
  serializedCard: string,
  finalize: () => T
): AttuneGraphPolicyCardBudgetSettlement<T> {
  if (
    Buffer.byteLength(serializedCard, "utf8")
      > ATTUNEGRAPH_POLICY_CARD_MAX_BYTES
  ) {
    return Object.freeze({ status: "budget-exceeded" as const });
  }
  return Object.freeze({
    status: "accepted" as const,
    value: finalize()
  });
}
