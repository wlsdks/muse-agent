import {
  createUnverifiedDeliverySafetyResult,
  isDeliverySafetyResult,
  type DeliverySafetyResult
} from "@muse/runtime-state";

export type DeliverySafetySupplier =
  () => DeliverySafetyResult | Promise<DeliverySafetyResult>;

/** Resolve one route-local snapshot without exposing supplier diagnostics. */
export async function resolveDeliverySafety(
  supplier: DeliverySafetySupplier | undefined
): Promise<DeliverySafetyResult> {
  if (!supplier) return createUnverifiedDeliverySafetyResult();
  try {
    const result = await supplier();
    return isDeliverySafetyResult(result)
      ? result
      : createUnverifiedDeliverySafetyResult();
  } catch {
    return createUnverifiedDeliverySafetyResult();
  }
}
